import * as NodeFs from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createFaceCheck, type FaceRun } from "./faceCheck.ts";

const setup = (results: Array<{ ok: boolean; reason: string; faces?: number; per?: number[] }>) => {
  const dir = NodeFs.mkdtempSync(NodePath.join(NodeOs.tmpdir(), "face-"));
  const exe = NodePath.join(dir, "faceid.exe");
  NodeFs.writeFileSync(exe, "");
  const calls: string[][] = [];
  let on = true;
  const run: FaceRun = async (args) => {
    calls.push([...args]);
    if (args[0] === "enroll") NodeFs.writeFileSync(args[2]!, "sealed");
    const r = results.shift() ?? { ok: true, reason: "ok" };
    return { type: "result", ok: r.ok, reason: r.reason, faces: r.faces ?? 1, perTemplate: r.per ?? [], wallMs: 1 };
  };
  let clock = 1_000;
  const face = createFaceCheck({
    stateDir: dir,
    platform: "win32",
    exe,
    on: () => on,
    run,
    now: () => clock,
  });
  return { face, calls, off: () => (on = false), tick: (ms: number) => (clock += ms) };
};

describe("createFaceCheck", () => {
  it("records consent with the template, and deleting removes both even with the check off", async () => {
    const t = setup([{ ok: true, reason: "ok" }]);
    expect(await t.face.enrol({ id: "sara", name: "Sara" })).toBe(true);
    expect(t.face.enrolled().map((e) => e.member)).toEqual(["sara"]);
    t.off();
    await t.face.remove("sara");
    expect(t.face.enrolled()).toEqual([]);
    expect(t.calls.at(-1)?.[0]).toBe("delete");
  });

  it("a failed enrolment keeps no consent", async () => {
    const t = setup([{ ok: false, reason: "multiple_faces" }]);
    expect(await t.face.enrol({ id: "sara", name: "Sara" })).toBe(false);
    expect(t.face.enrolled()).toEqual([]);
  });

  it("proves the member it was asked about, requiring their template index", async () => {
    const t = setup([{ ok: true, reason: "ok" }, { ok: true, reason: "ok" }, { ok: true, reason: "ok", per: [0.2, 0.8] }]);
    await t.face.enrol({ id: "owner", name: "You" });
    await t.face.enrol({ id: "sara", name: "Sara" });
    const r = await t.face.prove("sara");
    expect(r).toMatchObject({ modality: "face", member: "sara", live: true });
    expect(t.calls.at(-1)?.slice(0, 3)).toEqual(["verify", "--require", "1"]);
  });

  it("rests after three failed proofs and does not open the camera while resting", async () => {
    const t = setup([{ ok: true, reason: "ok" }, ...Array(3).fill({ ok: false, reason: "challenge" })]);
    await t.face.enrol({ id: "owner", name: "You" });
    for (let i = 0; i < 3; i++) await t.face.prove("owner");
    const before = t.calls.length;
    expect(await t.face.prove("owner")).toBeNull();
    expect(t.calls.length).toBe(before);
    t.tick(5 * 60_000);
    await t.face.prove("owner");
    expect(t.calls.length).toBe(before + 1);
  });

  it("never opens the camera with the setting off", async () => {
    const t = setup([]);
    t.off();
    expect(await t.face.scan()).toBeNull();
    expect(t.calls).toEqual([]);
  });

  it("a passive scan reports a second person in view", async () => {
    const t = setup([{ ok: true, reason: "ok" }, { ok: false, reason: "multiple_faces", faces: 2, per: [0.7] }]);
    await t.face.enrol({ id: "owner", name: "You" });
    expect(await t.face.scan()).toMatchObject({ others: 1, live: false });
  });
});

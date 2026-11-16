// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { biometricAssurance } from "@t3tools/tessaya-shared/biometrics";

import { ANNOUNCE_AGAIN_MS, createFaceCheck, type FaceRun } from "./faceCheck.ts";

const setup = (
  results: Array<{ ok: boolean; reason: string; faces?: number; per?: number[] }>,
  modality: "face" | "palm" = "face",
) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "face-"));
  const exe = NodePath.join(dir, "faceid.exe");
  NodeFS.writeFileSync(exe, "");
  const calls: string[][] = [];
  const said: number[] = [];
  const camera: boolean[] = [];
  let on = true;
  let release: (() => void) | null = null;
  let held = false;
  const run: FaceRun = async (args) => {
    calls.push([...args]);
    if (args[0]?.endsWith("enroll")) NodeFS.writeFileSync(args[2]!, "sealed");
    const r = results.shift() ?? { ok: true, reason: "ok" };
    return {
      type: "result",
      ok: r.ok,
      reason: r.reason,
      faces: r.faces ?? 1,
      perTemplate: r.per ?? [],
      wallMs: 1,
    };
  };
  let clock = 1_000;
  const face = createFaceCheck({
    stateDir: dir,
    platform: "win32",
    exe,
    on: () => on,
    run,
    now: () => clock,
    modality,
    announce: () => {
      said.push(calls.length);
      return held ? new Promise<void>((r) => (release = r)) : Promise.resolve();
    },
    onCamera: (open) => camera.push(open),
  });
  return {
    face,
    calls,
    said,
    camera,
    hold: () => (held = true),
    release: () => release?.(),
    off: () => (on = false),
    tick: (ms: number) => (clock += ms),
  };
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
    const t = setup([
      { ok: true, reason: "ok" },
      { ok: true, reason: "ok" },
      { ok: true, reason: "ok", per: [0.2, 0.8] },
    ]);
    await t.face.enrol({ id: "owner", name: "You" });
    await t.face.enrol({ id: "sara", name: "Sara" });
    const r = await t.face.prove("sara");
    expect(r).toMatchObject({ modality: "face", member: "sara", live: true });
    expect(t.calls.at(-1)?.slice(0, 3)).toEqual(["verify", "--require", "1"]);
  });

  it("rests after three failed proofs and does not open the camera while resting", async () => {
    const t = setup([
      { ok: true, reason: "ok" },
      ...Array.from({ length: 3 }, () => ({ ok: false, reason: "challenge" })),
    ]);
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
    const t = setup([
      { ok: true, reason: "ok" },
      { ok: false, reason: "multiple_faces", faces: 2, per: [0.7] },
    ]);
    await t.face.enrol({ id: "owner", name: "You" });
    expect(await t.face.scan()).toMatchObject({ others: 1, live: false });
  });

  it("says the camera is on before it opens, shows it while open, and once for a watch's run of scans", async () => {
    const t = setup([]);
    t.hold();
    const enrolled = t.face.enrol({ id: "owner", name: "You" });
    await Promise.resolve();
    expect(t.said).toEqual([0]);
    expect(t.calls).toEqual([]);
    t.release();
    await enrolled;
    expect(t.calls[0]?.[0]).toBe("enroll");
    expect(t.camera).toEqual([true, false]);
    t.tick(5_000);
    await t.face.scan();
    expect(t.said).toEqual([0]);
    t.tick(ANNOUNCE_AGAIN_MS + 1);
    const later = t.face.scan();
    await Promise.resolve();
    expect(t.said).toEqual([0, 2]);
    expect(t.calls.length).toBe(2);
    t.release();
    await later;
    expect(t.calls.length).toBe(3);
  });

  it("deleting a template opens no camera and says nothing", async () => {
    const t = setup([]);
    await t.face.enrol({ id: "owner", name: "You" });
    await t.face.remove("owner");
    expect(t.said).toEqual([0]);
  });

  it("palm runs the engine's palm commands with the screen flash, in its own store", async () => {
    const t = setup(
      [
        { ok: true, reason: "ok" },
        { ok: true, reason: "ok", per: [12.4] },
      ],
      "palm",
    );
    await t.face.enrol({ id: "owner", name: "You" });
    expect(t.calls[0]?.[0]).toBe("palm-enroll");
    expect(t.calls[0]?.[2]).toContain(`${NodePath.sep}palm${NodePath.sep}`);
    const palm = await t.face.prove("owner");
    expect(t.calls.at(-1)?.slice(0, 4)).toEqual(["palm-verify", "--flash", "--require", "0"]);
    expect(palm).toMatchObject({ modality: "palm", member: "owner", live: true, others: 0 });
    expect(biometricAssurance([palm!], "owner")).toBe(1);
    const face = { modality: "face", member: "owner", live: true, others: 0 } as const;
    expect(biometricAssurance([face, palm!], "owner")).toBe(2);
  });
});

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import { personId } from "./speakerEnrolment.ts";
import { createVoiceId } from "./voiceId.ts";
import {
  parseVoiceIdSettings,
  VOICE_ID_DEFAULTS,
  voiceIdControls,
  type VoiceIdView,
} from "./voiceIdRows.ts";

/** A read of `lines` sentences: 5 s of voice each, then a pause. */
const loud = (lines: number) => {
  const one = Int16Array.from({ length: 5.8 * 16_000 }, (_, i) =>
    i < 5 * 16_000 ? Math.round(3000 * Math.sin(i / 7)) : 0,
  );
  // A second of quiet first: he looks at the card before he starts.
  const all = new Int16Array(16_000 + one.length * lines);
  for (let i = 0; i < lines; i += 1) all.set(one, 16_000 + i * one.length);
  return all;
};

const setup = () => {
  const stateDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "voiceid-"));
  let settings = { ...VOICE_ID_DEFAULTS, on: true, wisprSeed: false };
  const changed = vi.fn();
  const deleted: string[] = [];
  const close = vi.fn();
  const voiceId = createVoiceId({
    stateDir,
    ownerName: () => "You",
    settings: () => settings,
    ensureModel: async () => "/models/campplus.onnx",
    openModel: async () => ({
      model: "m",
      embed: async (pcm) => Float32Array.from([1, (pcm.length % 7) / 100, 0]),
      close,
    }),
    model: "m",
    appData: undefined,
    onChange: changed,
    onPersonDeleted: (id) => deleted.push(id),
  });
  return {
    voiceId,
    deleted,
    close,
    set: (next: Partial<typeof settings>) => (settings = { ...settings, ...next }),
    /** Feeds a read in 20 ms frames, as the microphone does, and waits for the profile. */
    read: async (pcm: Int16Array) => {
      for (let at = 0; at < pcm.length; at += 320) voiceId.push(pcm.subarray(at, at + 320));
      await voiceId.settled();
    },
    [Symbol.dispose]: () => NodeFS.rmSync(stateDir, { recursive: true, force: true }),
  };
};

describe("Voice ID enrolment", () => {
  it("makes his profile from what he reads, and a saved person's with their consent", async () => {
    using t = setup();
    t.voiceId.sync();
    await t.voiceId.settled();
    t.voiceId.read({ kind: "owner" });
    expect(t.voiceId.view(true).enrol?.lines).toHaveLength(6);
    expect(t.voiceId.reading()).toBe(true);
    await t.read(loud(6));
    expect(t.voiceId.profiles()).toMatchObject([
      { id: "owner", kind: "owner", sources: ["spoken"] },
    ]);
    expect(t.voiceId.reading()).toBe(false);
    expect(t.voiceId.view(true).enrol).toMatchObject({
      phase: "done",
      summary: { headline: "Your voice profile is ready" },
    });
    t.voiceId.card("close");
    expect(t.voiceId.view(true).enrol).toBeNull();

    t.voiceId.read({ kind: "saved", name: "Sarah" });
    await t.read(loud(3));
    const sarah = t.voiceId.profiles().find((p) => p.kind === "saved");
    expect(sarah).toMatchObject({ id: "sarah", name: "Sarah" });
    expect(sarah?.consentNote).toContain("Sarah agreed aloud");

    t.voiceId.remove("sarah");
    expect(t.deleted).toEqual(["sarah"]);
    expect(t.voiceId.profiles().map((p) => p.id)).toEqual(["owner"]);

    // A household member's voice is saved under their member id, so the verdict names the member.
    t.voiceId.card("close");
    t.voiceId.read({ kind: "saved", name: "Maya", id: "maya-3f2a" });
    await t.read(loud(3));
    expect(t.voiceId.profiles().map((p) => p.id)).toEqual(["owner", "maya-3f2a"]);
  });

  it("saves nothing from a read of silence", async () => {
    using t = setup();
    t.voiceId.sync();
    await t.voiceId.settled();
    t.voiceId.read({ kind: "saved", name: "Sam" });
    await t.read(new Int16Array(20 * 16_000));
    expect(t.voiceId.profiles()).toEqual([]);
    // Silence reads no sentence: the card still waits on the first.
    expect(t.voiceId.view(true).enrol?.lines.map((l) => l.state)).toEqual(["now", "todo", "todo"]);
  });

  it("closes the model when Voice ID is turned off", async () => {
    using t = setup();
    t.voiceId.sync();
    await t.voiceId.settled();
    t.set({ on: false });
    t.voiceId.sync();
    expect(t.close).toHaveBeenCalled();
    expect(t.voiceId.embedder()).toBeNull();
  });
});

it("gives each saved person an id of their own, never the owner's", () => {
  expect(personId("Sarah Jo", [])).toBe("sarah-jo");
  expect(personId("Sarah", ["sarah"])).toBe("sarah-2");
  expect(personId("Owner", [])).toBe("owner-2");
  expect(personId("!!", [])).toBe("person");
});

describe("Voice ID settings", () => {
  it("starts at the plan's defaults, and keeps each saved switch on its own", () => {
    expect(parseVoiceIdSettings(undefined)).toEqual(VOICE_ID_DEFAULTS);
    expect(VOICE_ID_DEFAULTS).toMatchObject({
      respondToOthers: false,
      offSilencesSaved: false,
      savedBarge: false,
      voiceYes: true,
      savedMessages: true,
      adapt: true,
      wisprSeed: true,
      strictWhenUnavailable: false,
    });
    expect(parseVoiceIdSettings({ on: true, adapt: "yes" })).toEqual({
      ...VOICE_ID_DEFAULTS,
      on: true,
    });
  });

  const view = (over: Partial<VoiceIdView>): VoiceIdView => ({
    settings: { ...VOICE_ID_DEFAULTS, on: true },
    profiles: [],
    model: "m",
    modelState: "ready",
    enrol: null,
    note: null,
    listening: true,
    ...over,
  });
  const owner = {
    id: "owner",
    name: "You",
    kind: "owner" as const,
    centroid: new Float32Array([1]),
    samples: 54,
    sources: ["wispr", "spoken"] as const,
    enrolledAt: "2026-11-08T12:00:00Z",
  };
  const status = (v: VoiceIdView) => voiceIdControls(v).find((c) => c.id === "vid.status");

  it("asks for re-enrolling when his profile was made by another model", () => {
    expect(status(view({ profiles: [{ ...owner, model: "old" }] }))).toMatchObject({
      label: "Voice ID needs re-enrolling after a model change",
    });
    const rows = voiceIdControls(view({ profiles: [{ ...owner, model: "m" }] }));
    expect(rows.find((c) => c.id === "vid.enrol")).toMatchObject({
      button: "Re-enrol",
      secondary: "Delete",
    });
  });

  it("cannot start a read while the microphone is closed", () => {
    expect(
      voiceIdControls(view({ listening: false })).find((c) => c.id === "vid.enrol"),
    ).toMatchObject({ disabled: true });
  });
});

import { describe, expect, it } from "vite-plus/test";

import {
  BIOMETRIC_LIMIT_START,
  biometricAllowed,
  biometricAssurance,
  type BiometricReading,
  faceReading,
  parseFaceEngineLine,
  recordBiometricAttempt,
  shoulderSurf,
  walkedAway,
} from "./biometrics.ts";

const face = (member: string | null, live = true, others = 0): BiometricReading => ({
  modality: "face",
  member,
  live,
  others,
});
const voice = (member: string | null, live = true): BiometricReading => ({
  modality: "voice",
  member,
  live,
  others: 0,
});
const palm = (member: string | null): BiometricReading => ({
  modality: "palm",
  member,
  live: true,
  others: 0,
});

describe("biometricAssurance", () => {
  it.each([
    ["face alone is A1", [face("owner")], 1],
    ["a face that failed liveness proves nothing", [face("owner", false)], 0],
    ["voice at act alone is A2", [voice("owner")], 2],
    ["face with voice at act is A2, never A3", [face("owner"), voice("owner")], 2],
    ["face with palm, two kinds agreeing, is A2", [face("owner"), palm("owner")], 2],
    ["two faces of him are still one kind: A1", [face("owner"), face("owner")], 1],
    ["face of someone else is nothing for him", [face("sara")], 0],
    ["a live face of someone else cuts his voice to A1", [voice("owner"), face("sara")], 1],
    ["an unknown face does not contradict", [voice("owner"), face(null)], 2],
  ] as const)("%s", (_name, readings, level) => {
    expect(biometricAssurance(readings, "owner")).toBe(level);
  });
});

describe("narrowing signals", () => {
  it("a second face is a shoulder-surf; a scan of one face is not", () => {
    expect(shoulderSurf(face("owner", true, 1))).toBe(true);
    expect(shoulderSurf(face("owner"))).toBe(false);
    expect(shoulderSurf(null)).toBe(false);
  });
  it("walked away only after the gap since he was last seen", () => {
    expect(walkedAway(null, 50_000)).toBe(false);
    expect(walkedAway(40_001, 50_000)).toBe(false);
    expect(walkedAway(40_000, 50_000)).toBe(true);
  });
});

describe("rate limit", () => {
  it("rests 5 minutes after 3 failures in a row, a success resets the run", () => {
    let s = BIOMETRIC_LIMIT_START;
    s = recordBiometricAttempt(s, false, 0);
    s = recordBiometricAttempt(s, false, 1);
    s = recordBiometricAttempt(s, true, 2);
    s = recordBiometricAttempt(s, false, 3);
    expect(biometricAllowed(s, 4)).toBe(true);
    s = recordBiometricAttempt(s, false, 4);
    s = recordBiometricAttempt(s, false, 5);
    expect(biometricAllowed(s, 6)).toBe(false);
    expect(biometricAllowed(s, 5 + 5 * 60_000)).toBe(true);
  });
  it("turns off after 10 failures in 24 hours and stays off", () => {
    let s = BIOMETRIC_LIMIT_START;
    for (let i = 0; i < 10; i++) s = recordBiometricAttempt(s, false, i * 3_600_000);
    expect(s.off).toBe(true);
    expect(biometricAllowed(s, 100 * 86_400_000)).toBe(false);
  });
  it("failures older than a day do not count toward turning off", () => {
    let s = BIOMETRIC_LIMIT_START;
    for (let i = 0; i < 9; i++) s = recordBiometricAttempt(s, i % 2 === 0, i * 60_000);
    for (let i = 0; i < 9; i++) s = recordBiometricAttempt(s, false, 2 * 86_400_000 + i * 600_000);
    expect(s.off).toBe(false);
  });
});

describe("face engine sidecar", () => {
  it("parses progress and result lines and ignores the rest", () => {
    expect(parseFaceEngineLine('{"type":"progress","message":"Look at the camera"}')).toEqual({
      type: "progress",
      message: "Look at the camera",
    });
    expect(
      parseFaceEngineLine(
        '{"type":"result","wall_ms":1830,"ok":false,"reason":"multiple_faces","faces":2,"pad_median":0.9,"per_template":[0.71,0.12]}',
      ),
    ).toEqual({
      type: "result",
      ok: false,
      reason: "multiple_faces",
      faces: 2,
      perTemplate: [0.71, 0.12],
      wallMs: 1830,
    });
    expect(parseFaceEngineLine("not json")).toBeNull();
    expect(parseFaceEngineLine('{"type":"devices","devices":[]}')).toBeNull();
  });
  it("names the one member over the bar, nobody when two are, and counts the others in view", () => {
    const r = (per: number[], faces = 1) =>
      ({ type: "result", ok: true, reason: "ok", faces, perTemplate: per, wallMs: 0 }) as const;
    expect(faceReading(r([0.72, 0.2]), ["owner", "sara"], true)).toEqual(face("owner"));
    expect(faceReading(r([0.72, 0.61]), ["owner", "sara"], true).member).toBeNull();
    expect(faceReading(r([0.72, 0.2], 2), ["owner", "sara"], true)).toEqual(
      face("owner", false, 1),
    );
  });
});

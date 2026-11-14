import { describe, expect, it } from "vite-plus/test";

import { runChecks, type CheckInput } from "./selfChecks.ts";

const good: CheckInput = {
  mic: { devices: 1, using: "Desk mic", listening: true, trouble: null },
  micPeak: 0.4,
  wake: { enabled: ["hey baton"], missing: [], coreLoaded: true, baseModelsMissing: 0 },
  speech: { present: true, label: "Parakeet Fast", sizeMb: 229 },
  signIn: { claude: { state: "ready" }, codex: { state: "missing" } },
  screenAccess: "granted",
  disk: { freeMb: 50_000, neededMb: 229 },
};
const byId = (input: CheckInput) => Object.fromEntries(runChecks(input).map((c) => [c.id, c]));

describe("self checks", () => {
  it("passes a healthy machine, with a fix only on what is not ok", () => {
    const r = byId(good);
    expect(
      ["mic", "level", "wake", "speech", "claude", "screen", "disk"].every(
        (id) => r[id]!.status === "ok",
      ),
    ).toBe(true);
    expect(r["codex"]).toMatchObject({
      status: "warn",
      fix: expect.stringContaining("Install Codex"),
    });
    expect(Object.values(r).every((c) => (c.status === "ok") === (c.fix === undefined))).toBe(true);
  });
  it("says what is wrong with the microphone", () => {
    expect(byId({ ...good, mic: { ...good.mic, devices: 0 } })["mic"]!.status).toBe("bad");
    expect(byId({ ...good, micPeak: 0.01 })["level"]!.status).toBe("bad");
    expect(
      byId({ ...good, micPeak: null, mic: { ...good.mic, listening: false } })["level"]!.fix,
    ).toContain("Turn on");
  });
  it("tells a missing word model from missing base models", () => {
    expect(
      byId({ ...good, wake: { ...good.wake, missing: ["jarvis"] } })["wake"]!.detail,
    ).toContain("jarvis");
    expect(byId({ ...good, wake: { ...good.wake, baseModelsMissing: 2 } })["wake"]!.fix).toBe(
      "Reinstall Tessaya.",
    );
  });
  it("flags a denied screen permission and a full disk", () => {
    expect(byId({ ...good, screenAccess: "denied" })["screen"]!.status).toBe("bad");
    expect(byId({ ...good, disk: { freeMb: 800, neededMb: 229 } })["disk"]!.status).toBe("bad");
  });
});

import { expect, it } from "vite-plus/test";

import { realDeviceActivity } from "./mqtt.ts";

it("tells a replay when a real R1 may be in use, and ignores the replay's own traffic", () => {
  // Plugged in but silent is not in use: only what he does on it counts.
  expect(realDeviceActivity("freya/r1/r1-3d57b3/state/online", "1", "replay-1")).toBeNull();
  expect(realDeviceActivity("freya/r1/r1-3d57b3/state/online", "0", "replay-1")).toBeNull();
  expect(realDeviceActivity("freya/r1/r1-3d57b3/voice/up", "", "replay-1")).toBe(
    "r1-3d57b3 sent voice/up",
  );
  expect(realDeviceActivity("freya/r1/r1-3d57b3/event/button", "{}", "replay-1")).toBe(
    "r1-3d57b3 sent event/button",
  );
  expect(realDeviceActivity("freya/r1/replay-1/event/voice/metrics", "{}", "replay-1")).toBeNull();
  expect(realDeviceActivity("freya/r1/r1-3d57b3/state/battery", "80", "replay-1")).toBeNull();
});

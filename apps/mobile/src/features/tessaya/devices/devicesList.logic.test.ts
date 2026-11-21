import type { RegisteredDevice } from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import { deviceRows } from "./devicesList.logic";

const device = (deviceId: string, extra: Partial<RegisteredDevice>): RegisteredDevice => ({
  deviceId,
  kind: "r1",
  name: deviceId,
  firmware: null,
  via: "mqtt",
  online: true,
  lastSeenAt: null,
  version: null,
  items: [],
  values: [],
  ...extra,
});

describe("the Devices list", () => {
  it("puts Tessels first, then this phone, and leaves out the stale", () => {
    const rows = deviceRows(
      [
        device("laptop", { kind: "desktop", via: "client", name: "Your laptop" }),
        device("phone-b", { kind: "phone", via: "client", name: "Pixel" }),
        device("phone-a", { kind: "phone", via: "client", name: "Xperia" }),
        device("tumble", { name: "Tumble", online: false }),
        device("old", { stale: true }),
      ],
      "phone-a",
    );
    expect(rows.map((r) => `${r.name}: ${r.line}`)).toEqual([
      "Tumble: Tessel · off",
      "This phone: Phone · this phone",
      "Pixel: Phone · on",
      "Your laptop: Desk body · on",
    ]);
  });
});

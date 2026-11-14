import { describe, expect, it } from "vite-plus/test";

import { parseHello, windowsHello } from "./hello.ts";

describe("Windows Hello gate", () => {
  it("reads the verifier's answer", async () => {
    expect(parseHello("Verified\r\n")).toBe("verified");
    expect(parseHello("Canceled")).toBe("declined");
    expect(parseHello("DeviceNotPresent")).toBe("unavailable");
    expect(parseHello("")).toBe("declined");
    expect(await windowsHello("Unlock", "win32", async () => "Verified")).toBe("verified");
    expect(await windowsHello("Unlock", "linux", async () => "Verified")).toBe("unavailable");
  });
});

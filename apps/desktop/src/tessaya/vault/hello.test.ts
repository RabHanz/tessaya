import { describe, expect, it } from "vite-plus/test";

import { createHello, parseHello, windowsHello } from "./hello.ts";

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

describe("a warm Windows Hello helper", () => {
  const fake = () => {
    const spawned: Array<{ asked: Array<string>; stopped: boolean }> = [];
    const spawn = () => {
      const h = { asked: [] as Array<string>, stopped: false };
      spawned.push(h);
      let answer: (out: string) => void = () => undefined;
      return {
        ask: (m: string) => (h.asked.push(m), answer("Verified\r\n")),
        output: new Promise<string>((resolve) => (answer = resolve)),
        stop: () => void (h.stopped = true),
      };
    };
    return { spawned, spawn };
  };

  it("uses the helper started early for the next prompt, and starts one cold only when none waits", async () => {
    const f = fake();
    const hello = createHello("win32", f.spawn);
    hello.warm();
    hello.warm();
    expect(f.spawned).toHaveLength(1);
    expect(parseHello(await hello.ask("Open\nit"))).toBe("verified");
    expect(f.spawned).toHaveLength(1);
    expect(f.spawned[0]!.asked).toEqual(["Open\nit"]);
    await hello.ask("again");
    expect(f.spawned).toHaveLength(2);
  });

  it("stops a waiting helper on cool, and never starts one off Windows", () => {
    const f = fake();
    const hello = createHello("win32", f.spawn);
    hello.warm();
    hello.cool();
    expect(f.spawned[0]!.stopped).toBe(true);
    createHello("linux", f.spawn).warm();
    expect(f.spawned).toHaveLength(1);
  });
});

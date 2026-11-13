import { describe, expect, it } from "vite-plus/test";

import { parsePairingQr, R1_SETUP_CHARS, runR1Setup, statusOutcome } from "./r1Setup.ts";

describe("setting up an R1", () => {
  it("reads the pairing QR and refuses anything else", () => {
    expect(parsePairingQr("T3R1:R1-A1B2C3:000102030405060708090a0b0c0d0e0f")).toEqual({
      deviceId: "r1-a1b2c3",
      oneTimeKey: "000102030405060708090A0B0C0D0E0F",
    });
    expect(parsePairingQr("T3R1:R1-A1B2C3:0001")).toBeNull();
    expect(parsePairingQr("WIFI:S:R1-1A2B;T:WPA;P:12345678;;")).toBeNull();
  });

  it("writes Wi-Fi, the claim, then join, reading the status after each notify", async () => {
    const writes: Array<[string, string]> = [];
    let notify = () => {};
    let status = "";
    const r1 = (onJoin: Array<string>) => ({
      write: async (c: string, v: Uint8Array) => {
        writes.push([c, new TextDecoder().decode(v)]);
        if (c === R1_SETUP_CHARS.join)
          for (const s of onJoin) {
            status = s;
            notify();
          }
      },
      read: async () => new TextEncoder().encode(status),
      watch: async (_c: string, onNotify: () => void) => {
        notify = onNotify;
        return () => {};
      },
    });
    const run = async (onJoin: Array<string>) => {
      const steps: Array<[string, string]> = [];
      const ok = await runR1Setup({
        port: r1(onJoin),
        ssid: "Home",
        pass: "secret",
        claim: async () => "BLOB",
        onStep: (s, why) => steps.push([s, why]),
        timeout: new Promise(() => {}),
      });
      return { ok, last: steps.at(-1) };
    };
    expect(
      await run(['{"op":"join","state":"joining"}', '{"op":"join","state":"done","ok":true}']),
    ).toEqual({ ok: true, last: ["online", ""] });
    expect(writes.slice(0, 4)).toEqual([
      [R1_SETUP_CHARS.ssid, "Home"],
      [R1_SETUP_CHARS.pass, "secret"],
      [R1_SETUP_CHARS.claim, "BLOB"],
      [R1_SETUP_CHARS.join, "1"],
    ]);
    expect(await run(['{"op":"join","state":"badpass"}'])).toEqual({
      ok: false,
      last: ["failed", "That Wi-Fi password didn't work."],
    });
    expect(statusOutcome({ op: "claim", state: "done" })).toBeNull();
    expect(statusOutcome({ op: "claim", state: "fail" })).toMatchObject({ ok: false });
  });
});

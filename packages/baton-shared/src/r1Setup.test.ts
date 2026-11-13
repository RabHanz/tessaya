// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import {
  blePasskey,
  hmacSha256,
  parsePairingQr,
  R1_SETUP_CHARS,
  runR1Setup,
  sha256,
  statusState,
} from "./r1Setup.ts";

describe("setting up an R1", () => {
  it("reads the pairing QR and refuses anything else", () => {
    expect(parsePairingQr("T3R1:R1-A1B2C3:000102030405060708090a0b0c0d0e0f")).toEqual({
      deviceId: "r1-a1b2c3",
      oneTimeKey: "000102030405060708090A0B0C0D0E0F",
    });
    expect(parsePairingQr("T3R1:R1-A1B2C3:0001")).toBeNull();
    expect(parsePairingQr("WIFI:S:R1-1A2B;T:WPA;P:12345678;;")).toBeNull();
  });

  it("hashes as node does, and gives the firmware's passkey for the shared vector", () => {
    for (const len of [0, 3, 55, 56, 64, 200]) {
      const data = NodeCrypto.randomBytes(len);
      expect(Buffer.from(sha256(data)).toString("hex")).toBe(
        NodeCrypto.createHash("sha256").update(data).digest("hex"),
      );
      const key = NodeCrypto.randomBytes(len % 90);
      expect(Buffer.from(hmacSha256(key, data)).toString("hex")).toBe(
        NodeCrypto.createHmac("sha256", key).update(data).digest("hex"),
      );
    }
    // R1-CONNECT-UNIVERSAL §10: the raw 16 bytes as the key.
    expect(blePasskey("000102030405060708090A0B0C0D0E0F")).toBe("975000");
  });

  it("writes Wi-Fi, the claim, then join, and finishes on the R1's online status", async () => {
    const writes: Array<[string, string]> = [];
    let push: (v: Uint8Array) => void = () => {};
    const steps: Array<string> = [];
    const ok = await runR1Setup({
      port: {
        write: async (c, v) => {
          writes.push([c, new TextDecoder().decode(v)]);
          if (c === R1_SETUP_CHARS.join) {
            push(new TextEncoder().encode('{"state":"joining"}'));
            push(new TextEncoder().encode('{"state":"online"}'));
          }
        },
        watch: async (_c, onValue) => {
          push = onValue;
          return () => {};
        },
      },
      ssid: "Home",
      pass: "secret",
      claim: async () => "BLOB",
      onStep: (s) => steps.push(s),
      timeout: new Promise(() => {}),
    });
    expect(ok).toBe(true);
    expect(writes).toEqual([
      [R1_SETUP_CHARS.ssid, "Home"],
      [R1_SETUP_CHARS.pass, "secret"],
      [R1_SETUP_CHARS.claim, "BLOB"],
      [R1_SETUP_CHARS.join, "1"],
    ]);
    expect(steps.at(-1)).toBe("online");
    expect(statusState("badpass")).toBe("failed");
    expect(statusState("scanning")).toBeNull();
  });
});

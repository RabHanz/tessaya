// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "vite-plus/test";

import {
  acceptWakeUpload,
  applyWakeStatus,
  cancelWake,
  CLAIM_LAPSE_MS,
  EMPTY_WAKE_STORE,
  rollbackWake,
  wakeModelOf,
  wakeRequests,
  wakeSignatureOk,
  type WakeStore,
} from "./wakeModels.ts";

const keys = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const sign = (data: string) =>
  NodeCrypto.sign("sha256", Buffer.from(data), keys.privateKey).toString("base64");
const pub = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const bytes = (s: string) => new TextEncoder().encode(s);
const sha = (s: string) => NodeCrypto.createHash("sha256").update(bytes(s)).digest("hex");
const ok = <T>(r: T | { readonly refused: string }): T => {
  if (typeof r === "object" && r !== null && "refused" in r) throw new Error(r.refused);
  return r as T;
};

describe("wake models for every persona (P3b)", () => {
  it("asks for a new name and a rename, skips shipped, claimed and cancelled words, and a claim lapses after 6 h", () => {
    const first = wakeRequests(
      [
        { id: "operations", wake: "Freya" },
        { id: "nova", wake: "Nova" },
      ],
      EMPTY_WAKE_STORE,
      [],
      0,
    );
    expect(first.requests.map((r) => [r.word, r.reason])).toEqual([["nova", "new"]]);
    const renamed = wakeRequests([{ id: "operations", wake: "Maya" }], first.store, [], 1);
    expect(renamed.requests).toEqual([
      {
        word: "maya",
        personaId: "operations",
        previous: "freya",
        requestedAt: 1,
        reason: "rename",
      },
    ]);
    const claimed = ok(
      applyWakeStatus(renamed.store, { word: "Maya", version: 1, status: "training" }, "k1", 10),
    ).store;
    expect(wakeModelOf("Maya", claimed, 10)).toBe("training");
    expect(wakeRequests([{ id: "operations", wake: "Maya" }], claimed, [], 20).requests).toEqual(
      [],
    );
    expect(
      applyWakeStatus(claimed, { word: "maya", version: 1, status: "training" }, "k2", 20),
    ).toEqual({
      refused: "Another trainer has this word.",
    });
    const lapsed = 10 + CLAIM_LAPSE_MS;
    expect(wakeModelOf("Maya", claimed, lapsed)).toBe("none");
    expect(
      wakeRequests([{ id: "operations", wake: "Maya" }], claimed, [], lapsed).requests,
    ).toHaveLength(1);
    const stopped = cancelWake(claimed, "maya");
    expect(wakeRequests([{ id: "operations", wake: "Maya" }], stopped, [], 30).requests).toEqual(
      [],
    );
    expect(wakeModelOf("Maya", stopped, 30)).toBe("none");
  });

  it("signs only matching bytes of a version that met its bar, makes it current when every target is in, keeps three", () => {
    let store: WakeStore = EMPTY_WAKE_STORE;
    const report = (version: number, barMet: boolean) =>
      ok(
        applyWakeStatus(
          store,
          {
            word: "nova",
            version,
            status: "trained",
            eval: { barMet },
            artifacts: [
              {
                target: "room",
                format: "openwakeword-onnx",
                sha256: sha(`room${version}`),
                threshold: 0.9,
              },
              {
                target: "desktop",
                format: "openwakeword-onnx",
                sha256: sha(`desk${version}`),
                threshold: 0.9,
              },
            ],
          },
          "k1",
          version,
        ),
      ).store;
    expect(
      applyWakeStatus(store, { word: "nova", version: 1, status: "rejected" }, "k1", 0),
    ).toEqual({
      refused: "A rejected or failed model needs a reason.",
    });
    store = report(1, false);
    expect(acceptWakeUpload(store, "nova", 1, "room", sha("room1"), sign)).toEqual({
      refused: "This version did not meet the bar.",
    });
    for (const v of [2, 3, 4]) {
      store = report(v, true);
      expect(acceptWakeUpload(store, "nova", v, "room", sha("tampered"), sign)).toEqual({
        refused: "The bytes do not match the reported sha256.",
      });
      const half = ok(acceptWakeUpload(store, "nova", v, "room", sha(`room${v}`), sign));
      expect(half.current).toBe(false);
      const whole = ok(acceptWakeUpload(half.store, "nova", v, "desktop", sha(`desk${v}`), sign));
      expect(whole.current).toBe(true);
      store = whole.store;
    }
    const nova = store.words["nova"]!;
    expect([nova.current, nova.versions.map((v) => v.version), nova.claim]).toEqual([
      4,
      [2, 3, 4],
      undefined,
    ]);
    expect(wakeModelOf("Nova", store, 5)).toBe("trained");
    const room = nova.versions.at(-1)!.artifacts[0]!;
    expect(wakeSignatureOk(pub, "nova", 4, room, bytes("room4"))).toBe(true);
    expect(wakeSignatureOk(pub, "nova", 4, room, bytes("room3"))).toBe(false);
    expect(wakeSignatureOk(pub, "nova", 3, room, bytes("room4"))).toBe(false);
    const { signature: _none, ...unsigned } = room;
    expect(wakeSignatureOk(pub, "nova", 4, unsigned, bytes("room4"))).toBe(false);
    expect(ok(rollbackWake(store, "nova", 2)).store.words["nova"]!.current).toBe(2);
    expect(rollbackWake(store, "nova", 1)).toEqual({ refused: "That version is not kept." });
  });
});

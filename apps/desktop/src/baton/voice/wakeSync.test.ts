// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { wakeSigned, type WakeWordView } from "@t3tools/baton-shared/wakeModels";
import { expect, it } from "vite-plus/test";

import { syncWakeModels } from "./wakeSync.ts";

const keys = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const pub = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
const model = new TextEncoder().encode("nova-desktop-v2");
const sha = NodeCrypto.createHash("sha256").update(model).digest("hex");
const signature = NodeCrypto.sign(
  "sha256",
  Buffer.from(wakeSigned("nova", 2, "desktop", sha)),
  keys.privateKey,
).toString("base64");

/** Her server: Nova v2 signed for the desktop, or the same headers over other bytes. */
const server = (bytes: Uint8Array<ArrayBuffer>): typeof fetch =>
  (async (url: URL) =>
    String(url).endsWith("/key")
      ? new Response(pub)
      : new Response(bytes, {
          headers: {
            "x-tessaya-wake-version": "2",
            "x-tessaya-wake-format": "openwakeword-onnx",
            "x-tessaya-wake-sha256": sha,
            "x-tessaya-wake-threshold": "0.9",
            "x-tessaya-wake-signature": signature,
          },
        })) as unknown as typeof fetch;

const nova: WakeWordView = {
  personaId: "nova",
  word: "nova",
  model: "trained",
  shipped: false,
  current: 2,
  cancelled: false,
  versions: [],
};
const at = { server: "http://her", authorization: "Bearer t" };
const mine = [{ word: "Tessaya", enabled: true, threshold: 0.99 }];

it("loads only her signed model, adds the word once, keeps his threshold, and refuses altered bytes", async () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "wake-sync-"));
  try {
    const tampered = await syncWakeModels({
      at,
      dir,
      status: [nova],
      words: mine,
      fetch: server(new TextEncoder().encode("evil")),
    });
    expect(tampered).toEqual({ words: null, reload: false, refused: ["nova"] });
    expect(NodeFS.existsSync(NodePath.join(dir, "nova.onnx"))).toBe(false);

    const first = await syncWakeModels({
      at,
      dir,
      status: [nova],
      words: mine,
      fetch: server(model),
    });
    expect(first.reload).toBe(true);
    expect(first.words).toEqual([...mine, { word: "Nova", enabled: true, threshold: 0.9 }]);
    expect(NodeFS.readFileSync(NodePath.join(dir, "nova.onnx"), "utf8")).toBe("nova-desktop-v2");

    // His own threshold for a word he has stays; the version in hand is not fetched again.
    const his = [...mine, { word: "Nova", enabled: true, threshold: 0.97 }];
    expect(
      await syncWakeModels({ at, dir, status: [nova], words: his, fetch: server(model) }),
    ).toEqual({ words: null, reload: false, refused: [] });
  } finally {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

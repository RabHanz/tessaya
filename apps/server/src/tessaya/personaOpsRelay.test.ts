// @effect-diagnostics nodeBuiltinImport:off
import { assert, it } from "@effect/vitest";
import * as NodeCrypto from "node:crypto";

import { canonicalJson, relayKeyOf, signRelay, verifyRelay } from "./personaOpsRelay.ts";

// RFC 8032's test 1 seed (PKCS8 prefix + seed), so the vector below is bytes the ops system can check on its side.
const PEM = NodeCrypto.createPrivateKey({
  key: Buffer.from(
    "302e020100300506032b6570042204209d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
    "hex",
  ),
  format: "der",
  type: "pkcs8",
}).export({ type: "pkcs8", format: "pem" }) as string;

const fields = {
  approval_id: "11111111-1111-4111-8111-111111111111",
  decision: "approve" as const,
  reason: "The Director, in his own voice on the desk, via Tessaya.",
  relayer_action_id: "01JD0000000000000000000000",
  verification: { score: 0.71, method: "voice_owner" as const },
  issued_at: "2026-11-18T09:00:00.000Z",
  nonce: "00112233445566778899aabbccddeeff",
};

it("canonical JSON sorts keys at every depth and has no whitespace", () => {
  assert.strictEqual(
    canonicalJson({ b: [{ z: 1, a: "x y" }], a: null, c: { e: true, d: 0.5 } }),
    '{"a":null,"b":[{"a":"x y","z":1}],"c":{"d":0.5,"e":true}}',
  );
});

it("signs every field but the signature, under the key's id: the vector the ops system verifies", () => {
  const key = relayKeyOf(PEM);
  assert.strictEqual(key.keyId, "tessaya-brain-06e3fd8fda29bb60");
  const relay = signRelay(key, fields);
  const { signature, ...body } = relay;
  assert.strictEqual(
    canonicalJson(body),
    '{"approval_id":"11111111-1111-4111-8111-111111111111","decision":"approve","issued_at":"2026-11-18T09:00:00.000Z","key_id":"tessaya-brain-06e3fd8fda29bb60","nonce":"00112233445566778899aabbccddeeff","reason":"The Director, in his own voice on the desk, via Tessaya.","relayer_action_id":"01JD0000000000000000000000","verification":{"method":"voice_owner","score":0.71}}',
  );
  // Ed25519 is deterministic: this key over these bytes is always this signature.
  assert.strictEqual(
    signature,
    "I3muyIfKRCBCCMu9hAN86o4aIReXGwzgJ7ewrclnugYrzR1FKU0LEDH5LL6auEpkrG6mtMElG+wIPy9YtHpYAQ==",
  );
  assert.isTrue(verifyRelay(key.publicKeyPem, relay));
  assert.isFalse(verifyRelay(key.publicKeyPem, { ...relay, decision: "reject" }));
});

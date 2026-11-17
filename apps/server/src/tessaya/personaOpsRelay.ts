// @effect-diagnostics nodeBuiltinImport:off
/**
 * The Director's decision on an ops system approval, relayed by the brain (the ops system's `approval.relay`): every field
 * but `signature`, as canonical JSON (keys sorted at every depth, no whitespace), signed with the brain's own Ed25519
 * key. The ops system checks the key is one he registered for this worker, the signature, issued_at within 5 minutes, the
 * nonce unused, and that the method and score meet that key's minimums.
 */
import * as NodeCrypto from "node:crypto";

type RelayMethod = "voice_owner" | "pin_stepup";

interface RelayFields {
  readonly approval_id: string;
  readonly decision: "approve" | "reject";
  readonly reason: string;
  readonly relayer_action_id: string;
  readonly verification: { readonly method: RelayMethod; readonly score: number };
  readonly issued_at: string;
  readonly nonce: string;
  readonly key_id: string;
}

interface SignedRelay extends RelayFields {
  readonly signature: string;
}

export const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.keys(value)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .toSorted()
      .map((k) => `${JSON.stringify(k)}:${canonicalJson((value as Record<string, unknown>)[k])}`)
      .join(",")}}`;
  return JSON.stringify(value);
};

/** The brain's relay key: its private half never leaves the secret store, its public half is what he registers. */
export interface RelayKey {
  readonly privateKey: NodeCrypto.KeyObject;
  readonly publicKeyPem: string;
  readonly keyId: string;
}

export const generateRelayKeyPem = (): string =>
  NodeCrypto.generateKeyPairSync("ed25519").privateKey.export({
    type: "pkcs8",
    format: "pem",
  }) as string;

export const relayKeyOf = (privatePem: string): RelayKey => {
  const privateKey = NodeCrypto.createPrivateKey(privatePem);
  const publicKey = NodeCrypto.createPublicKey(privateKey);
  const der = publicKey.export({ type: "spki", format: "der" });
  return {
    privateKey,
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }) as string,
    keyId: `tessaya-brain-${NodeCrypto.createHash("sha256").update(der).digest("hex").slice(0, 16)}`,
  };
};

export const signRelay = (key: RelayKey, fields: Omit<RelayFields, "key_id">): SignedRelay => {
  const body: RelayFields = { ...fields, key_id: key.keyId };
  const signature = NodeCrypto.sign(null, Buffer.from(canonicalJson(body), "utf8"), key.privateKey);
  return { ...body, signature: signature.toString("base64") };
};

export const verifyRelay = (publicKeyPem: string, relay: SignedRelay): boolean => {
  const { signature, ...body } = relay;
  return NodeCrypto.verify(
    null,
    Buffer.from(canonicalJson(body), "utf8"),
    NodeCrypto.createPublicKey(publicKeyPem),
    Buffer.from(signature, "base64"),
  );
};

export const relayNonce = (): string => NodeCrypto.randomBytes(16).toString("hex");

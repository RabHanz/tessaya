/**
 * Passkeys (WebAuthn) checked with Node's own crypto, for a member's step-up on their own device (identity I-3): a
 * registration keeps the credential's public key; an assertion proves the same device and its user (a fingerprint,
 * face or device PIN) signed this server's fresh challenge. Attestation is not checked: the key, not the maker, is
 * what is trusted, and it is registered from a session that is already theirs.
 */
// @effect-diagnostics nodeBuiltinImport:off - WebAuthn's signatures are checked with Node's own crypto (JWK keys).
import * as NodeCrypto from "node:crypto";

import * as Schema from "effect/Schema";

/** A failed check, with why in plain words. */
export class PasskeyError extends Schema.TaggedError<PasskeyError>()("PasskeyError", {
  message: Schema.String,
}) {}
function fail(message: string): never {
  throw new PasskeyError({ message });
}

/** A stored passkey's public key: the JWK Node verifies with, and its COSE algorithm. */
export type PasskeyKey = { readonly jwk: NodeCrypto.JsonWebKey; readonly alg: number };
export const keyToJson = (jwk: NodeCrypto.JsonWebKey): string => JSON.stringify(jwk);
export const keyFromJson = (text: string): NodeCrypto.JsonWebKey =>
  JSON.parse(text) as NodeCrypto.JsonWebKey;

/** The small CBOR subset WebAuthn uses (RFC 8949): integers, byte and text strings, arrays, maps, simple values. */
export const decodeCbor = (bytes: Uint8Array): unknown => {
  let at = 0;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const length = (info: number): number => {
    if (info < 24) return info;
    if (info === 24) return view.getUint8(at++);
    if (info === 25) return ((at += 2), view.getUint16(at - 2));
    if (info === 26) return ((at += 4), view.getUint32(at - 4));
    if (info === 27) return ((at += 8), Number(view.getBigUint64(at - 8)));
    fail("That passkey's data is not valid.");
  };
  const item = (): unknown => {
    if (at >= bytes.length) fail("That passkey's data is cut short.");
    const head = bytes[at++]!;
    const major = head >> 5;
    const info = head & 31;
    switch (major) {
      case 0:
        return length(info);
      case 1:
        return -1 - length(info);
      case 2: {
        const n = length(info);
        if (at + n > bytes.length) fail("That passkey's data is cut short.");
        return bytes.slice(at, (at += n));
      }
      case 3: {
        const n = length(info);
        return new TextDecoder().decode(bytes.slice(at, (at += n)));
      }
      case 4:
        return Array.from({ length: length(info) }, item);
      case 5: {
        const map = new Map<unknown, unknown>();
        for (let i = length(info); i > 0; i--) map.set(item(), item());
        return map;
      }
      case 7:
        if (info === 20) return false;
        if (info === 21) return true;
        if (info === 22) return null;
        break;
    }
    fail("That passkey's data is not valid.");
  };
  return item();
};

/** Authenticator data (WebAuthn §6.1): the relying party's hash, flags, the counter and, at registration, the key. */
export const parseAuthData = (data: Uint8Array) => {
  if (data.length < 37) fail("That passkey's data is cut short.");
  const flags = data[32]!;
  const signCount = new DataView(data.buffer, data.byteOffset + 33, 4).getUint32(0);
  let credential: { readonly id: Uint8Array; readonly publicKey: Map<unknown, unknown> } | null =
    null;
  if ((flags & 0x40) !== 0) {
    const idLength = (data[53]! << 8) | data[54]!;
    const id = data.slice(55, 55 + idLength);
    const key = decodeCbor(data.slice(55 + idLength));
    if (!(key instanceof Map)) fail("That passkey has no public key.");
    credential = { id, publicKey: key };
  }
  return {
    rpIdHash: data.slice(0, 32),
    userPresent: (flags & 0x01) !== 0,
    userVerified: (flags & 0x04) !== 0,
    signCount,
    credential,
  };
};

const b64u = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

/** A COSE public key as a JWK Node can verify with: ES256 (P-256), EdDSA (Ed25519) or RS256. */
export const coseToJwk = (
  cose: Map<unknown, unknown>,
): { jwk: NodeCrypto.JsonWebKey; alg: number } => {
  const kty = cose.get(1);
  const alg = cose.get(3);
  const bytes = (label: number) => {
    const v = cose.get(label);
    if (!(v instanceof Uint8Array)) fail("That passkey's key is not valid.");
    return b64u(v);
  };
  if (kty === 2 && alg === -7 && cose.get(-1) === 1)
    return { jwk: { kty: "EC", crv: "P-256", x: bytes(-2), y: bytes(-3) }, alg };
  if (kty === 1 && alg === -8 && cose.get(-1) === 6)
    return { jwk: { kty: "OKP", crv: "Ed25519", x: bytes(-2) }, alg };
  if (kty === 3 && alg === -257) return { jwk: { kty: "RSA", n: bytes(-1), e: bytes(-2) }, alg };
  fail("That kind of passkey isn't supported here.");
};

interface ClientData {
  readonly type: string;
  readonly challenge: string;
  readonly origin: string;
}

/** The browser's own record of the ceremony: its type, our challenge and the page's origin must all match. */
const checkClientData = (
  json: Uint8Array,
  expected: { readonly type: string; readonly challenge: string; readonly origin: string },
): void => {
  let data: ClientData;
  try {
    data = JSON.parse(new TextDecoder().decode(json)) as ClientData;
  } catch {
    fail("That passkey's answer is not valid.");
  }
  if (data.type !== expected.type) fail("That passkey's answer is for something else.");
  if (data.challenge !== expected.challenge)
    fail("That passkey answered an old or different request. Try again.");
  if (data.origin !== expected.origin) fail("That passkey answered for a different site.");
};

const checkRp = (rpIdHash: Uint8Array, rpId: string): void => {
  const want = NodeCrypto.createHash("sha256").update(rpId).digest();
  if (!NodeCrypto.timingSafeEqual(Buffer.from(rpIdHash), want))
    fail("That passkey belongs to a different site.");
};

export interface Expected {
  readonly challenge: string;
  readonly origin: string;
  readonly rpId: string;
}

/** A new passkey: the credential id and its public key, from `navigator.credentials.create`'s answer. */
export const verifyRegistration = (
  answer: { readonly clientDataJSON: Uint8Array; readonly attestationObject: Uint8Array },
  expected: Expected,
) => {
  checkClientData(answer.clientDataJSON, { ...expected, type: "webauthn.create" });
  const attestation = decodeCbor(answer.attestationObject);
  const authData = attestation instanceof Map ? attestation.get("authData") : null;
  if (!(authData instanceof Uint8Array)) fail("That passkey's answer is not valid.");
  const parsed = parseAuthData(authData);
  checkRp(parsed.rpIdHash, expected.rpId);
  if (!parsed.userPresent || !parsed.userVerified)
    fail("The passkey must check it's you (a fingerprint, face or device PIN).");
  if (parsed.credential === null) fail("That passkey has no public key.");
  const { jwk, alg } = coseToJwk(parsed.credential.publicKey);
  return { credentialId: b64u(parsed.credential.id), jwk, alg, signCount: parsed.signCount };
};

/** A step-up: the stored key's signature over the authenticator data and the client data's hash, by a verified user. */
export const verifyAssertion = (
  answer: {
    readonly clientDataJSON: Uint8Array;
    readonly authenticatorData: Uint8Array;
    readonly signature: Uint8Array;
  },
  expected: Expected,
  key: { readonly jwk: NodeCrypto.JsonWebKey; readonly alg: number; readonly signCount: number },
): { readonly signCount: number } => {
  checkClientData(answer.clientDataJSON, { ...expected, type: "webauthn.get" });
  const parsed = parseAuthData(answer.authenticatorData);
  checkRp(parsed.rpIdHash, expected.rpId);
  if (!parsed.userPresent || !parsed.userVerified)
    fail("The passkey must check it's you (a fingerprint, face or device PIN).");
  const signed = Buffer.concat([
    Buffer.from(answer.authenticatorData),
    NodeCrypto.createHash("sha256").update(answer.clientDataJSON).digest(),
  ]);
  const publicKey = NodeCrypto.createPublicKey({ key: key.jwk, format: "jwk" });
  const ok = NodeCrypto.verify(
    key.alg === -8 ? null : "sha256",
    signed,
    publicKey,
    Buffer.from(answer.signature),
  );
  if (!ok) fail("That passkey's signature is not right.");
  // A counter that stopped rising means a copied key, unless the authenticator keeps none (always 0).
  if ((parsed.signCount !== 0 || key.signCount !== 0) && parsed.signCount <= key.signCount)
    fail("That passkey looks copied. Remove it and add it again.");
  return { signCount: parsed.signCount };
};

/** A fresh challenge for one ceremony. */
export const newChallenge = (): string => NodeCrypto.randomBytes(32).toString("base64url");

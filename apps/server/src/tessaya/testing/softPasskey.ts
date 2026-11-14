// @effect-diagnostics nodeBuiltinImport:off - plays an authenticator with Node's crypto.
/** A software passkey for tests: signs registrations and assertions the way a phone's authenticator would. */
import * as NodeCrypto from "node:crypto";

/** Just enough CBOR to play an authenticator: unsigned and negative integers, bytes, text, maps. */
const cbor = (value: unknown): Buffer => {
  const head = (major: number, n: number) =>
    n < 24
      ? Buffer.from([(major << 5) | n])
      : n < 256
        ? Buffer.from([(major << 5) | 24, n])
        : Buffer.from([(major << 5) | 25, n >> 8, n & 255]);
  if (typeof value === "number") return value >= 0 ? head(0, value) : head(1, -1 - value);
  if (typeof value === "string")
    return Buffer.concat([head(3, Buffer.byteLength(value)), Buffer.from(value)]);
  if (value instanceof Uint8Array)
    return Buffer.concat([head(2, value.length), Buffer.from(value)]);
  if (value instanceof Map)
    return Buffer.concat([
      head(5, value.size),
      ...[...value].flatMap(([k, v]) => [cbor(k), cbor(v)]),
    ]);
  throw new TypeError("not in this CBOR");
};

export const RP = "home.example";
export const ORIGIN = "https://home.example";

/** A software passkey (ES256), signing as a phone's would. */
export const authenticator = (kind: "ec" | "ed25519" = "ec") => {
  const { privateKey, publicKey } =
    kind === "ec"
      ? NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" })
      : NodeCrypto.generateKeyPairSync("ed25519");
  const jwk = publicKey.export({ format: "jwk" });
  const cose =
    kind === "ec"
      ? new Map<unknown, unknown>([
          [1, 2],
          [3, -7],
          [-1, 1],
          [-2, Buffer.from(jwk.x!, "base64url")],
          [-3, Buffer.from(jwk.y!, "base64url")],
        ])
      : new Map<unknown, unknown>([
          [1, 1],
          [3, -8],
          [-1, 6],
          [-2, Buffer.from(jwk.x!, "base64url")],
        ]);
  const id = NodeCrypto.randomBytes(16);
  let count = 0;
  const authData = (flags: number, rp = RP, withKey = false) => {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(count);
    const parts: Array<Buffer> = [
      NodeCrypto.createHash("sha256").update(rp).digest(),
      Buffer.from([flags]),
      counter,
    ];
    if (withKey) parts.push(Buffer.alloc(16), Buffer.from([0, id.length]), id, cbor(cose));
    return Buffer.concat(parts);
  };
  const client = (type: string, challenge: string, origin = ORIGIN) =>
    Buffer.from(JSON.stringify({ type, challenge, origin }));
  return {
    create: (challenge: string, flags = 0x45) => ({
      clientDataJSON: client("webauthn.create", challenge),
      attestationObject: cbor(
        new Map<unknown, unknown>([
          ["fmt", "none"],
          ["authData", authData(flags, RP, true)],
          ["attStmt", new Map()],
        ]),
      ),
    }),
    get: (challenge: string, over: { flags?: number; rp?: string; origin?: string } = {}) => {
      count += 1;
      const data = authData(over.flags ?? 0x05, over.rp);
      const clientDataJSON = client("webauthn.get", challenge, over.origin);
      const signed = Buffer.concat([
        data,
        NodeCrypto.createHash("sha256").update(clientDataJSON).digest(),
      ]);
      return {
        clientDataJSON,
        authenticatorData: data,
        signature: NodeCrypto.sign(kind === "ec" ? "sha256" : null, signed, privateKey),
      };
    },
  };
};

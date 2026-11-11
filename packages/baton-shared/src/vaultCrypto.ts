// @effect-diagnostics nodeBuiltinImport:off
/** Sealing for the vault (D151) and private memories: AES-256-GCM, scrypt for a passphrase or PIN, random keys. Node crypto only. */
import * as NodeCrypto from "node:crypto";

export interface Sealed {
  readonly iv: string;
  readonly tag: string;
  readonly ct: string;
}

export interface KdfParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
}

/** About 128 MB and a second on a laptop; stored in the file, so it can be raised later. */
export const DEFAULT_KDF: KdfParams = { N: 2 ** 17, r: 8, p: 1 };

export const randomKey = (): Buffer => NodeCrypto.randomBytes(32);

export const seal = (key: Buffer, plain: Buffer, aad: string): Sealed => {
  const iv = NodeCrypto.randomBytes(12);
  const cipher = NodeCrypto.createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([cipher.update(plain), cipher.final()]);
  return {
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  };
};

/** Throws when the key is wrong or anything was changed. */
export const open = (key: Buffer, sealed: Sealed, aad: string): Buffer => {
  const decipher = NodeCrypto.createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(sealed.iv, "base64"),
  );
  decipher.setAAD(Buffer.from(aad));
  decipher.setAuthTag(Buffer.from(sealed.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(sealed.ct, "base64")), decipher.final()]);
};

export const deriveKey = (secret: string, salt: Buffer, kdf: KdfParams): Buffer =>
  NodeCrypto.scryptSync(secret.normalize("NFKC"), salt, 32, {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: 256 * kdf.N * kdf.r,
  });

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

/** 256 random bits as 13 groups of 4 base32 characters, to print or save. */
export const newRecoveryKey = (): { readonly bytes: Buffer; readonly text: string } => {
  const bytes = NodeCrypto.randomBytes(32);
  let bits = "";
  for (const b of bytes) bits += b.toString(2).padStart(8, "0");
  let chars = "";
  for (let i = 0; i < bits.length; i += 5)
    chars += ALPHABET[Number.parseInt(bits.slice(i, i + 5).padEnd(5, "0"), 2)];
  return { bytes, text: chars.match(/.{1,4}/g)!.join("-") };
};

export const parseRecoveryKey = (text: string): Buffer | null => {
  const chars = text.toUpperCase().replace(/[^A-Z2-7]/g, "");
  if (chars.length !== 52) return null;
  let bits = "";
  for (const c of chars) bits += ALPHABET.indexOf(c).toString(2).padStart(5, "0");
  const out = Buffer.alloc(32);
  for (let i = 0; i < 32; i++) out[i] = Number.parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
};

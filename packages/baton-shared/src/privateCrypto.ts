// @effect-diagnostics nodeBuiltinImport:off
/**
 * Keys for private memory stores (tessaya-ops research/PRIVATE-MEMORIES.md section 4). Each store has a random data key
 * (DEK) that seals every item. The DEK is wrapped by a PIN key bound to a server pepper, by a recovery code, and, for a
 * person's store, sealed to the owner's admin public key. Each store also has an X25519 box key pair, so an import can
 * add items to a locked store; only an open store reads them. Pure functions over Node crypto: no I/O, no clock.
 */
import * as NodeCrypto from "node:crypto";

import {
  DEFAULT_KDF,
  deriveKey,
  open,
  randomKey,
  seal,
  type KdfParams,
  type Sealed,
} from "./vaultCrypto.ts";

export const PRIVATE_FORMAT = "tessaya-private-v1";

/** A PIN key: scrypt makes each guess cost, the pepper (kept outside the database) makes a copied database useless. */
export const pinKey = (
  pin: string,
  salt: Buffer,
  pepper: Buffer,
  storeId: string,
  kdf: KdfParams = DEFAULT_KDF,
): Buffer => {
  const stretched = deriveKey(pin, salt, kdf);
  try {
    return hkdf(stretched, pepper, `${PRIVATE_FORMAT}|pin|${storeId}`);
  } finally {
    stretched.fill(0);
  }
};

/** A recovery code is 256 random bits, so it needs no stretching and no pepper: a backup restores with it alone. */
export const recoveryKey = (code: Buffer, storeId: string): Buffer =>
  hkdf(code, Buffer.alloc(0), `${PRIVATE_FORMAT}|recovery|${storeId}`);

const hkdf = (ikm: Buffer, salt: Buffer, info: string): Buffer =>
  Buffer.from(NodeCrypto.hkdfSync("sha256", ikm, salt, info, 32));

const wrapAad = (storeId: string, how: string) => `${PRIVATE_FORMAT}|wrap|${how}|${storeId}`;
export const wrapKey = (
  kek: Buffer,
  dek: Buffer,
  storeId: string,
  how: "pin" | "recovery",
): Sealed => seal(kek, dek, wrapAad(storeId, how));
/** Throws on a wrong key or a wrap moved from another store. */
export const unwrapKey = (
  kek: Buffer,
  sealed: Sealed,
  storeId: string,
  how: "pin" | "recovery",
): Buffer => open(kek, sealed, wrapAad(storeId, how));

const itemAad = (storeId: string, itemId: string) => `${PRIVATE_FORMAT}|item|${storeId}|${itemId}`;
/** One item's whole JSON under the store's key, bound to its store and id: a blob moved to another row will not open. */
export const sealItem = (dek: Buffer, storeId: string, itemId: string, json: string): Sealed =>
  seal(dek, Buffer.from(json, "utf8"), itemAad(storeId, itemId));
export const openItem = (dek: Buffer, sealed: Sealed, storeId: string, itemId: string): string =>
  open(dek, sealed, itemAad(storeId, itemId)).toString("utf8");

export interface BoxKeys {
  /** SPKI DER, base64: kept in plain beside the store. */
  readonly publicKey: string;
  /** PKCS8 DER of the private key, sealed under the store's own DEK. */
  readonly sealedPrivate: Sealed;
}
const boxAad = (storeId: string) => `${PRIVATE_FORMAT}|box|${storeId}`;
export const newBoxKeys = (dek: Buffer, storeId: string): BoxKeys => {
  const { publicKey, privateKey } = NodeCrypto.generateKeyPairSync("x25519");
  const der = privateKey.export({ type: "pkcs8", format: "der" });
  try {
    return {
      publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64"),
      sealedPrivate: seal(dek, der, boxAad(storeId)),
    };
  } finally {
    der.fill(0);
  }
};
export const openBoxKey = (dek: Buffer, keys: BoxKeys, storeId: string): Buffer =>
  open(dek, keys.sealedPrivate, boxAad(storeId));

export interface Boxed {
  /** The sender's one-time public key, SPKI DER base64. */
  readonly from: string;
  readonly sealed: Sealed;
}
const boxShared = (secret: Buffer, from: string, to: string, aad: string) =>
  hkdf(secret, Buffer.from(`${from}|${to}`), `${PRIVATE_FORMAT}|boxed|${aad}`);

/** Seals to a public key (X25519, HKDF, AES-256-GCM): anyone can write, only the private key's holder reads. */
export const sealTo = (publicKey: string, plain: Buffer, aad: string): Boxed => {
  const eph = NodeCrypto.generateKeyPairSync("x25519");
  const to = NodeCrypto.createPublicKey({
    key: Buffer.from(publicKey, "base64"),
    format: "der",
    type: "spki",
  });
  const secret = NodeCrypto.diffieHellman({ privateKey: eph.privateKey, publicKey: to });
  const from = eph.publicKey.export({ type: "spki", format: "der" }).toString("base64");
  const key = boxShared(secret, from, publicKey, aad);
  try {
    return { from, sealed: seal(key, plain, aad) };
  } finally {
    secret.fill(0);
    key.fill(0);
  }
};
export const openFrom = (
  privateDer: Buffer,
  publicKey: string,
  boxed: Boxed,
  aad: string,
): Buffer => {
  const privateKey = NodeCrypto.createPrivateKey({ key: privateDer, format: "der", type: "pkcs8" });
  const sender = NodeCrypto.createPublicKey({
    key: Buffer.from(boxed.from, "base64"),
    format: "der",
    type: "spki",
  });
  const secret = NodeCrypto.diffieHellman({ privateKey, publicKey: sender });
  const key = boxShared(secret, boxed.from, publicKey, aad);
  try {
    return open(key, boxed.sealed, aad);
  } finally {
    secret.fill(0);
    key.fill(0);
  }
};

/** A person's DEK sealed to the owner's admin key, so he can open any person's store once his own is open. */
export const adminAad = (storeId: string) => `${PRIVATE_FORMAT}|admin|${storeId}`;
/** An item added to a locked store, sealed to that store's box key until it is next opened. */
export const inboxAad = (storeId: string, itemId: string) =>
  `${PRIVATE_FORMAT}|inbox|${storeId}|${itemId}`;

/** The next link of an audit chain: a removed or edited row breaks every hash after it. */
export const auditHash = (key: Buffer, previous: string, row: string): string =>
  NodeCrypto.createHmac("sha256", key).update(previous).update("\n").update(row).digest("hex");
export const auditKey = (pepper: Buffer): Buffer =>
  hkdf(pepper, Buffer.alloc(0), `${PRIVATE_FORMAT}|audit`);

export { DEFAULT_KDF, randomKey, type KdfParams, type Sealed };

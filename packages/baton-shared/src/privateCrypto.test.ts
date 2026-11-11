import { describe, expect, it } from "vite-plus/test";

import {
  adminAad,
  auditHash,
  auditKey,
  inboxAad,
  newBoxKeys,
  openBoxKey,
  openFrom,
  openItem,
  pinKey,
  randomKey,
  recoveryKey,
  sealItem,
  sealTo,
  unwrapKey,
  wrapKey,
} from "./privateCrypto.ts";

const FAST = { N: 2 ** 10, r: 8, p: 1 };
const salt = Buffer.alloc(16, 7);
const pepper = Buffer.alloc(32, 9);

describe("private store keys", () => {
  it("opens with the right PIN and pepper only, and only for its own store", () => {
    const dek = randomKey();
    const wrapped = wrapKey(pinKey("27182818", salt, pepper, "s1", FAST), dek, "s1", "pin");
    expect(unwrapKey(pinKey("27182818", salt, pepper, "s1", FAST), wrapped, "s1", "pin")).toEqual(
      dek,
    );
    for (const [pin, pep, store] of [
      ["27182819", pepper, "s1"],
      ["27182818", Buffer.alloc(32, 8), "s1"],
      ["27182818", pepper, "s2"],
    ] as const) {
      expect(() => unwrapKey(pinKey(pin, salt, pep, store, FAST), wrapped, store, "pin")).toThrow();
    }
    // A PIN wrap is not a recovery wrap.
    expect(() =>
      unwrapKey(pinKey("27182818", salt, pepper, "s1", FAST), wrapped, "s1", "recovery"),
    ).toThrow();
  });

  it("opens with the recovery code alone, without the pepper", () => {
    const dek = randomKey();
    const code = randomKey();
    const wrapped = wrapKey(recoveryKey(code, "s1"), dek, "s1", "recovery");
    expect(unwrapKey(recoveryKey(code, "s1"), wrapped, "s1", "recovery")).toEqual(dek);
    expect(() => unwrapKey(recoveryKey(randomKey(), "s1"), wrapped, "s1", "recovery")).toThrow();
  });

  it("refuses an item blob moved to another row or store, or changed by one byte", () => {
    const dek = randomKey();
    const sealed = sealItem(dek, "s1", "i1", '{"text":"fake private marker"}');
    expect(openItem(dek, sealed, "s1", "i1")).toContain("fake private marker");
    expect(() => openItem(dek, sealed, "s1", "i2")).toThrow();
    expect(() => openItem(dek, sealed, "s2", "i1")).toThrow();
    expect(() => openItem(randomKey(), sealed, "s1", "i1")).toThrow();
    const ct = Buffer.from(sealed.ct, "base64");
    ct[0] = ct[0]! ^ 1;
    expect(() => openItem(dek, { ...sealed, ct: ct.toString("base64") }, "s1", "i1")).toThrow();
    expect(sealed.ct).not.toContain("marker");
  });

  it("lets anyone write to a store's box but only its own key read it", () => {
    const dek = randomKey();
    const keys = newBoxKeys(dek, "s1");
    const boxed = sealTo(keys.publicKey, Buffer.from("fake inbox item"), inboxAad("s1", "i1"));
    const priv = openBoxKey(dek, keys, "s1");
    expect(openFrom(priv, keys.publicKey, boxed, inboxAad("s1", "i1")).toString()).toBe(
      "fake inbox item",
    );
    expect(() => openFrom(priv, keys.publicKey, boxed, inboxAad("s1", "i2"))).toThrow();
    expect(() => openBoxKey(randomKey(), keys, "s1")).toThrow();
    const other = newBoxKeys(dek, "s2");
    expect(() =>
      openFrom(openBoxKey(dek, other, "s2"), other.publicKey, boxed, inboxAad("s1", "i1")),
    ).toThrow();
  });

  it("lets the owner's admin key open a person's key, and nothing else does", () => {
    const ownerDek = randomKey();
    const admin = newBoxKeys(ownerDek, "owner");
    const personDek = randomKey();
    const wrapped = sealTo(admin.publicKey, personDek, adminAad("p1"));
    expect(
      openFrom(openBoxKey(ownerDek, admin, "owner"), admin.publicKey, wrapped, adminAad("p1")),
    ).toEqual(personDek);
    expect(() =>
      openFrom(openBoxKey(ownerDek, admin, "owner"), admin.publicKey, wrapped, adminAad("p2")),
    ).toThrow();
  });

  it("chains the audit so a removed line breaks the rest", () => {
    const key = auditKey(pepper);
    const a = auditHash(key, "", "unlock ok");
    const b = auditHash(key, a, "read 3");
    expect(auditHash(key, "", "read 3")).not.toBe(b);
    expect(auditHash(auditKey(Buffer.alloc(32, 1)), "", "unlock ok")).not.toBe(a);
  });
});

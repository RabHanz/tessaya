import { expect, it } from "vite-plus/test";

import {
  parseR1ReleaseIndex,
  r1EasyAction,
  R1_FIRMWARE,
  R1_FIRMWARE_MAX_BYTES,
  R1_FIRMWARE_PUBLIC_KEY,
  R1_RELEASE,
  r1Release,
  verifyR1Signature,
} from "./r1Firmware.ts";

// ECDSA P-256 over a digest as given (the R1 verifies the image's sha256 itself, prehashed); Node's crypto always
// hashes first, so the check is done here in plain BigInt arithmetic.
const P = 0xffffffff00000001000000000000000000000000ffffffffffffffffffffffffn;
const N = 0xffffffff00000000ffffffffffffffffbce6faada7179e84f3b9cac2fc632551n;
const A = P - 3n;
const G: Point = [
  0x6b17d1f2e12c4247f8bce6e563a440f277037d812deb33a0f4a13945d898c296n,
  0x4fe342e2fe1a7f9b8ee7eb4a7c0f9e162bce33576b315ececbb6406837bf51f5n,
];
type Point = readonly [bigint, bigint] | null;
const mod = (a: bigint, m: bigint) => ((a % m) + m) % m;
const inv = (a: bigint, m: bigint) => {
  let [r0, r1, s0, s1] = [mod(a, m), m, 1n, 0n];
  while (r1 !== 0n) {
    const q = r0 / r1;
    [r0, r1, s0, s1] = [r1, r0 - q * r1, s1, s0 - q * s1];
  }
  return mod(s0, m);
};
const add = (p: Point, q: Point): Point => {
  if (p === null) return q;
  if (q === null) return p;
  if (p[0] === q[0] && mod(p[1] + q[1], P) === 0n) return null;
  const l =
    p[0] === q[0] && p[1] === q[1]
      ? mod((3n * p[0] * p[0] + A) * inv(2n * p[1], P), P)
      : mod((q[1] - p[1]) * inv(q[0] - p[0], P), P);
  const x = mod(l * l - p[0] - q[0], P);
  return [x, mod(l * (p[0] - x) - p[1], P)];
};
const mul = (k: bigint, p: Point): Point => {
  let out: Point = null;
  for (let q = p; k > 0n; k >>= 1n, q = add(q, q)) if (k & 1n) out = add(out, q);
  return out;
};
const big = (hex: string) => BigInt(`0x${hex}`);
const verifies = (digest: string, sig: string, point: string) => {
  const [r, s] = [big(sig.slice(0, 64)), big(sig.slice(64))];
  if (r <= 0n || r >= N || s <= 0n || s >= N) return false;
  const q: Point = [big(point.slice(2, 66)), big(point.slice(66))];
  const w = inv(s, N);
  const x = add(mul(mod(big(digest) * w, N), G), mul(mod(r * w, N), q));
  return x !== null && mod(x[0], N) === r;
};

it("pins a firmware whose release signature verifies against the R1's compiled-in key", () => {
  expect(R1_FIRMWARE).not.toBeNull();
  const pin = R1_FIRMWARE!;
  expect(pin.url).toContain(`/releases/download/r1-firmware-${pin.version}/`);
  expect(pin.size).toBeLessThanOrEqual(R1_FIRMWARE_MAX_BYTES);
  expect(verifies(pin.sha256, pin.sig, R1_FIRMWARE_PUBLIC_KEY)).toBe(true);
  // The check really checks: another image's hash or a changed signature does not pass.
  expect(verifies(`${pin.sha256.slice(0, 63)}0`, pin.sig, R1_FIRMWARE_PUBLIC_KEY)).toBe(false);
  expect(verifies(pin.sha256, `${pin.sig.slice(0, 127)}0`, R1_FIRMWARE_PUBLIC_KEY)).toBe(false);
  // The wake model pack is signed by the same release key, and the check really checks.
  const kws = R1_RELEASE.artifacts.kws!;
  expect(kws.url).toContain(`/releases/download/r1-kws-v${kws.version}/`);
  expect(verifies(kws.sha256, kws.sig, R1_FIRMWARE_PUBLIC_KEY)).toBe(true);
  expect(verifies(`${kws.sha256.slice(0, 63)}0`, kws.sig, R1_FIRMWARE_PUBLIC_KEY)).toBe(false);
  // Today's single-firmware pin still reads as a manifest.
  expect(r1Release(pin)).toEqual({ artifacts: { firmware: pin, kws: null } });
  expect(r1Release(R1_RELEASE)).toBe(R1_RELEASE);
});

it("checks a release signature over the file with the R1's compiled-in key, and nothing else", async () => {
  // A real signed release file is too large to keep here; the wake pack's signature is over its bytes, and those are
  // reproduced only by the release, so check the scheme with a key made here and the real key's refusals.
  const keys = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, [
    "sign",
    "verify",
  ]);
  const raw = Buffer.from(await crypto.subtle.exportKey("raw", keys.publicKey)).toString("hex");
  const data = new TextEncoder().encode('{"v":1}');
  const sig = Buffer.from(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.privateKey, data),
  ).toString("hex");
  expect(await verifyR1Signature(data, sig, raw)).toBe(true);
  expect(await verifyR1Signature(new TextEncoder().encode('{"v":2}'), sig, raw)).toBe(false);
  expect(await verifyR1Signature(data, sig)).toBe(false);
  expect(await verifyR1Signature(data, "zz")).toBe(false);
});

it("reads the release list, dropping entries that are not signed images", () => {
  const img = {
    url: "https://x.test/a.rbl",
    size: 3,
    sha256: "a".repeat(64),
    sig: "b".repeat(128),
  };
  const list = parseR1ReleaseIndex(
    JSON.stringify({
      v: 1,
      recommended: "smp-0.3.98",
      releases: [
        { version: "smp-0.3.98", date: "2026-11-14", rbl: img, allapp: img },
        { version: "smp-0.3.95", date: "2026-11-14", rbl: img, allapp: null },
        {
          version: "smp-0.3.94",
          date: "2026-11-14",
          rbl: { ...img, url: "http://x.test/a" },
          allapp: null,
        },
        { version: "custom", date: "2026-11-14", rbl: img, allapp: null },
      ],
    }),
  );
  expect(list?.releases.map((r) => r.version)).toEqual(["smp-0.3.98", "smp-0.3.95"]);
  expect(parseR1ReleaseIndex("not json")).toBeNull();
  expect(parseR1ReleaseIndex('{"v":2,"recommended":"x","releases":[]}')).toBeNull();
});

it("picks Easy's one action: wait, repair by cable when offline, nothing when current, else update", () => {
  const d = { id: "r1", firmware: "smp-0.3.95", line: "", kws: "", hold: null, updating: null };
  expect(r1EasyAction(true, d, "smp-0.3.98")).toEqual({ kind: "update", version: "smp-0.3.98" });
  expect(r1EasyAction(true, { ...d, firmware: "smp-0.3.98" }, "smp-0.3.98")).toEqual({
    kind: "current",
  });
  expect(r1EasyAction(false, d, "smp-0.3.98")).toEqual({ kind: "usb" });
  expect(r1EasyAction(false, { ...d, updating: "smp-0.3.98" }, "smp-0.3.98")).toEqual({
    kind: "busy",
    version: "smp-0.3.98",
  });
  expect(r1EasyAction(true, undefined, null)).toEqual({ kind: "current" });
});

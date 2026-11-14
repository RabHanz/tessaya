import { expect, it } from "vite-plus/test";

import { R1_FIRMWARE, R1_FIRMWARE_PUBLIC_KEY, R1_RELEASE, r1Release } from "./r1Firmware.ts";

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
  expect(verifies(pin.sha256, pin.sig, R1_FIRMWARE_PUBLIC_KEY)).toBe(true);
  // The check really checks: another image's hash or a changed signature does not pass.
  expect(verifies(`${pin.sha256.slice(0, 63)}0`, pin.sig, R1_FIRMWARE_PUBLIC_KEY)).toBe(false);
  expect(verifies(pin.sha256, `${pin.sig.slice(0, 127)}0`, R1_FIRMWARE_PUBLIC_KEY)).toBe(false);
  // A pinned wake model pack is signed by the same key.
  const kws = R1_RELEASE.artifacts.kws;
  if (kws !== null) expect(verifies(kws.sha256, kws.sig, R1_FIRMWARE_PUBLIC_KEY)).toBe(true);
  // Today's single-firmware pin still reads as a manifest.
  expect(r1Release(pin)).toEqual({ artifacts: { firmware: pin, kws: null } });
  expect(r1Release(R1_RELEASE)).toBe(R1_RELEASE);
});

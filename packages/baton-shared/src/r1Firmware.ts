/**
 * The R1 firmware this release of Tessaya installs on the R1s on its hub, like the pinned `cloudflared`: our release
 * pipeline signs the image and sets this manifest (version, the image's address on our releases, its size, sha256 and
 * signature). A user's server only passes the signed image on; it never holds the signing key. Null: no update.
 */
export interface R1FirmwarePin {
  readonly version: string;
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
  /** ECDSA P-256 over the package sha256, from our release pipeline; firmware 0.3.74+ refuses an image without it. */
  readonly sig: string;
}

/**
 * The R1's on-device wake model pack (firmware contract): signed like the firmware, over the whole file's sha256. The
 * version is a counter; `threshold` is informational (the pack carries its own).
 */
export interface R1KwsPin {
  readonly version: number;
  readonly url: string;
  readonly sha256: string;
  readonly size: number;
  readonly sig: string;
  readonly threshold: number;
}

/** The largest pack the R1 takes. */
export const R1_KWS_MAX_BYTES = 476 * 1024;

/** Everything one release of Tessaya pins for its R1s. Null: that artifact is not updated. */
export interface R1ReleaseManifest {
  readonly artifacts: { readonly firmware: R1FirmwarePin | null; readonly kws: R1KwsPin | null };
}

/** A manifest, or today's single-firmware pin read as one. */
export const r1Release = (pin: R1ReleaseManifest | R1FirmwarePin | null): R1ReleaseManifest =>
  pin !== null && "artifacts" in pin ? pin : { artifacts: { firmware: pin, kws: null } };

export const R1_RELEASE: R1ReleaseManifest = {
  artifacts: {
    firmware: {
      version: "smp-0.3.95",
      url: "https://github.com/RabHanz/tessaya/releases/download/r1-firmware-smp-0.3.95/r1bt-smp-0.3.95.rbl",
      size: 1637776,
      sha256: "3e5b398a3b5e3d5cec45b4d6944b12d96829771783489b19a51cdab6a77cb187",
      sig: "3b4db400008e64f6453cc647733f71ca873915af5c33d30e2a88ab27a750b3115185c6f7e20fdb8032f5de3fc6f2fd1571168256cba8532cc026ef448221a5cb",
    },
    kws: {
      version: 1,
      url: "https://github.com/RabHanz/tessaya/releases/download/r1-kws-v1/r1-kws-v1.r1kw",
      size: 27228,
      sha256: "af4cc208dd115f8ead84d310847e34c0867a488b45cf04139fd1ce7e44a937f3",
      sig: "ccd09770dcdab708de0ec94bf7d15d4c5d9576a6f2c0104fd69a1777b39eca6adbe58b2d98fd25e82129cdd9dc7e195a41357111affb128dcc602ccabd20741a",
      threshold: 0.4,
    },
  },
};

const fwParts = (version: string) =>
  /^(?:smp-)?(\d+)\.(\d+)\.(\d+)$/.exec(version)?.slice(1).map(Number) ?? null;

/**
 * Orders two R1 firmware versions (`smp-X.Y.Z`): negative when `a` is older, 0 equal, positive newer. Null when
 * either does not parse, which callers treat as "do not install".
 */
export const compareR1Firmware = (a: string, b: string): number | null => {
  const [x, y] = [fwParts(a), fwParts(b)];
  if (x === null || y === null) return null;
  return x[0]! - y[0]! || x[1]! - y[1]! || x[2]! - y[2]!;
};

export const R1_FIRMWARE: R1FirmwarePin | null = R1_RELEASE.artifacts.firmware;

/**
 * The release key's public half, as compiled into the firmware (`r1bt_ota_key.h`, secp256r1, uncompressed). Only for
 * checking a pin before it ships; the R1 itself does the check that counts.
 */
export const R1_FIRMWARE_PUBLIC_KEY =
  "044a630e15eaf9f58558dbbd8f9519c26349b80e7c94110f159c92824c3470ea16e6aa5da0ee9dc560a62bfbe3b6710d2268855d27a785dfbb040d1b8158c32a14";

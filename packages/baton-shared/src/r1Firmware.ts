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
      version: "smp-0.3.76",
      url: "https://github.com/RabHanz/tessaya/releases/download/r1-firmware-smp-0.3.76/r1bt-smp-0.3.76.rbl",
      size: 1633696,
      sha256: "1000036051620ba8f716bdd762b04ce0d8b108c7716faeddfeaafa71ac1186df",
      sig: "b7a9ad19fe173567efb4a0784c1ae09bfcaba021197c4097d789c667b9f410709c2c1addb7f1458c74404d175bd8dd2464e2ef6bbd83f544f3f94bba4a2cdf09",
    },
    // The firmware lane publishes the first pack.
    kws: null,
  },
};

export const R1_FIRMWARE: R1FirmwarePin | null = R1_RELEASE.artifacts.firmware;

/**
 * The release key's public half, as compiled into the firmware (`r1bt_ota_key.h`, secp256r1, uncompressed). Only for
 * checking a pin before it ships; the R1 itself does the check that counts.
 */
export const R1_FIRMWARE_PUBLIC_KEY =
  "044a630e15eaf9f58558dbbd8f9519c26349b80e7c94110f159c92824c3470ea16e6aa5da0ee9dc560a62bfbe3b6710d2268855d27a785dfbb040d1b8158c32a14";

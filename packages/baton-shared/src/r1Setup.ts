/**
 * Setting up a new R1 from an app (web, desktop, phone): the pairing QR, the Bluetooth passkey, and the setup steps
 * over the R1's setup service (firmware 0.3.70). No platform code: the caller hands in its Bluetooth port and the
 * server's claim. Contract: tessaya-ops research R1-CONNECT-UNIVERSAL §10.
 */

const base = (n: string) => `c0a8e7d2-52f1-4f6b-9a3e-3b1e5d0a${n}`;
export const R1_SETUP_SERVICE = base("0001");
export const R1_SETUP_CHARS = {
  status: base("0002"),
  pairing: base("0003"),
  nearby: base("0004"),
  ssid: base("0005"),
  pass: base("0006"),
  join: base("0007"),
  claim: base("0008"),
} as const;

/** `T3R1:<DEVICE-ID>:<32 hex>` from the right eye: the id as stored (lower case) and the one-time key. */
export const parsePairingQr = (
  text: string,
): { readonly deviceId: string; readonly oneTimeKey: string } | null => {
  const m = /^T3R1:([A-Za-z0-9_-]{1,60}):([0-9A-Fa-f]{32})$/.exec(text.trim());
  return m === null ? null : { deviceId: m[1]!.toLowerCase(), oneTimeKey: m[2]!.toUpperCase() };
};

// SHA-256 and HMAC in plain code: React Native has no WebCrypto, and this runs once per setup.
const K = Uint32Array.from([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export const sha256 = (data: Uint8Array): Uint8Array => {
  const bits = data.length * 8;
  const padded = new Uint8Array(Math.ceil((data.length + 9) / 64) * 64);
  padded.set(data);
  padded[data.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bits / 2 ** 32));
  view.setUint32(padded.length - 4, bits >>> 0);
  const h = Uint32Array.from([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, hh] = h as unknown as [
      number,
      number,
      number,
      number,
      number,
      number,
      number,
      number,
    ];
    for (let i = 0; i < 64; i++) {
      const t1 =
        (hh + (rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)) + ((e & f) ^ (~e & g)) + K[i]! + w[i]!) >>>
        0;
      const t2 = ((rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)) + ((a & b) ^ (a & c) ^ (b & c))) >>> 0;
      hh = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h.set([a, b, c, d, e, f, g, hh].map((v, i) => (v + h[i]!) >>> 0));
  }
  const out = new Uint8Array(32);
  const ov = new DataView(out.buffer);
  for (let i = 0; i < 8; i++) ov.setUint32(i * 4, h[i]!);
  return out;
};

export const hmacSha256 = (key: Uint8Array, message: Uint8Array): Uint8Array => {
  const k = new Uint8Array(64);
  k.set(key.length > 64 ? sha256(key) : key);
  const pad = (x: number) => k.map((b) => b ^ x);
  const inner = new Uint8Array(64 + message.length);
  inner.set(pad(0x36));
  inner.set(message, 64);
  const outer = new Uint8Array(96);
  outer.set(pad(0x5c));
  outer.set(sha256(inner), 64);
  return sha256(outer);
};

const hexBytes = (hex: string) =>
  Uint8Array.from(hex.match(/../g) ?? [], (b) => Number.parseInt(b, 16));

/** The 6 digits the R1's eyes show for Bluetooth pairing: HMAC-SHA256(otk's 16 bytes, label), 4 bytes BE mod 1e6. */
export const blePasskey = (oneTimeKey: string): string => {
  const mac = hmacSha256(hexBytes(oneTimeKey), new TextEncoder().encode("tessaya-r1-ble-passkey"));
  const n = new DataView(mac.buffer).getUint32(0);
  return String(n % 1_000_000).padStart(6, "0");
};

/** What an app's Bluetooth stack gives the setup: an R1 already connected and paired (with `blePasskey`). */
export interface R1SetupPort {
  readonly write: (characteristic: string, value: Uint8Array) => Promise<void>;
  /** Calls back with each status the R1 sends; returns a stop. */
  readonly watch: (
    characteristic: string,
    onValue: (value: Uint8Array) => void,
  ) => Promise<() => void>;
}

export type R1SetupStep = "wifi" | "claim" | "joining" | "online" | "failed";

/**
 * Wi-Fi, then the server's sealed claim, then join; done when the R1 says it is online. Every value is UTF-8 text
 * (the claim is its base64 blob, as the R1's setup page takes it); join is "1". The status text is shown as it comes.
 */
export const runR1Setup = async (input: {
  readonly port: R1SetupPort;
  readonly ssid: string;
  readonly pass: string;
  /** The server's claim for this R1: the sealed blob. */
  readonly claim: () => Promise<string>;
  readonly onStep: (step: R1SetupStep, detail: string) => void;
  /** Resolves when it is time to give up waiting (the caller's timer). */
  readonly timeout: Promise<void>;
}): Promise<boolean> => {
  const text = (s: string) => new TextEncoder().encode(s);
  input.onStep("wifi", "");
  await input.port.write(R1_SETUP_CHARS.ssid, text(input.ssid));
  await input.port.write(R1_SETUP_CHARS.pass, text(input.pass));
  input.onStep("claim", "");
  await input.port.write(R1_SETUP_CHARS.claim, text(await input.claim()));
  const result = new Promise<boolean>((resolve) => {
    void input.port
      .watch(R1_SETUP_CHARS.status, (value) => {
        const said = new TextDecoder().decode(value);
        const state = statusState(said);
        if (state === "online") resolve(true);
        else if (state === "failed") resolve(false);
        input.onStep(state ?? "joining", said);
      })
      .then((stop) => result.finally(stop));
    void input.timeout.then(() => resolve(false));
  });
  input.onStep("joining", "");
  await input.port.write(R1_SETUP_CHARS.join, text("1"));
  const ok = await result;
  input.onStep(ok ? "online" : "failed", "");
  return ok;
};

/** A status the R1 sent: online, failed, or still going (null). JSON `{state}` or plain words. */
export const statusState = (said: string): "online" | "failed" | null => {
  let state = said;
  try {
    const parsed = JSON.parse(said) as { state?: unknown };
    if (typeof parsed?.state === "string") state = parsed.state;
  } catch {
    // plain text
  }
  const s = state.toLowerCase();
  if (/\b(online|connected|done)\b/.test(s)) return "online";
  if (/\b(fail|failed|error|badpass|wrong)/.test(s)) return "failed";
  return null;
};

import { DEVICE } from "./productNames.ts";
/**
 * Setting up a new R1 from an app (web, desktop, phone): the pairing QR and the setup steps
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

/**
 * What an app's Bluetooth stack gives the setup: an R1 already connected and paired. The R1's eyes show its stack's
 * random 6 digits, and he types them into the system's pairing prompt (or the desktop app's).
 */
export interface R1SetupPort {
  readonly write: (characteristic: string, value: Uint8Array) => Promise<void>;
  readonly read: (characteristic: string) => Promise<Uint8Array>;
  /** Calls back on each notify; returns a stop. A notify carries only MTU-3 bytes, so the status is read after it. */
  readonly watch: (characteristic: string, onNotify: () => void) => Promise<() => void>;
}

export type R1SetupStep = "wifi" | "claim" | "joining" | "online" | "failed";

/** The status characteristic (firmware 0.3.73): `{"op","state","ok"?,"err"?}`. */
export interface R1SetupStatus {
  readonly op: string;
  readonly state: string;
  readonly err?: string;
}

/** What the setup should do with a status: finish well, stop with a sentence for him, or keep waiting (null). */
export const statusOutcome = (
  status: R1SetupStatus,
): { readonly ok: true } | { readonly ok: false; readonly why: string } | null => {
  if (status.state === "badpass") return { ok: false, why: "That Wi-Fi password didn't work." };
  if (status.state === "fail")
    return {
      ok: false,
      why:
        status.op === "claim"
          ? `The ${DEVICE} could not take this server's pairing. Show its pairing code again and retry.`
          : status.op === "pair"
            ? "Bluetooth pairing did not finish. Check the 6 digits and try again."
            : `The ${DEVICE} could not join that Wi-Fi${status.err === undefined ? "" : ` (${status.err})`}.`,
    };
  if (status.op === "join" && status.state === "done") return { ok: true };
  return null;
};

const decodeStatus = (bytes: Uint8Array): R1SetupStatus | null => {
  try {
    const v = JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
    return typeof v["op"] === "string" && typeof v["state"] === "string"
      ? {
          op: v["op"],
          state: v["state"],
          ...(typeof v["err"] === "string" ? { err: v["err"] } : {}),
        }
      : null;
  } catch {
    return null;
  }
};

/**
 * Wi-Fi, then the server's sealed claim, then join (all UTF-8; join takes any value), and done when the R1 says the
 * join is done. `onStep` gets a sentence for him when it stops short.
 */
export const runR1Setup = async (input: {
  readonly port: R1SetupPort;
  readonly ssid: string;
  readonly pass: string;
  /** The server's claim for this R1: the sealed blob. */
  readonly claim: () => Promise<string>;
  readonly onStep: (step: R1SetupStep, why: string) => void;
  /** Resolves when it is time to give up waiting (the caller's timer). */
  readonly timeout: Promise<void>;
}): Promise<boolean> => {
  const text = (s: string) => new TextEncoder().encode(s);
  let settle: (outcome: { ok: boolean; why: string }) => void = () => {};
  const result = new Promise<{ ok: boolean; why: string }>((resolve) => {
    settle = resolve;
  });
  const stop = await input.port.watch(R1_SETUP_CHARS.status, () => {
    void input.port.read(R1_SETUP_CHARS.status).then((bytes) => {
      const status = decodeStatus(bytes);
      const outcome = status === null ? null : statusOutcome(status);
      if (outcome !== null) settle({ ok: outcome.ok, why: outcome.ok ? "" : outcome.why });
    });
  });
  void input.timeout.then(() =>
    settle({
      ok: false,
      why: `The ${DEVICE} did not answer in time. Check it is in setup mode and nearby.`,
    }),
  );
  try {
    input.onStep("wifi", "");
    await input.port.write(R1_SETUP_CHARS.ssid, text(input.ssid));
    await input.port.write(R1_SETUP_CHARS.pass, text(input.pass));
    input.onStep("claim", "");
    await input.port.write(R1_SETUP_CHARS.claim, text(await input.claim()));
    input.onStep("joining", "");
    await input.port.write(R1_SETUP_CHARS.join, text("1"));
    const outcome = await result;
    input.onStep(outcome.ok ? "online" : "failed", outcome.why);
    return outcome.ok;
  } finally {
    stop();
  }
};

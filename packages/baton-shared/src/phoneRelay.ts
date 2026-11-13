/** The rules of the phone-to-desktop relay, pure: how long things live and what the phone is told. */

export const ASK_TTL_MS = 24 * 3_600_000;
/** An ask from the web intent bar is for now: undelivered after this, it expires rather than running later unannounced. */
export const BAR_ASK_TTL_MS = 5 * 60_000;
/** What the web intent bar says when no desktop is there to answer; nothing is queued. */
export const BAR_NOT_CONNECTED =
  "No Tessaya desktop is connected to this server, so nothing was asked. Open Tessaya on that computer and try again.";
/** A taken ask the desktop stops renewing for this long is dropped (the desktop closed mid-answer); it never runs twice. */
export const ASK_LEASE_MS = 5 * 60_000;
/** The desktop counts as connected if it asked for work this recently. */
export const CONNECTED_MS = 45_000;
/** A mirrored question that nobody answers is dropped after this (the desktop's own box gives up at 60 s). */
export const PROMPT_TTL_MS = 120_000;
export const ASK_TEXT_MAX = 2_000;
export const QUEUE_MAX = 20;
export const CLIENT_ID = /^[A-Za-z0-9_-]{8,64}$/;

export const NOT_CONNECTED = "Your computer is not connected; it will answer when it is back.";

export type AskSource = "phone" | "device";

export type AskStatus = "queued" | "taken" | "answered" | "failed" | "expired";

export interface PhoneAsk {
  readonly id: string;
  readonly text: string;
  /** "phone": his own (the paired phone page or the desktop app); "device": a token's words, which may be an agent's. */
  readonly source: AskSource;
  /** The device he said it to ("R1", "phone"), when it came through one; its answer and approvals name it. */
  readonly origin: string | null;
  readonly status: AskStatus;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly spoken: string | null;
  readonly card: string | null;
  readonly error: string | null;
}

export interface PhonePrompt {
  readonly id: string;
  readonly title: string;
  /** The exact words of the question, as the desktop shows them. */
  readonly detail: string;
  readonly buttons: ReadonlyArray<string>;
  readonly yes: number;
  readonly cancel: number;
  /** Answering from a phone needs this permission (a cloud approval); absent means any paired phone may. */
  readonly needs?: "cloud-approve";
}

export const isConnected = (lastSeen: number | null, now: number): boolean =>
  lastSeen !== null && now - lastSeen <= CONNECTED_MS;

/** What the phone shows for an ask: the answer when there is one, else where it stands. */
export const askLine = (ask: PhoneAsk, connected: boolean): string => {
  switch (ask.status) {
    case "answered":
      return ask.card ?? ask.spoken ?? "Done.";
    case "failed":
      return ask.error ?? "That did not work.";
    case "expired":
      return "That waited too long and was dropped. Ask again.";
    case "taken":
      return "Working on it on your computer.";
    default:
      return connected ? "Waiting for your computer to pick it up." : NOT_CONNECTED;
  }
};

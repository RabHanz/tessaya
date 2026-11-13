/**
 * The phone page's API (docs/baton/MOBILE.md), as plain functions so the rules are testable without a server: reading
 * needs the read scope, anything that changes work needs the operate scope, and an approval is answered only if it is still
 * waiting and still says what the page showed.
 */
import {
  checkWav,
  parseDecision,
  WAV_MAX_BYTES,
  type PhoneState,
} from "@t3tools/baton-shared/phone";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { askLine, type PhoneAsk } from "@t3tools/baton-shared/phoneRelay";

import type { PostResult } from "./BatonPhoneInbox.ts";
import type { Transcription } from "./BatonPhoneVoice.ts";

export const READ_SCOPE = "orchestration:read";
export const OPERATE_SCOPE = "orchestration:operate";
/** A phone may answer the desktop's own questions (cloud approvals, hands and vault confirms) only if it was paired with this permission on purpose. */
export const CLOUD_APPROVE_SCOPE = "baton:cloud-approve";

export interface PhoneDeps {
  readonly state: () => Promise<PhoneState>;
  readonly agree: (id: string) => Promise<void>;
  readonly stop: (id: string) => Promise<boolean>;
  /** A sentence for him: what was done, or why not. */
  readonly retry: (id: string) => Promise<string>;
  /** Leaves words for the desktop assistant, as the user's own (source phone); a repeat of the same id asks once. */
  readonly ask: (id: string, text: string) => Promise<PostResult>;
  readonly askGet: (
    id: string,
  ) => Promise<{ readonly ask: PhoneAsk | null; readonly connected: boolean }>;
  /**
   * Answers a question the desktop mirrored: the button index. False if it was already answered; a reason when this
   * device's person may not give that answer.
   */
  readonly answerPrompt: (id: string, index: number) => Promise<boolean | string>;
  readonly transcribe: (wav: Uint8Array) => Promise<Transcription>;
}

export interface PhoneRequest {
  readonly method: string;
  /** The path after `/tessaya/api/`. */
  readonly path: string;
  readonly scopes: ReadonlySet<string>;
  readonly json?: unknown;
  readonly bytes?: Uint8Array;
  /** The client id for a recording (a header), so a retried upload asks once. */
  readonly clientId?: string;
}
export interface PhoneResponse {
  readonly status: number;
  readonly json: Record<string, unknown>;
}

const say = (status: number, message: string): PhoneResponse => ({ status, json: { message } });

const TOO_LONG = "That recording is too long. Keep it under three minutes.";

/**
 * Checked before an upload's body is read: a phone that may not act, or a stated size over the cap, is refused
 * unread. A chunked body states no size; `readCapped` holds it to the same cap as it arrives.
 */
export const uploadRefusal = (
  scopes: ReadonlySet<string>,
  contentLength: string | undefined,
): PhoneResponse | null => {
  if (!scopes.has(OPERATE_SCOPE))
    return say(403, "This phone may look but not act. Pair it with operate access.");
  if (contentLength === undefined) return null;
  const size = Number(contentLength);
  return Number.isInteger(size) && size >= 0 && size <= WAV_MAX_BYTES ? null : say(413, TOO_LONG);
};

/** The body, or a 413 the moment it passes `max` bytes; the rest is never read. */
export const readCapped = Effect.fn("BatonTessayaApi.readCapped")(function* <E>(
  body: Stream.Stream<Uint8Array, E>,
  max: number = WAV_MAX_BYTES,
) {
  const parts: Array<Uint8Array> = [];
  let size = 0;
  yield* body.pipe(
    Stream.takeWhile((chunk) => {
      size += chunk.byteLength;
      return size <= max;
    }),
    Stream.runForEach((chunk) => Effect.sync(() => void parts.push(chunk))),
  );
  if (size > max) return say(413, TOO_LONG);
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
});
const TEXT_MAX = 2_000;

export const handlePhone = async (deps: PhoneDeps, req: PhoneRequest): Promise<PhoneResponse> => {
  const parts = req.path.split("/").filter((p) => p !== "");
  const mutating = req.method !== "GET";
  if (!req.scopes.has(mutating ? OPERATE_SCOPE : READ_SCOPE)) {
    return say(
      403,
      mutating
        ? "This phone may look but not act. Pair it with operate access."
        : "This phone may not read that.",
    );
  }
  const body = (req.json ?? {}) as Record<string, unknown>;

  if (req.method === "GET" && parts[0] === "state" && parts.length === 1)
    return { status: 200, json: { ...(await deps.state()) } };
  if (req.method === "GET" && parts[0] === "ask" && parts.length === 2) {
    const { ask, connected } = await deps.askGet(parts[1]!);
    if (ask === null) return say(404, "No such request.");
    return {
      status: 200,
      json: {
        id: ask.id,
        status: ask.status,
        line: askLine(ask, connected),
        spoken: ask.spoken,
        card: ask.card,
      },
    };
  }
  if (req.method !== "POST") return say(404, "No such page.");

  if (parts[0] === "approvals" && parts.length === 2) {
    const now = await deps.state();
    const approval = now.approvals.find((a) => a.id === parts[1]);
    // A question the desktop mirrored is its own consent gate (hands, vault, screen, cloud), so operate alone is not enough.
    if (approval?.kind === "prompt" && !req.scopes.has(CLOUD_APPROVE_SCOPE)) {
      return say(
        403,
        "This phone is not allowed to answer your computer's own questions. Answer it on your computer, or pair this phone again with the approval permission (baton:cloud-approve).",
      );
    }
    const choice = body["choice"];
    // A question with a button for each answer (the cloud card): the phone sends which one, never a key.
    if (
      typeof choice === "number" &&
      approval !== undefined &&
      approval.kind === "prompt" &&
      approval.buttons !== undefined
    ) {
      if (!Number.isInteger(choice) || choice < 0 || choice >= approval.buttons.length)
        return say(400, "That is not one of the buttons.");
      if (body["action"] !== approval.action)
        return say(409, "It changed since you looked. Look again.");
      const took = await deps.answerPrompt(approval.ref, choice);
      if (typeof took === "string") return say(403, took);
      return took
        ? say(200, "Sent. Your computer carries on.")
        : say(409, "It was already answered on your computer.");
    }
    const decision = parseDecision(body["decision"]);
    if (decision === null) return say(400, "Say approve or deny.");
    if (approval === undefined) return say(404, "That is no longer waiting for you.");
    if (approval.kind === "prompt" && approval.yes !== undefined && approval.cancel !== undefined) {
      if (body["action"] !== approval.action)
        return say(409, "It changed since you looked. Look again.");
      const took = await deps.answerPrompt(
        approval.ref,
        decision === "approve" ? approval.yes : approval.cancel,
      );
      if (typeof took === "string") return say(403, took);
      return took
        ? say(200, decision === "approve" ? "Approved. Your computer carries on." : "Denied.")
        : say(409, "It was already answered on your computer.");
    }
    if (!approval.answerable) return say(409, "Only you can answer that one, in its thread.");
    if (body["action"] !== approval.action)
      return say(409, "It changed since you looked. Look again.");
    if (decision === "approve") await deps.agree(approval.ref);
    else await deps.stop(approval.ref);
    return say(
      200,
      decision === "approve" ? "Approved. It starts now." : "Denied. It was stopped.",
    );
  }

  if (parts[0] === "jobs" && parts.length === 3) {
    const row = (await deps.state()).jobs.find((j) => j.id === parts[1]);
    if (row === undefined) return say(404, "No such job.");
    if (parts[2] === "stop") {
      if (!row.canStop) return say(409, "That job is not running.");
      return say(200, (await deps.stop(row.id)) ? "Stopped." : "It had already stopped.");
    }
    if (parts[2] === "retry") {
      if (!row.canRetry) return say(409, row.retryWhy ?? "It cannot be retried.");
      return say(200, await deps.retry(row.id));
    }
  }

  const post = async (id: unknown, words: string): Promise<PhoneResponse> => {
    const made = await deps.ask(typeof id === "string" ? id : "", words);
    if (!made.ok) return say(400, made.why);
    const connected = (await deps.askGet(made.ask.id)).connected;
    return {
      status: 202,
      json: { id: made.ask.id, status: made.ask.status, line: askLine(made.ask, connected) },
    };
  };

  if (parts[0] === "ask" && parts.length === 1) {
    return post(
      body["id"],
      typeof body["text"] === "string" ? body["text"].slice(0, TEXT_MAX) : "",
    );
  }

  if (parts[0] === "voice" && parts.length === 1) {
    const wav = req.bytes ?? new Uint8Array();
    const bad = checkWav(wav);
    if (bad !== null) return say(400, bad);
    const heard = await deps.transcribe(wav);
    if (!heard.ok)
      return say(heard.why.startsWith("Voice is not available") ? 501 : 422, heard.why);
    // What was heard is shown with the answer, so a mishearing is visible.
    const queued = await post(req.clientId, heard.text);
    return { status: queued.status, json: { heard: heard.text, ...queued.json } };
  }
  return say(404, "No such page.");
};

// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off
import type { HeardWord } from "@t3tools/tessaya-shared/transcriptRepair";

import type { RecogniserTurn } from "./roomVoice.ts";

/** Tessaya's recogniser (native/tessaya-recognizer) over its WebSocket protocol: words stream in, the text at the end. */
/** A turn on one recogniser, and whether it failed (refused, unreachable, or gone before the text). */
export type LiveTurn = RecogniserTurn & {
  readonly failed: () => boolean;
  /** Why it failed, as the recogniser or the socket said: a reason in the log, not just "failed". */
  readonly why?: () => string | null;
};

export const recogniserTurn = (url: string, token: string): LiveTurn => {
  const ws = new WebSocket(url, {
    headers: { authorization: `Bearer ${token}` },
  } as unknown as string[]);
  ws.binaryType = "arraybuffer";
  const queued: Uint8Array<ArrayBuffer>[] = [];
  const partialListeners: Array<(text: string) => void> = [];
  let open = false;
  let ended = false;
  let failed = false;
  let why: string | null = null;
  let answered = false;
  let scored: { readonly words: ReadonlyArray<HeardWord>; readonly model: string } | null = null;
  let lastSent = Date.now();
  // The R1 sends no mic audio while she speaks (SMP 0.3.34+), and the recogniser drops a stream silent for 2 s: a little
  // silence each second keeps his turn open across her reply.
  const keepAlive = setInterval(() => {
    if (open && !ended && Date.now() - lastSent > 1_000) {
      ws.send(new Uint8Array(640));
      lastSent = Date.now();
    }
  }, 500);
  let settle: ((text: string) => void) | null = null;
  const result = new Promise<string>((resolve) => {
    settle = resolve;
    ws.addEventListener("error", () => {
      failed = true;
      why ??= "connection error";
      resolve("");
    });
    ws.addEventListener("close", () => {
      clearInterval(keepAlive);
      if (!answered) {
        failed = true;
        why ??= "closed before the text";
      }
      resolve("");
    });
  });
  ws.addEventListener("open", () => {
    open = true;
    ws.send(JSON.stringify({ cmd: "begin", language: "en" }));
    for (const q of queued.splice(0)) ws.send(q);
    if (ended) ws.send(JSON.stringify({ cmd: "end" }));
  });
  ws.addEventListener("message", (e) => {
    if (typeof e.data !== "string") return;
    const m = JSON.parse(e.data) as {
      ev?: string;
      text?: string;
      message?: string;
      words?: ReadonlyArray<{ w?: unknown; p?: unknown }>;
      model?: unknown;
    };
    if (m.ev === "partial" && typeof m.text === "string")
      for (const l of partialListeners) l(m.text);
    if (m.ev === "text") {
      answered = true;
      scored = scoredWords(m.words, m.model);
      settle?.(m.text ?? "");
    }
    if (m.ev === "error") {
      failed = true;
      why = typeof m.message === "string" ? m.message.slice(0, 80) : "error";
      settle?.("");
    }
    if (m.ev === "text" || m.ev === "error") ws.close();
  });
  return {
    feed: (pcm) => {
      const bytes = new Uint8Array(pcm.byteLength);
      bytes.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength));
      if (open) ws.send(bytes);
      else queued.push(bytes);
      lastSent = Date.now();
    },
    finish: () => {
      ended = true;
      if (open) ws.send(JSON.stringify({ cmd: "end" }));
      return result;
    },
    cancel: () => ws.close(),
    onPartial: (listener) => void partialListeners.push(listener),
    words: () => scored,
    failed: () => failed,
    why: () => why,
  };
};

/** The recogniser's `words` ([{w, p}], p null where it has none) and `model`, or null for anything else. */
export const scoredWords = (
  words: unknown,
  model: unknown,
): { readonly words: ReadonlyArray<HeardWord>; readonly model: string } | null => {
  if (!Array.isArray(words) || words.length === 0 || typeof model !== "string") return null;
  const out: HeardWord[] = [];
  for (const x of words as ReadonlyArray<{ w?: unknown; p?: unknown }>) {
    if (typeof x?.w !== "string") return null;
    out.push({ text: x.w, p: typeof x.p === "number" && x.p >= 0 && x.p <= 1 ? x.p : null });
  }
  return { words: out, model };
};

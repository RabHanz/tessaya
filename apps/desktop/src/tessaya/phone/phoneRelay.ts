// @effect-diagnostics globalTimers:off cryptoRandomUUID:off
/**
 * The desktop's end of the phone relay: it takes what the phone asked from the server, runs it through the one assistant exactly
 * like a typed Ask, and sends the short reply and the card text back. It also mirrors the questions it asks him to the phone.
 * It never throws; a server that does not answer just means the desktop is away.
 */
import type { AskSource } from "@t3tools/tessaya-shared/phoneRelay";

import type { PhoneMirror } from "../screen/ScreenCompanion.ts";

export type PhoneCall = (op: string, args: Record<string, unknown>) => Promise<unknown>;

const POLL_MS = 1_500;

/**
 * How long to wait before looking at the inbox again: quick while things are happening, slower the longer nothing does. A phone ask
 * after a quiet hour waits at most the longest delay, still inside the server's 45 s "connected" window.
 */
export const nextPollMs = (quietTicks: number, heldMs = 0): number =>
  // A server that held the take open has already waited; look again at once (13 Nov: the R1's ask sat up to 30 s).
  heldMs >= TAKE_WAIT_MS / 2 ? 0 : quietTicks < 12 ? 5_000 : quietTicks < 60 ? 15_000 : 30_000;

/** How long the server holds an empty take open for the next ask; an older server answers at once. */
export const TAKE_WAIT_MS = 10_000;

/** A relay call that has not answered by then is a failed one: the loop goes on and the main thread is never held. */
export const PHONE_CALL_TIMEOUT_MS = 20_000;

/**
 * The relay's call into the app: asks only while the app's window is up, never inspecting windows synchronously (an
 * 81 s main-thread freeze sat in that check), gives up after a timeout, and marks its start and end so a stall names it.
 * Whatever goes wrong, including a synchronous throw, comes back as a rejected promise.
 */
export const guardedPhoneCall =
  (input: {
    readonly windowUp: () => Promise<boolean>;
    readonly request: PhoneCall;
    readonly mark: (name: string, detail?: Record<string, unknown>) => void;
    readonly timeoutMs?: number;
  }): PhoneCall =>
  async (op, args) => {
    input.mark("phone-call:begin", { op });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!(await input.windowUp())) throw new Error("The app window is not open.");
      return await Promise.race([
        input.request(op, args),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("The app did not answer the phone relay in time.")),
            input.timeoutMs ?? PHONE_CALL_TIMEOUT_MS,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      input.mark("phone-call:end");
    }
  };

/** How often a running ask's lease is renewed: well inside the server's lease. */
export const RENEW_MS = 60_000;
/** Device asks the relay holds at once (running or waiting their turn). */
const MAX_WORKING = 3;

export const createPhoneRelay = (input: {
  readonly call: PhoneCall;
  /** The assistant, as a typed Ask; "device" words are a token's, never his own. */
  readonly run: (
    text: string,
    source: AskSource,
    /** The device he said it to ("Tessel"), when it came through one. */
    origin: string | null,
    /** Said in his own verified voice on that device. */
    hisVoice: boolean,
  ) => Promise<{ readonly spoken: string; readonly card: string }>;
  readonly wait?: (ms: number) => Promise<void>;
  readonly newId?: () => string;
  /** False while the one brain on his server answers asks (SPINE-UNIFY S6): this desktop takes none. */
  readonly taking?: () => boolean;
  /** Calls `renew` every so often until stopped; a minute of real time unless a test drives it. */
  readonly every?: (ms: number, run: () => void) => () => void;
}) => {
  const every =
    input.every ??
    ((ms: number, run: () => void) => {
      const timer = setInterval(run, ms);
      timer.unref?.();
      return () => clearInterval(timer);
    });
  const working = new Set<Promise<unknown>>();
  /** Runs one taken ask to its answer, keeping its lease while it runs so it is never taken twice. */
  const handle = async (item: {
    id: string;
    text: string;
    source: AskSource;
    origin: string | null;
    hisVoice: boolean;
  }) => {
    const stop = every(
      RENEW_MS,
      () => void input.call("renew", { id: item.id }).catch(() => undefined),
    );
    try {
      const reply = await input.run(item.text, item.source, item.origin, item.hisVoice);
      await input.call("answer", { id: item.id, spoken: reply.spoken, card: reply.card });
      return "answered" as const;
    } catch {
      await input
        .call("fail", { id: item.id, message: "Tessaya could not do that just now." })
        .catch(() => undefined);
      return "failed" as const;
    } finally {
      stop();
    }
  };
  const wait = input.wait ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const newId = input.newId ?? (() => `d-${globalThis.crypto.randomUUID()}`);
  let busy = false;

  /** One look at the inbox. "away" means the server did not answer. */
  const tick = async (): Promise<"idle" | "answered" | "failed" | "away" | "busy" | "started"> => {
    if (busy) return "busy";
    if (input.taking?.() === false) return "idle";
    // A flood of device asks waits on the server, not here, where each would be renewed until its turn.
    if (working.size >= MAX_WORKING) return "busy";
    busy = true;
    try {
      let item: {
        id?: unknown;
        text?: unknown;
        source?: unknown;
        origin?: unknown;
        hisVoice?: unknown;
      } | null;
      try {
        item = (await input.call("take", { waitMs: TAKE_WAIT_MS })) as typeof item;
      } catch {
        return "away";
      }
      if (item === null || typeof item.id !== "string" || typeof item.text !== "string")
        return "idle";
      // Only the server's "phone" is his; anything else, or an older server's silence, is a device's.
      const source: AskSource = item.source === "phone" ? "phone" : "device";
      const ask = {
        id: item.id,
        text: item.text,
        source,
        origin: typeof item.origin === "string" ? item.origin.slice(0, 40) : null,
        hisVoice: item.hisVoice === true,
      };
      if (source === "phone") return await handle(ask);
      // A device's ask waits its turn behind him (turnLock.ts); his next phone ask is not held behind it.
      const running = handle(ask);
      working.add(running);
      void running.finally(() => working.delete(running));
      return "started";
    } finally {
      busy = false;
    }
  };

  /** Shows the question on the phone until it is answered there or closed here. */
  const mirror: PhoneMirror = (question) => {
    const id = newId();
    let open = true;
    const answer = new Promise<number>((resolve) => {
      void (async () => {
        try {
          await input.call("prompt", { id, ...question, buttons: [...question.buttons] });
        } catch {
          return;
        }
        while (open) {
          await wait(POLL_MS);
          if (!open) return;
          const got = await input.call("promptPoll", { id }).catch(() => null);
          if (typeof got === "number") return resolve(got);
        }
      })();
    });
    return {
      answer,
      close: () => {
        open = false;
        void input.call("promptClose", { id }).catch(() => undefined);
      },
    };
  };

  return {
    tick,
    mirror,
    /** Resolves once every device ask the relay started has been answered or failed. */
    settled: async (): Promise<void> => {
      await Promise.allSettled(working);
    },
  };
};

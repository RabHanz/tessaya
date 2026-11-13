type ClerkStatus = "loading" | "ready" | "degraded" | "error" | (string & {});

export interface ClerkStatusSource {
  readonly status: ClerkStatus;
  readonly on: (event: "status", listener: (status: ClerkStatus) => void) => void;
  readonly off: (event: "status", listener: (status: ClerkStatus) => void) => void;
}

const RELOADS_KEY = "t3code:clerk-load-reloads";
const MAX_RELOADS = 3;
const BASE_DELAY_MS = 15_000;

/**
 * Clerk loads once per renderer and never retries a failed load (a network blip
 * at launch), which leaves every relay environment "waiting for sign-in" until
 * the app restarts. Reloads the renderer with backoff, at most three times per
 * window, and forgets the count once Clerk is ready.
 */
export function recoverFailedClerkLoad(
  clerk: ClerkStatusSource,
  {
    reload = () => window.location.reload(),
    getStorage = () => window.sessionStorage,
    schedule = (run: () => void, delayMs: number) => {
      const timer = window.setTimeout(run, delayMs);
      return () => window.clearTimeout(timer);
    },
  }: {
    readonly reload?: () => void;
    readonly getStorage?: () => Pick<Storage, "getItem" | "setItem" | "removeItem">;
    readonly schedule?: (run: () => void, delayMs: number) => () => void;
  } = {},
): () => void {
  let cancel: (() => void) | undefined;
  const onStatus = (status: ClerkStatus) => {
    try {
      if (status === "ready" || status === "degraded") {
        cancel?.();
        cancel = undefined;
        getStorage().removeItem(RELOADS_KEY);
        return;
      }
      if (status !== "error" || cancel !== undefined) return;
      const reloads = Number(getStorage().getItem(RELOADS_KEY) ?? "0");
      if (!(reloads < MAX_RELOADS)) return;
      cancel = schedule(
        () => {
          getStorage().setItem(RELOADS_KEY, String(reloads + 1));
          reload();
        },
        BASE_DELAY_MS * 2 ** reloads,
      );
    } catch {
      // Without storage the reload count cannot stop a loop, so do not reload.
    }
  };
  clerk.on("status", onStatus);
  onStatus(clerk.status);
  return () => {
    clerk.off("status", onStatus);
    cancel?.();
  };
}

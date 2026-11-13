import { toastManager } from "~/components/ui/toast";

type ClerkStatus = "loading" | "ready" | "degraded" | "error" | (string & {});

export interface ClerkStatusSource {
  readonly status: ClerkStatus;
  readonly on: (event: "status", listener: (status: ClerkStatus) => void) => void;
  readonly off: (event: "status", listener: (status: ClerkStatus) => void) => void;
}

const RELOADS_KEY = "t3code:clerk-load-reloads";
const REFUSED_SENDER = "did not originate from a window's main frame";

interface ClerkElectronBridge {
  readonly tokenCache: { readonly getToken: (key: string) => Promise<unknown> };
}

/** Desktop's main process refuses Clerk's token store to any renderer it does not trust, so a reload cannot help there. */
async function isClerkSenderRefused(): Promise<boolean> {
  const bridge = (window as { __clerk_internal_electron?: ClerkElectronBridge })
    .__clerk_internal_electron;
  if (bridge === undefined) return false;
  try {
    await bridge.tokenCache.getToken("t3code:sender-probe");
    return false;
  } catch (error) {
    return String(error).includes(REFUSED_SENDER);
  }
}

function reportRefusedSender(): void {
  toastManager.add({
    type: "error",
    title: "T3 Connect can't sign in here",
    description: "Open T3's own window to reach environments that use T3 Connect.",
  });
}
const MAX_RELOADS = 3;
const BASE_DELAY_MS = 15_000;

/**
 * Clerk never retries a failed load, so every relay environment would wait for sign-in until restart.
 * Reloads with backoff, at most three times per window; forgets the count once Clerk is ready.
 * A renderer refused Clerk's token store never reloads, and says so once instead.
 */
export function recoverFailedClerkLoad(
  clerk: ClerkStatusSource,
  {
    reload = () => window.location.reload(),
    senderRefused = isClerkSenderRefused,
    onSenderRefused = reportRefusedSender,
    getStorage = () => window.sessionStorage,
    schedule = (run: () => void, delayMs: number) => {
      const timer = window.setTimeout(run, delayMs);
      return () => window.clearTimeout(timer);
    },
  }: {
    readonly reload?: () => void;
    readonly senderRefused?: () => Promise<boolean>;
    readonly onSenderRefused?: () => void;
    readonly getStorage?: () => Pick<Storage, "getItem" | "setItem" | "removeItem">;
    readonly schedule?: (run: () => void, delayMs: number) => () => void;
  } = {},
): () => void {
  let cancel: (() => void) | undefined;
  let checking = false;
  let refused = false;
  let stopped = false;
  let current = clerk.status;
  const onStatus = (status: ClerkStatus) => {
    current = status;
    try {
      if (status === "ready" || status === "degraded") {
        cancel?.();
        cancel = undefined;
        getStorage().removeItem(RELOADS_KEY);
        return;
      }
      if (status !== "error" || cancel !== undefined || checking || refused) return;
      checking = true;
      void senderRefused().then(
        (isRefused) => {
          checking = false;
          if (stopped) return;
          if (isRefused) {
            refused = true;
            onSenderRefused();
          } else scheduleReload();
        },
        () => {
          checking = false;
          scheduleReload();
        },
      );
    } catch {
      // Without storage the reload count cannot stop a loop, so do not reload.
    }
  };
  const scheduleReload = () => {
    try {
      if (stopped || cancel !== undefined || current !== "error") return;
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
    stopped = true;
    clerk.off("status", onStatus);
    cancel?.();
  };
}

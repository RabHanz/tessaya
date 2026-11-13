// @effect-diagnostics globalTimers:off
/**
 * The desktop's end of remote hands: a long poll to the hub for the next call, run it behind the gate, send the answer back.
 * It never throws, and it polls only while the Director has remote hands on; a hub that does not answer is waited out.
 */
import type { HandsCall, HandsResult, HandsToolSpec } from "@t3tools/baton-shared/remoteHands";

export type HubPost = (
  path: "take" | "reply",
  body: unknown,
) => Promise<{ readonly status: number; readonly json: unknown }>;

const OFF_WAIT_MS = 5_000;
const AWAY_WAIT_MS = 3_000;

export const createRemoteHandsLoop = (input: {
  readonly post: HubPost;
  readonly enabled: () => boolean;
  readonly run: (call: Pick<HandsCall, "tool" | "args" | "origin">) => Promise<HandsResult>;
  /** What this desktop offers a brain turn; sent with a take only when it changed. */
  readonly offered?: () => ReadonlyArray<HandsToolSpec>;
  readonly wait?: (ms: number) => Promise<void>;
}) => {
  const wait = input.wait ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  let running = false;
  let sent: string | null = null;

  /** One look at the hub. "away" means the hub did not answer. */
  const tick = async (): Promise<"off" | "idle" | "ran" | "away"> => {
    if (!input.enabled()) return "off";
    let call: HandsCall | null;
    try {
      const tools = input.offered?.() ?? [];
      const offer = JSON.stringify(tools);
      const taken = await input.post("take", offer === sent ? {} : { tools });
      // A server that went away may have restarted and forgotten the offer: send it again.
      if (taken.status !== 200) {
        sent = null;
        return "away";
      }
      sent = offer;
      call = (taken.json as { call?: HandsCall | null }).call ?? null;
    } catch {
      sent = null;
      return "away";
    }
    if (call === null) return "idle";
    const result = await input
      .run({
        tool: call.tool,
        args: call.args,
        ...(call.origin === undefined ? {} : { origin: call.origin }),
      })
      .catch((e: unknown): HandsResult => ({
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      }));
    await input.post("reply", { id: call.id, result }).catch(() => undefined);
    return "ran";
  };

  return {
    tick,
    start: () => {
      if (running) return;
      running = true;
      void (async () => {
        while (running) {
          const outcome = await tick();
          if (outcome === "off") await wait(OFF_WAIT_MS);
          else if (outcome === "away") await wait(AWAY_WAIT_MS);
        }
      })();
    },
    stop: () => void (running = false),
  };
};

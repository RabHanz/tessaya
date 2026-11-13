// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off
/**
 * The live suite through his desktop's Tessaya (`live.ts --vessel desktop`): the assistant as it ships (its prompt,
 * its tool table and a real `claude -p` on your own login), with the server's shared tools run on that server as the
 * desktop's caller, always a rehearsal (`/tessaya/rehearse`, behind the R1's device key). Its own screen, memory and
 * job tools are refused, so a case that only they could answer is not applicable here.
 */
import { replayTurn } from "../../apps/desktop/src/baton/agent/replay.ts";
import {
  buildBatonTools,
  type SharedToolSpec,
  type ToolHost,
} from "../../apps/desktop/src/baton/agent/batonTools.ts";
import { DEFAULT_OS_PACK, modelOf } from "../../packages/baton-shared/src/osPack.ts";
import { chooseTurnBrain } from "../../packages/baton-shared/src/turnTier.ts";
import type { LiveCall } from "./liveCases.ts";

/** The server's shared tools as the desktop's caller, each call recorded as the suite's trace reads it. */
export const desktopVessel = async (input: {
  readonly server: string;
  readonly key: string;
  readonly claude: string;
  readonly model?: string | undefined;
}) => {
  const post = async (op: string, body: unknown) => {
    const response = await fetch(`${input.server}/tessaya/rehearse/baton.tools.${op}`, {
      method: "POST",
      headers: { authorization: `Bearer ${input.key}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`);
    return ((await response.json()) as { value: unknown }).value;
  };
  const specs = ((await post("list", {})) as { tools: ReadonlyArray<SharedToolSpec> }).tools;
  const sharedOf = (calls: Array<LiveCall>): NonNullable<ToolHost["shared"]> => ({
    specs,
    call: async (name, args) => {
      const out = (await post("call", { name, args })) as { text: string; isError: boolean };
      calls.push({ name, input: args, isError: out.isError, text: out.text });
      if (out.isError) throw new Error(out.text);
      return out.text;
    },
  });
  /** The shared tools her table shows (its own tools cover the rest), for whether a case can run here. */
  const offered = new Set(
    buildBatonTools({ shared: sharedOf([]) } as ToolHost)
      .filter((t) => t.shared !== undefined)
      .map((t) => t.name),
  );
  /** One case's sentences in one session, as he would say them to his desktop. */
  const say = async (sentences: ReadonlyArray<string>) => {
    const calls: Array<LiveCall> = [];
    const started = Date.now();
    const brain = chooseTurnBrain(sentences[0]!, modelOf(DEFAULT_OS_PACK, "executive")).brain;
    const ran = await replayTurn({
      claudeBinary: input.claude,
      brain: { model: input.model ?? brain.model, effort: brain.effort },
      said: sentences[0]!,
      again: sentences.slice(1),
      now: { at: new Date(), timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
      where: { window: "Notepad", session: null },
      shared: sharedOf(calls),
      env: process.env,
      // oxlint-disable-next-line t3code/no-global-process-runtime -- a plain script, not Effect code
      platform: process.platform,
    });
    return { replies: ran.replies, calls, ms: [Date.now() - started] };
  };
  return { offered, say, call: sharedOf([]).call };
};

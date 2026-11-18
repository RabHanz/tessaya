// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalJsonInEffect:off
/**
 * Her words while a slow answer is still coming (B-056, the Director 19 Nov: "even fillers should come from the context
 * of what was being talked about"). A warm Haiku process is waiting; at a turn's start it is given his words and the
 * talk just before, and writes one short bridge about them in her voice. The turn says it only if her answer has not
 * started by the hold point, never one she said lately on that vessel, and nothing at all when the call fails.
 */
import * as NodeChildProcess from "node:child_process";

import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { BrainUsage, cliTokens, ledgeredCwd } from "../tessaya/BrainUsage.ts";
import { readLine } from "./R1Brain.ts";

const MODEL = "haiku";
/** A warm process older than this is replaced, as the voice sessions are. */
const MAX_IDLE_MS = 10 * 60_000;
/** The lines kept per vessel so none is said twice in a session. */
const RECENT = 40;

const BRIDGE_SYSTEM = [
  "You write one short spoken line for a voice assistant to say while her real answer is still coming.",
  "It is about what he just said: name his topic in her own words, the way a person thinking aloud would.",
  'Examples of the shape (never reuse them): "Ooh, the thermostat, let me see what it\'s up to." "Right, the checkout bug from last night."',
  "Rules: 3 to 12 words, one sentence, spoken English, no lists or markdown.",
  "Never answer the question, never guess the answer, never promise or claim progress (no done, almost, nearly, soon, got it).",
  'Never say the act is happening or will happen ("bumping it up", "setting it now", "turning it on"): the act may fail. Muse on his topic instead.',
  'Make it about his exact words, not generic ("checking that for you", "looking into it" are generic).',
  'Never a stock filler on its own ("one moment", "just a second", "hold on", "let me check", "good question", "hmm").',
  "Reply with the line only.",
].join("\n");

/** The prompt for one turn: who she is, the talk just before, and his words. */
export const bridgePrompt = (input: {
  readonly persona?: string | undefined;
  readonly words: string;
  readonly before: ReadonlyArray<{ readonly role: string; readonly content: string }>;
  readonly recent: ReadonlyArray<string>;
}) =>
  [
    `You are ${input.persona ?? "Tessaya"}.`,
    ...(input.before.length === 0
      ? []
      : [
          `The talk just before: ${input.before
            .map((m) => `${m.role === "user" ? "He" : "She"}: ${m.content.slice(0, 200)}`)
            .join(" / ")}`,
        ]),
    ...(input.recent.length === 0
      ? []
      : [`Lines she already said; write a different one: ${input.recent.slice(-8).join(" | ")}`]),
    `He just said: ${input.words.slice(0, 400)}`,
  ].join("\n");

const STOCK =
  /^(?:one moment|just a (?:moment|second|sec)|hold on|one sec(?:ond)?|let me (?:check|see|look|think)|good question|hmm+|okay|ok|right|sure|checking)[.!…]*$/i;
const PROMISES =
  /\b(?:almost|nearly|coming|soon|shortly|promise|done|sorted|ready|got it|have it|right up|getting (?:there|that))\b/i;
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, "")
    .trim();

/** The line as she may say it, or null: one sentence of 3-12 words, not stock, no promise, not one said lately. */
export const keptBridge = (text: string, recent: ReadonlyArray<string>): string | null => {
  const line = text
    .trim()
    .replace(/^["']|["']$/g, "")
    .split("\n")[0]!
    .trim();
  const words = line.split(/\s+/).filter(Boolean).length;
  if (words < 3 || words > 12 || STOCK.test(line) || PROMISES.test(line)) return null;
  if (recent.some((r) => norm(r) === norm(line))) return null;
  return line;
};

export class R1Hold extends Context.Service<
  R1Hold,
  {
    /** Her bridge for this turn on `vessel`, or null when none came or none fits. Never fails. */
    readonly write: (input: {
      readonly vessel: string;
      readonly persona?: string | undefined;
      readonly words: string;
      readonly before: ReadonlyArray<{ readonly role: string; readonly content: string }>;
    }) => Effect.Effect<string | null>;
  }
>()("t3/home/R1Hold") {}

interface Warm {
  readonly proc: NodeChildProcess.ChildProcess;
  readonly bornAt: number;
  onLine: (line: string) => void;
  onExit: () => void;
}

export const layer = Layer.effect(
  R1Hold,
  Effect.gen(function* () {
    const usage = yield* BrainUsage;
    const context = yield* Effect.context<never>();
    const recent = new Map<string, Array<string>>();
    const spawn = (): Warm => {
      const proc = NodeChildProcess.spawn(
        "claude",
        [
          "-p",
          "--input-format",
          "stream-json",
          "--output-format",
          "stream-json",
          "--include-partial-messages",
          "--verbose",
          "--model",
          MODEL,
          "--system-prompt",
          BRIDGE_SYSTEM,
          "--settings",
          JSON.stringify({ disableAllHooks: true, alwaysThinkingEnabled: false }),
          "--tools",
          "",
          "--disable-slash-commands",
          "--strict-mcp-config",
          "--permission-mode",
          "dontAsk",
          "--setting-sources",
          "",
        ],
        { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, cwd: ledgeredCwd() },
      );
      const warm: Warm = {
        proc,
        bornAt: Date.now(),
        onLine: () => undefined,
        onExit: () => undefined,
      };
      let buf = "";
      proc.stdout?.setEncoding("utf8");
      proc.stdout?.on("data", (chunk: string) => {
        buf += chunk;
        for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
          warm.onLine(buf.slice(0, nl));
          buf = buf.slice(nl + 1);
        }
      });
      proc.on("exit", () => warm.onExit());
      proc.on("error", () => undefined);
      return warm;
    };
    let ready: Warm | null = null;
    const take = () => {
      const old = ready;
      ready = null;
      if (old !== null && old.proc.exitCode === null && Date.now() - old.bornAt < MAX_IDLE_MS)
        return old;
      old?.proc.kill();
      return spawn();
    };
    yield* Effect.addFinalizer(() => Effect.sync(() => ready?.proc.kill()));

    const write: R1Hold["Service"]["write"] = (input) =>
      Effect.callback<string | null>((resume) => {
        const said = recent.get(input.vessel) ?? [];
        const warm = take();
        ready = spawn();
        let text = "";
        let settled = false;
        const end = (line: string | null) => {
          if (settled) return;
          settled = true;
          warm.proc.kill();
          const kept = line === null ? null : keptBridge(line, said);
          if (kept !== null) recent.set(input.vessel, [...said, kept].slice(-RECENT));
          resume(Effect.succeed(kept));
        };
        warm.onLine = (line) => {
          const r = readLine(line);
          if (r.result !== undefined)
            for (const tokens of cliTokens(r.result, MODEL))
              Effect.runForkWith(context)(
                usage.record({
                  ...tokens,
                  role: "voice",
                  credential: "subscription",
                  attribution: { feature: "hold", origin: "user", device: input.vessel },
                }),
              );
          if (r.delta !== undefined) text += r.delta;
          if (r.done) end(text);
          if (r.error !== undefined) end(null);
        };
        warm.onExit = () => end(null);
        warm.proc.stdin?.write(
          `${JSON.stringify({ type: "user", message: { role: "user", content: bridgePrompt({ ...input, recent: said }) } })}\n`,
        );
        return Effect.sync(() => end(null));
      });

    return R1Hold.of({ write });
  }),
);

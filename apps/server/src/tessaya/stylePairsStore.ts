// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalJsonInEffect:off
/**
 * His style pairs (his past dictations and the text he kept) beside his one dictionary on her brain:
 * `<userdata>/voice/style-pairs.json`, only his to read. The desktop sends them; a worker keeps a copy and passes them
 * on to the brain; every vessel reads his plain words from them (`ordinaryWords`, for `biasTranscript`).
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { ordinaryWords } from "@t3tools/tessaya-shared/vocabulary";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import { makeBrainLink } from "./BrainHost.ts";

/** The newest this many pairs are kept: enough for every style, small enough to count on each change. */
const MAX_PAIRS = 20_000;

/** A style pair as the desktop builds it (`stylePairs.ts`); the mode is kept as sent. */
interface StoredPair {
  readonly raw: string;
  readonly kept: string;
  readonly mode: string;
  readonly id?: string;
}

/** A pair as the desktop sends it; anything else is dropped. */
const parsePairs = (value: unknown): ReadonlyArray<StoredPair> =>
  Array.isArray(value)
    ? value.flatMap((p: unknown): ReadonlyArray<StoredPair> => {
        if (typeof p !== "object" || p === null) return [];
        const { raw, kept, mode, id } = p as Record<string, unknown>;
        if (
          typeof raw !== "string" ||
          typeof kept !== "string" ||
          raw.trim() === "" ||
          kept.trim() === ""
        )
          return [];
        if (raw.length > 4_000 || kept.length > 8_000) return [];
        return [
          {
            raw,
            kept,
            mode: typeof mode === "string" && mode.length <= 20 ? mode : "default",
            ...(typeof id === "string" && id.length <= 200 ? { id } : {}),
          },
        ];
      })
    : [];

/** New pairs replace those with the same id (or the same words), newest last, capped. */
const mergePairs = (
  stored: ReadonlyArray<StoredPair>,
  fresh: ReadonlyArray<StoredPair>,
): ReadonlyArray<StoredPair> => {
  const key = (p: StoredPair) => p.id ?? `${p.raw}\u0000${p.kept}`;
  const incoming = new Set(fresh.map(key));
  return [...stored.filter((p) => !incoming.has(key(p))), ...fresh].slice(-MAX_PAIRS);
};

const pairsFileOf = (stateDir: string) => NodePath.join(stateDir, "voice", "style-pairs.json");

const readPairs = (file: string): ReadonlyArray<StoredPair> => {
  try {
    return parsePairs(JSON.parse(NodeFS.readFileSync(file, "utf8")));
  } catch {
    return [];
  }
};

const mtimeOf = (file: string): number => {
  try {
    return NodeFS.statSync(file).mtimeMs;
  } catch {
    return 0;
  }
};

/** His plain words per file, counted again only when the file changes. */
const counted = new Map<string, { readonly at: number; readonly words: ReadonlySet<string> }>();

/** The words he writes himself, from this server's copy of his pairs; none on a server without them. */
export const ordinaryHere = Effect.gen(function* () {
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  if (Option.isNone(config)) return new Set<string>();
  const file = pairsFileOf(config.value.stateDir);
  const at = mtimeOf(file);
  const seen = counted.get(file);
  if (seen !== undefined && seen.at === at) return seen.words;
  const words = ordinaryWords(readPairs(file));
  counted.set(file, { at, words });
  return words;
}).pipe(Effect.withSpan("StylePairs.ordinary"));

/** Keeps the pairs here and, from a worker, sends them on to her brain; answers how many are kept here. */
export const storeStylePairs = Effect.fn("StylePairs.store")(function* (
  pairs: ReadonlyArray<unknown>,
) {
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  if (Option.isNone(config)) return 0;
  const file = pairsFileOf(config.value.stateDir);
  const fresh = parsePairs(pairs);
  const kept = yield* Effect.sync(() => {
    const next = mergePairs(readPairs(file), fresh);
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    const part = `${file}.${process.pid}.part`;
    // His own words: only he reads them.
    NodeFS.writeFileSync(part, JSON.stringify(next), { mode: 0o600 });
    NodeFS.renameSync(part, file);
    return next.length;
  }).pipe(Effect.orElseSucceed(() => 0));
  const brain = yield* makeBrainLink;
  // shortcut: a pair sent while her brain is away stays here until the desktop sends it again at its next start.
  if (fresh.length > 0 && !(yield* brain.isBrain))
    yield* brain.send("vocabulary", { change: null, pairs: fresh }).pipe(Effect.ignore);
  return kept;
});

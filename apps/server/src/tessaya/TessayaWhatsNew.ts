/**
 * What is new in her, kept on her brain in her self-state (TessayaSelf reads it): each release of a part of her leaves
 * a few plain-words lines for two weeks, and the first time he talks to her after one she may mention it once.
 */
import {
  ReleaseRewrite,
  WhatsNewEntries,
  keptNews,
  newsLine,
  releasePrompt,
  type WhatsNewEntry,
  type WhatsNewSurface,
} from "@t3tools/tessaya-shared/whatsNew";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { TessayaMemoryService } from "./TessayaMemoryService.ts";
import { TessayaOneShot } from "./TessayaOneShot.ts";

/** Her self-state's releases, on her brain (the memory store's meta), and when she last mentioned the newest. */
const NEWS_KEY = "self.whatsNew";
const NEWS_TOLD_KEY = "self.whatsNewTold";
const NewsJson = Schema.fromJsonString(WhatsNewEntries);
const decodeNews = Schema.decodeUnknownOption(NewsJson);
const encodeNews = Schema.encodeSync(NewsJson);

/** What is new in her lately, newest first ([] when nothing is kept or the store is not here). */
export const whatsNew = Effect.fn("TessayaSelf.whatsNew")(function* () {
  const memory = yield* Effect.serviceOption(TessayaMemoryService);
  if (Option.isNone(memory)) return [] as ReadonlyArray<WhatsNewEntry>;
  const raw = yield* memory.value.meta(NEWS_KEY);
  return raw === null ? [] : Option.getOrElse(decodeNews(raw), () => []);
});

/**
 * One release of a part of her: its merged titles rewritten for him by the model (plain words, no jargon), kept two
 * weeks. Lines written already can be passed as `items` instead. The lines kept, or none when nothing was worth saying.
 */
export const recordRelease = Effect.fn("TessayaSelf.recordRelease")(function* (input: {
  readonly surface: WhatsNewSurface;
  readonly version: string;
  readonly titles?: ReadonlyArray<string>;
  readonly items?: ReadonlyArray<string>;
}) {
  const memory = yield* Effect.serviceOption(TessayaMemoryService);
  if (Option.isNone(memory)) return [] as ReadonlyArray<string>;
  const oneShot = yield* Effect.serviceOption(TessayaOneShot);
  const rewritten =
    input.items !== undefined || Option.isNone(oneShot) || (input.titles ?? []).length === 0
      ? null
      : yield* oneShot.value
          .run({
            prompt: releasePrompt({ surface: input.surface, titles: input.titles ?? [] }),
            outputSchema: ReleaseRewrite,
            role: "intent",
            feature: "whats-new",
          })
          .pipe(Effect.orElseSucceed(() => null));
  const items = (input.items ?? rewritten?.items ?? [])
    .map((i) => i.trim().slice(0, 200))
    .filter((i) => i !== "")
    .slice(0, 6);
  if (items.length === 0) return items;
  const now = yield* Clock.currentTimeMillis;
  const kept = keptNews(
    [
      { at: now, surface: input.surface, version: input.version.slice(0, 40), items },
      ...(yield* whatsNew()),
    ],
    now,
  );
  yield* memory.value.setMeta(NEWS_KEY, encodeNews(kept));
  return items;
});

/** The turn's line once after a release (his own turns), then marked told so it is said at most once. */
export const newsOnce = Effect.fn("TessayaSelf.newsOnce")(function* () {
  const memory = yield* Effect.serviceOption(TessayaMemoryService);
  if (Option.isNone(memory)) return "";
  const now = yield* Clock.currentTimeMillis;
  const told = Number((yield* memory.value.meta(NEWS_TOLD_KEY)) ?? "0") || 0;
  const line = newsLine(yield* whatsNew(), told, now);
  if (line !== "") yield* memory.value.setMeta(NEWS_TOLD_KEY, String(now));
  return line;
});

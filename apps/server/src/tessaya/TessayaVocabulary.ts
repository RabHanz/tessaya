// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalJsonInEffect:off globalDate:off
/**
 * His one dictionary for every vessel, kept on her brain (`<userdata>/voice/dictionary.json` there). Reads add persona,
 * household and project names; T3's `speechProjectCustomWords` is derived after each change. Any other server reads
 * and changes it through the brain (`tessaya_brain` op `vocabulary`) and keeps the same file as its cache, which its
 * own dictation reads; while the brain is away it changes the cache, and its next start sends that to the brain.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { VocabularyChange } from "@t3tools/tessaya-contracts";
import {
  addEntry,
  customWordsOf,
  editEntry,
  droppedOnRead,
  mergeEntries,
  parseVocabulary,
  removeEntry,
  removeHeard,
  type VocabularyEntry,
} from "@t3tools/tessaya-shared/vocabulary";
import { NAME_SOUNDALIKES } from "@t3tools/tessaya-shared/wakeVerify";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";

import { VocabularyChange as VocabularyChangeSchema } from "@t3tools/tessaya-contracts";

import * as ServerConfig from "../config.ts";
import { emitActionSync } from "../provenance/ActionLog.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { makeBrainLink } from "./BrainHost.ts";
import { readPack } from "./OperatingSystemPack.ts";

/** The MCP tool his other servers and agents change the dictionary through. */
export const VOCABULARY_TOOL = "tessaya_vocabulary";

export class VocabularyRefusedError extends Schema.TaggedError<VocabularyRefusedError>()(
  "VocabularyRefusedError",
  { why: Schema.String },
) {
  override get message(): string {
    return this.why;
  }
}

export class TessayaVocabulary extends Context.Service<
  TessayaVocabulary,
  {
    /** His words, then the names he never typed that are not among them. */
    readonly read: Effect.Effect<ReadonlyArray<VocabularyEntry>>;
    /** His words alone, as this server's file holds them. */
    readonly stored: Effect.Effect<ReadonlyArray<VocabularyEntry>>;
    /** One change, saved; answers the whole list as `read` does. */
    readonly change: (
      change: VocabularyChange,
    ) => Effect.Effect<ReadonlyArray<VocabularyEntry>, VocabularyRefusedError>;
  }
>()("t3/tessaya/TessayaVocabulary") {}

const sameWord = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A project title worth listening for: words with a capital ("NorthWind"), never a slug or folder ("baton-media-test", "work"). */
export const spokenTitle = (title: string): boolean =>
  /^[\p{L}'’ ]+$/u.test(title.trim()) && /\p{Lu}/u.test(title);

/** A name's mis-writings from the one list (`NAME_SOUNDALIKES`), as heard forms its entry carries. */
const soundAlikes = (name: string): { readonly heard?: ReadonlyArray<string> } => {
  const heard = NAME_SOUNDALIKES[name.toLowerCase()]?.heard ?? [];
  return heard.length === 0 ? {} : { heard };
};

/** Names as entries spelt their way, leaving out any he already has (as a phrase or as what it becomes). */
export const withNames = (
  stored: ReadonlyArray<VocabularyEntry>,
  names: ReadonlyArray<string>,
): ReadonlyArray<VocabularyEntry> => {
  const has = (name: string, list: ReadonlyArray<VocabularyEntry>) =>
    list.some((e) => sameWord(e.phrase, name) || sameWord(e.replacement ?? "", name));
  const all = [...stored];
  for (const raw of names) {
    const name = raw.replace(/\s+/g, " ").trim();
    if (name.length > 0 && name.length <= 50 && /\p{L}/u.test(name) && !has(name, all))
      all.push({ phrase: name, replacement: null, ...soundAlikes(name) });
  }
  return all;
};

export const applyChange = (
  entries: ReadonlyArray<VocabularyEntry>,
  change: VocabularyChange,
): ReadonlyArray<VocabularyEntry> => {
  switch (change.verb) {
    case "add":
      return addEntry(entries, change);
    case "edit":
      return editEntry(entries, change.from, change);
    case "remove":
      // T3's list names a word by how it is written, which is the replacement of a heard-as entry.
      return removeEntry(entries, change.phrase).filter(
        (e) => !sameWord(e.replacement ?? "", change.phrase),
      );
    case "unhear":
      return removeHeard(entries, change.phrase, change.form).filter(
        (e) => !(sameWord(e.phrase, change.form) && sameWord(e.replacement ?? "", change.phrase)),
      );
    case "learn":
      return mergeEntries(entries, parseVocabulary(change.entries));
  }
};

/** Entries dropped on read, kept with when and why so he can add them back; never deleted. */
const removedFile = (file: string) =>
  NodePath.join(NodePath.dirname(file), "dictionary-removed.json");

const readRemoved = (file: string): ReadonlyArray<VocabularyEntry> => {
  try {
    const value: unknown = JSON.parse(NodeFS.readFileSync(removedFile(file), "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
};

/** Puts each entry the read drops into the removed list once, and records it, before any write can lose it. */
const keepDropped = (file: string, value: unknown) => {
  const removed = readRemoved(file);
  const fresh = droppedOnRead(value).filter(
    (d) =>
      !removed.some(
        (r) => sameWord(r.phrase, d.phrase) && (r.replacement ?? null) === (d.replacement ?? null),
      ),
  );
  if (fresh.length === 0) return;
  const removedAt = new Date().toISOString();
  const why = "an ordinary word learned from one fix";
  writeStored(removedFile(file), [...removed, ...fresh.map((e) => ({ ...e, removedAt, why }))]);
  for (const e of fresh)
    emitActionSync({
      kind: "vocabulary.drop",
      actor: { kind: "rule", id: "plain-learned-word", certainty: 1 },
      subject: e.replacement === null ? e.phrase : `${e.phrase} -> ${e.replacement}`,
      outcome: "removed",
      evidence: [{ kind: "file", ref: removedFile(file) }],
      data: { entry: e, why },
    });
};

/** A list item that is not an entry (PowerShell 5.1 wrote the whole list as one, 17 Nov) means a damaged file. */
const isEntryItem = (item: unknown) =>
  typeof item === "object" &&
  item !== null &&
  typeof (item as { phrase?: unknown }).phrase === "string";

/** The stored list; null when the file is there but is not a list of entries, so nothing overwrites what he can still mend. */
const readStored = (file: string): ReadonlyArray<VocabularyEntry> | null => {
  let text: string;
  try {
    text = NodeFS.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  try {
    const value: unknown = JSON.parse(text);
    if (!Array.isArray(value) || !value.every(isEntryItem)) return null;
    keepDropped(file, value);
    return parseVocabulary(value);
  } catch {
    return null;
  }
};

const writeStored = (file: string, entries: ReadonlyArray<VocabularyEntry>) => {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  const part = `${file}.${process.pid}.part`;
  NodeFS.writeFileSync(part, `${JSON.stringify(entries, null, 2)}\n`);
  NodeFS.renameSync(part, file);
};

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* Effect.serviceOption(ServerSettingsService);
  const sql = yield* Effect.serviceOption(SqlClient.SqlClient);
  const file = NodePath.join(config.stateDir, "voice", "dictionary.json");
  const oneAtATime = yield* Semaphore.make(1);
  const brain = yield* makeBrainLink;
  /** This server's own words have reached the brain; false at start and after a change made while it was away. */
  let uploaded = false;
  /** The brain's list after `change` (none: just read), cached here; None on the brain or while it can't be reached. */
  const atBrain = Effect.fn("TessayaVocabulary.atBrain")(
    function* (change: VocabularyChange | null) {
      if (yield* brain.isBrain) return Option.none<ReadonlyArray<VocabularyEntry>>();
      // His words here go up before the brain's list may replace this file, so none is lost to the cache.
      // shortcut: additive, so a word removed here while the brain was away stays there; a tombstone list would carry it.
      if (!uploaded) {
        const mine = readStored(file);
        if (mine === null) return Option.none<ReadonlyArray<VocabularyEntry>>();
        if (
          mine.length > 0 &&
          Option.isNone(
            yield* brain.send("vocabulary", { change: { verb: "learn", entries: mine } }),
          )
        )
          return Option.none<ReadonlyArray<VocabularyEntry>>();
        uploaded = true;
      }
      const answer = Option.flatMap(yield* brain.send("vocabulary", { change }), decodeAtBrain);
      if (Option.isNone(answer)) return Option.none<ReadonlyArray<VocabularyEntry>>();
      const stored = parseVocabulary(answer.value.stored);
      yield* oneAtATime.withPermits(1)(
        Effect.sync(() => {
          const here = readStored(file);
          // A file it cannot read is left for him to mend; the first time the cache replaces his own file, a copy stays.
          if (here !== null && JSON.stringify(here) !== JSON.stringify(stored)) {
            const kept = NodePath.join(NodePath.dirname(file), "dictionary.before-brain.json");
            if (here.length > 0 && !NodeFS.existsSync(kept)) NodeFS.copyFileSync(file, kept);
            writeStored(file, stored);
          }
        }),
      );
      return Option.some(parseVocabulary(answer.value.all));
    },
    Effect.orElseSucceed(() => Option.none<ReadonlyArray<VocabularyEntry>>()),
  );

  const rows = <E>(query: Effect.Effect<ReadonlyArray<{ readonly name: unknown }>, E>) =>
    query.pipe(
      Effect.map((all) => all.flatMap((r) => (typeof r.name === "string" ? [r.name] : []))),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
    );
  const projectTitles = Option.isNone(sql)
    ? Effect.succeed<ReadonlyArray<string>>([])
    : rows(
        sql.value<{
          name: unknown;
        }>`SELECT title AS name FROM projection_projects WHERE deleted_at IS NULL AND archived_at IS NULL ORDER BY created_at`,
      );
  // shortcut: a household kept on a linked home server is not read here; read it through TessayaHousehold when one is.
  const names = Effect.gen(function* () {
    const personas = readPack(config.stateDir).personas.map((p) => p.name);
    if (Option.isNone(sql)) return personas;
    const [members, projects] = yield* Effect.all([
      rows(
        sql.value<{
          name: unknown;
        }>`SELECT name FROM tessaya_household_members WHERE removed_at IS NULL ORDER BY created_at`,
      ),
      projectTitles,
    ]);
    return [...personas, ...members, ...projects.filter(spokenTitle)];
  });

  const readHere = Effect.gen(function* () {
    return withNames(readStored(file) ?? [], yield* names);
  });
  const read = Effect.gen(function* () {
    const there = yield* atBrain(null);
    return Option.isSome(there) ? there.value : yield* readHere;
  }).pipe(Effect.withSpan("TessayaVocabulary.read"));

  /** T3's list follows his: written only when it differs, so a settings watcher wakes only for a real change. */
  const deriveCustomWords = Effect.fn("TessayaVocabulary.deriveCustomWords")(function* (
    all: ReadonlyArray<VocabularyEntry>,
  ) {
    if (Option.isNone(settings)) return;
    const next = customWordsOf(all);
    const current = yield* settings.value.getSettings;
    if (JSON.stringify(current.speechProjectCustomWords) === JSON.stringify(next)) return;
    yield* settings.value.updateSettings({ speechProjectCustomWords: next });
  });

  const change = Effect.fn("TessayaVocabulary.change")(function* (input: VocabularyChange) {
    const there = yield* atBrain(input);
    if (Option.isSome(there)) {
      yield* deriveCustomWords(there.value).pipe(Effect.ignore);
      return there.value;
    }
    const all = yield* oneAtATime.withPermits(1)(
      Effect.gen(function* () {
        // Re-read each time: the desktop writes the same file on his own machine.
        const stored = readStored(file);
        if (stored === null)
          return yield* new VocabularyRefusedError({
            why: "The dictionary file could not be read, so nothing was changed.",
          });
        const next = applyChange(stored, input);
        yield* Effect.try({
          try: () => writeStored(file, next),
          catch: () => new VocabularyRefusedError({ why: "The dictionary could not be saved." }),
        });
        return withNames(next, yield* names);
      }),
    );
    // Made here while her brain was away: it goes up with his other words at the next reach.
    if (!(yield* brain.isBrain)) uploaded = false;
    yield* deriveCustomWords(all).pipe(Effect.ignore);
    return all;
  });

  // Words typed into T3's own list before this store existed join it once; after that the list is derived from it.
  const adopt = Effect.gen(function* () {
    if (Option.isNone(settings)) return;
    const words = (yield* settings.value.getSettings).speechProjectCustomWords;
    // A slug title that reached T3's list or the file before titles were filtered is no word of his.
    const titles = yield* projectTitles;
    const slug = (word: string) => titles.some((t) => sameWord(t, word) && !spokenTitle(t));
    for (const e of readStored(file) ?? [])
      if (e.replacement === null && slug(e.phrase))
        yield* change({ verb: "remove", phrase: e.phrase });
    const known = yield* read;
    const removed = readRemoved(file);
    const extra = words.filter(
      (w) =>
        !slug(w.term) &&
        // A word the store dropped is not taken back as his own (0.1.147 brought back "pass" and "new").
        !removed.some((e) => sameWord(e.replacement ?? e.phrase, w.term)) &&
        !known.some((e) => sameWord(e.phrase, w.term) || sameWord(e.replacement ?? "", w.term)),
    );
    if (extra.length > 0)
      yield* change({
        verb: "learn",
        entries: extra.map((w) => ({ phrase: w.term, replacement: null, heard: w.aliases })),
      });
    else yield* deriveCustomWords(known);
  });
  yield* adopt.pipe(Effect.ignore);

  const stored = Effect.sync(() => readStored(file) ?? []);
  return TessayaVocabulary.of({ read, stored, change });
});

export const layer = Layer.effect(TessayaVocabulary, make);

/** What a worker sends her brain (`tessaya_brain` op `vocabulary`), and what the brain answers. */
export const VocabularyAtBrain = Schema.Struct({
  change: Schema.NullOr(VocabularyChangeSchema),
  /** Style pairs a worker took from a desktop, for her brain's copy (`stylePairsStore.ts`). */
  pairs: Schema.optionalKey(Schema.Array(Schema.Unknown).check(Schema.isMaxLength(2_000))),
});
const decodeAtBrain = Schema.decodeUnknownOption(
  Schema.Struct({ stored: Schema.Array(Schema.Unknown), all: Schema.Array(Schema.Unknown) }),
);

// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalJsonInEffect:off
/**
 * His one dictionary for every vessel: `<userdata>/voice/dictionary.json`, the file desktop dictation keeps on its own
 * machine. Reads add persona, household and project names; T3's `speechProjectCustomWords` is derived after each change.
 * Changes go to his other servers (`tessaya_vocabulary`), and each start sends them the whole list to merge.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { VocabularyChange } from "@t3tools/tessaya-contracts";
import {
  addEntry,
  customWordsOf,
  editEntry,
  mergeEntries,
  parseVocabulary,
  removeEntry,
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

import * as ServerConfig from "../config.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { fromPeers } from "../peer/PeerVessels.ts";
import { ServerSettingsService } from "../serverSettings.ts";
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
    /** One change, saved; answers the whole list as `read` does. */
    readonly change: (
      change: VocabularyChange,
    ) => Effect.Effect<ReadonlyArray<VocabularyEntry>, VocabularyRefusedError>;
  }
>()("t3/tessaya/TessayaVocabulary") {}

const sameWord = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

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
      return removeEntry(entries, change.phrase);
    case "learn":
      return mergeEntries(entries, parseVocabulary(change.entries));
  }
};

/** The stored list; null when the file is there but is not a list, so nothing overwrites what he can still mend. */
const readStored = (file: string): ReadonlyArray<VocabularyEntry> | null => {
  let text: string;
  try {
    text = NodeFS.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  try {
    const value: unknown = JSON.parse(text);
    return Array.isArray(value) ? parseVocabulary(value) : null;
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
  const links = yield* Effect.serviceOption(PeerLinks.PeerLinks);
  const peerMcp = yield* Effect.serviceOption(PeerMcpClient.PeerMcpClient);

  /** The same change on his other servers; a change a linked server sent is never sent on (`fromPeers`). */
  const toPeers = (sent: VocabularyChange) =>
    Option.isNone(links) || Option.isNone(peerMcp)
      ? Effect.void
      : fromPeers(VOCABULARY_TOOL, { change: sent }, "10 seconds").pipe(
          Effect.provideService(PeerLinks.PeerLinks, links.value),
          Effect.provideService(PeerMcpClient.PeerMcpClient, peerMcp.value),
          Effect.ignore,
        );

  const rows = <E>(query: Effect.Effect<ReadonlyArray<{ readonly name: unknown }>, E>) =>
    query.pipe(
      Effect.map((all) => all.flatMap((r) => (typeof r.name === "string" ? [r.name] : []))),
      Effect.orElseSucceed((): ReadonlyArray<string> => []),
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
      rows(
        sql.value<{
          name: unknown;
        }>`SELECT title AS name FROM projection_projects WHERE deleted_at IS NULL AND archived_at IS NULL ORDER BY created_at`,
      ),
    ]);
    return [...personas, ...members, ...projects];
  });

  const read = Effect.gen(function* () {
    return withNames(readStored(file) ?? [], yield* names);
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
    yield* deriveCustomWords(all).pipe(Effect.ignore);
    yield* toPeers(input).pipe(Effect.forkDetach);
    return all;
  });

  // Words typed into T3's own list before this store existed join it once; after that the list is derived from it.
  const adopt = Effect.gen(function* () {
    if (Option.isNone(settings)) return;
    const words = (yield* settings.value.getSettings).speechProjectCustomWords;
    const known = yield* read;
    const extra = words.filter(
      (w) =>
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
  // shortcut: a word removed while a server was off comes back from its next start; a tombstone list would stop that.
  yield* Effect.suspend(() => {
    const stored = readStored(file);
    return stored === null || stored.length === 0
      ? Effect.void
      : toPeers({ verb: "learn", entries: stored });
  }).pipe(Effect.delay("1 minute"), Effect.forkScoped);

  return TessayaVocabulary.of({ read, change });
});

export const layer = Layer.effect(TessayaVocabulary, make);

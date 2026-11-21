// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { SpeechCustomWords } from "@t3tools/contracts";
import { customWordsOf, type VocabularyEntry } from "@t3tools/tessaya-shared/vocabulary";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { expect } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TessayaVocabulary } from "./TessayaVocabulary.ts";
import { receiveAtBrain } from "./BrainReceive.ts";
import { ordinaryHere } from "./stylePairsStore.ts";
import * as Context from "effect/Context";
import * as SqlClient from "effect/sql/SqlClient";
import * as PeerLinks from "../peer/PeerLinks.ts";
import { descriptorOf } from "../peer/PeerLinks.testkit.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { HOME_KEY, makeBrainLink } from "./BrainHost.ts";
import { layerMemory as SqlitePersistenceMemory } from "./TessayaDatabase.ts";
import * as Vocabulary from "./TessayaVocabulary.ts";
import { serveVoiceCall, TessayaVoiceLibrary } from "./TessayaVoiceLibrary.ts";

const withStore = <A, E>(
  body: (
    file: string,
  ) => Effect.Effect<A, E, TessayaVocabulary | ServerSettingsService | TessayaVoiceLibrary>,
  options: {
    readonly stored?: string;
    readonly words?: ReadonlyArray<{ term: string; aliases: Array<string> }>;
  } = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const base = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-vocabulary-" });
    const config = ServerConfig.layerTest(process.cwd(), base);
    const { stateDir } = yield* ServerConfig.ServerConfig.pipe(Effect.provide(config));
    const file = NodePath.join(stateDir, "voice", "dictionary.json");
    if (options.stored !== undefined) {
      NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
      NodeFS.writeFileSync(file, options.stored);
    }
    const settings = ServerSettingsService.layerTest({
      speechProjectCustomWords: [...(options.words ?? [])],
    });
    return yield* body(file).pipe(
      Effect.provide(
        Layer.mergeAll(
          Vocabulary.layer.pipe(Layer.provideMerge(settings), Layer.provideMerge(config)),
          // The door's dictionary ops never touch the voices.
          Layer.mock(TessayaVoiceLibrary)({}),
        ),
      ),
    );
  }).pipe(Effect.scoped);

/** The 15 words of his that the list rebuilt on 17 Nov lost, as his laptop stored them. */
const HIS_WORDS: ReadonlyArray<VocabularyEntry> = [
  { phrase: "btw", replacement: "by the way", source: "added", count: 1 },
  { phrase: "deplok", replacement: null, source: "added", count: 3, heard: ["deploy"] },
  { phrase: "google", replacement: null, source: "added", count: 32 },
  { phrase: "dokploy", replacement: null, source: "added", count: 7, heard: ["deploy"] },
  { phrase: "claude", replacement: null, source: "added", count: 20 },
  { phrase: "ee", replacement: null, source: "added", count: 2, heard: ["see"] },
  { phrase: "gmail", replacement: null, source: "added", count: 78, heard: ["female"] },
  { phrase: "stripe", replacement: null, source: "added", count: 149, heard: ["strike"] },
  { phrase: "coldmessaging", replacement: null, source: "added", count: 1, heard: ["messaging"] },
  { phrase: "dothraki", replacement: null, source: "added", count: 1, heard: ["dotrices"] },
  { phrase: "shotlist", replacement: null, source: "added", count: 2, heard: ["shortlist"] },
  { phrase: "kodi", replacement: null, source: "added", count: 1, heard: ["Cody"] },
  { phrase: "mushaf", replacement: null, source: "added", count: 1, heard: ["Musaf"] },
  { phrase: "whop", replacement: null, source: "added", count: 23, heard: ["VOP"] },
  {
    phrase: "Tessaya",
    replacement: null,
    source: "added",
    count: 1,
    lastSeen: "2026-11-10T02:15:29.236Z",
    heard: ["Tsaya"],
  },
];

const HIS_TERMS = customWordsOf(HIS_WORDS).map((w) => ({ term: w.term, aliases: [...w.aliases] }));

const decodeCustomWords = Schema.decodeUnknownSync(SpeechCustomWords);
const stored = (file: string) => JSON.parse(NodeFS.readFileSync(file, "utf8")) as Array<unknown>;
const customWords = Effect.map(
  Effect.flatMap(ServerSettingsService, (s) => s.getSettings),
  (s) => s.speechProjectCustomWords,
);

it.layer(NodeServices.layer)("his one dictionary", (it) => {
  it.effect("keeps each change in the file and tells T3's list, through the voice door", () =>
    withStore((file) =>
      Effect.gen(function* () {
        const add = yield* serveVoiceCall({
          kind: "act",
          op: "vocabularyChange",
          args: { verb: "add", phrase: "Kubernetes", replacement: null },
        });
        expect(add.ok).toBe(true);
        yield* serveVoiceCall({
          kind: "act",
          op: "vocabularyChange",
          args: {
            verb: "edit",
            from: "Kubernetes",
            phrase: "cube nets",
            replacement: "Kubernetes",
          },
        });
        expect(stored(file)).toEqual([
          expect.objectContaining({ phrase: "cube nets", replacement: "Kubernetes" }),
        ]);
        expect(yield* customWords).toContainEqual({ term: "Kubernetes", aliases: ["cube nets"] });

        yield* serveVoiceCall({
          kind: "act",
          op: "vocabularyChange",
          // As T3's list names it: by how it is written.
          args: { verb: "remove", phrase: "Kubernetes" },
        });
        expect(stored(file)).toEqual([]);
        expect((yield* customWords).map((w) => w.term)).not.toContain("Kubernetes");
        // A bad change is refused at the door and changes nothing.
        const bad = yield* serveVoiceCall({
          kind: "act",
          op: "vocabularyChange",
          args: { verb: "add", phrase: "" },
        });
        expect(bad.ok).toBe(false);
      }),
    ),
  );

  it.effect(
    "keeps his style pairs from the desktop and a worker, for every vessel's plain words",
    () =>
      withStore((file) =>
        Effect.gen(function* () {
          const pair = (id: string, raw: string, kept: string) => ({
            id,
            raw,
            kept,
            mode: "default",
          });
          const sent = yield* serveVoiceCall({
            kind: "act",
            op: "stylePairs",
            args: {
              pairs: [
                pair("a", "it is optimal to ship it friday", "It is optimal to ship it Friday."),
                pair(
                  "b",
                  "the optimal plan is the cheap one",
                  "The optimal plan is the cheap one.",
                ),
                { raw: 1, kept: "not a pair" },
              ],
            },
          });
          expect(sent).toEqual({ ok: true, value: 2 });
          expect((yield* ordinaryHere).has("optimal")).toBe(true);
          // A worker's pairs reach her brain the same way; the same id replaces the older pair.
          expect(
            (yield* receiveAtBrain("vocabulary", {
              change: null,
              pairs: [
                pair("b", "send the invoice to the client", "Send the invoice to the client."),
              ],
            })).ok,
          ).toBe(true);
          expect((yield* ordinaryHere).has("optimal")).toBe(false);
          // His own words: only he can read the file.
          const pairsFile = NodePath.join(NodePath.dirname(file), "style-pairs.json");
          expect(NodeFS.statSync(pairsFile).mode & 0o077).toBe(0);
        }),
      ),
  );

  it.effect(
    "on her brain, a worker's change lands in the one list and the brain answers its words for the cache",
    () =>
      withStore((file) =>
        Effect.gen(function* () {
          const added = yield* receiveAtBrain("vocabulary", {
            change: { verb: "add", phrase: "Kubernetes", replacement: null },
          });
          expect(added.ok).toBe(true);
          expect(stored(file)).toEqual([expect.objectContaining({ phrase: "Kubernetes" })]);
          const read = yield* receiveAtBrain("vocabulary", { change: null });
          const value = (read as { value: { stored: unknown[]; all: Array<{ phrase: string }> } })
            .value;
          // His words for the worker's cache; the read with the names, for its turns.
          expect(value.stored).toEqual([expect.objectContaining({ phrase: "Kubernetes" })]);
          expect(value.all.map((e) => e.phrase)).toContain("Kubernetes");
          expect(
            (yield* receiveAtBrain("vocabulary", { change: { verb: "add", phrase: "" } })).ok,
          ).toBe(false);
        }),
      ),
  );

  it.effect(
    "a worker's own words go up to her brain before the brain's list may replace its cache (17 Nov's 62)",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const dirs = {
          brain: yield* fs.makeTempDirectoryScoped({ prefix: "t3code-vocab-brain-" }),
          worker: yield* fs.makeTempDirectoryScoped({ prefix: "t3code-vocab-worker-" }),
        };
        const fileIn = (base: string) =>
          Effect.map(
            ServerConfig.ServerConfig.pipe(
              Effect.provide(ServerConfig.layerTest(process.cwd(), base)),
            ),
            (c) => NodePath.join(c.stateDir, "voice", "dictionary.json"),
          );
        const write = (file: string, entries: ReadonlyArray<VocabularyEntry>) => {
          NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
          NodeFS.writeFileSync(file, JSON.stringify(entries));
        };
        const brainFile = yield* fileIn(dirs.brain);
        const workerFile = yield* fileIn(dirs.worker);
        write(brainFile, [{ phrase: "kodi", replacement: null, source: "added", count: 1 }]);
        write(workerFile, HIS_WORDS.slice(0, 3));
        const brain = yield* Layer.build(
          Vocabulary.layer.pipe(
            Layer.provideMerge(ServerSettingsService.layerTest()),
            Layer.provide(ServerConfig.layerTest(process.cwd(), dirs.brain)),
          ),
        );
        let reachable = true;
        const peers = Layer.mergeAll(
          Layer.succeed(PeerLinks.PeerLinks, {
            enabled: Effect.succeed(true),
            list: Effect.succeed([
              { ...descriptorOf("env-brain", "brain"), label: "brain", status: "ok" } as never,
            ]),
          } as never),
          Layer.succeed(
            PeerMcpClient.PeerMcpClient,
            PeerMcpClient.PeerMcpClient.of({
              call: (input) =>
                (reachable
                  ? receiveAtBrain(input.arguments["op"] as never, input.arguments["payload"]).pipe(
                      Effect.provideContext(brain),
                    )
                  : Effect.fail(new Error("her brain is away"))) as never,
            }),
          ),
        );
        const worker = yield* Layer.build(
          Vocabulary.layer.pipe(
            Layer.provideMerge(ServerSettingsService.layerTest()),
            Layer.provide(ServerConfig.layerTest(process.cwd(), dirs.worker)),
            Layer.provide(peers),
            Layer.provideMerge(SqlitePersistenceMemory),
          ),
        );
        const sql = Context.get(worker, SqlClient.SqlClient);
        yield* sql`INSERT INTO fabric_settings (key, value) VALUES (${HOME_KEY}, 'brain')`;
        yield* Context.get(worker, TessayaVocabulary).read;
        const phrases = (file: string) => stored(file).map((e) => (e as { phrase: string }).phrase);
        // Nothing of his is lost: the brain gained his three, and the worker's cache holds all four.
        expect(phrases(brainFile).toSorted()).toEqual(["btw", "deplok", "google", "kodi"]);
        expect(phrases(workerFile).toSorted()).toEqual(["btw", "deplok", "google", "kodi"]);
        // And his file as it was stays beside the cache.
        expect(
          phrases(NodePath.join(NodePath.dirname(workerFile), "dictionary.before-brain.json")),
        ).toEqual(["btw", "deplok", "google"]);
        // A word he removes on the worker while the brain is away reaches it once it is back, and does not return.
        reachable = false;
        yield* Context.get(worker, TessayaVocabulary).change({ verb: "remove", phrase: "google" });
        expect(phrases(brainFile)).toContain("google");
        reachable = true;
        yield* Effect.flatMap(makeBrainLink, (link) => link.replay()).pipe(
          Effect.provideContext(worker),
        );
        yield* Context.get(worker, TessayaVocabulary).read;
        expect(phrases(brainFile).toSorted()).toEqual(["btw", "deplok", "kodi"]);
        expect(phrases(workerFile).toSorted()).toEqual(["btw", "deplok", "kodi"]);
      }).pipe(Effect.scoped),
  );

  it.effect("adds the persona names once, beside his own spelling of one", () =>
    withStore(
      () =>
        Effect.gen(function* () {
          const all = yield* Effect.flatMap(TessayaVocabulary, (v) => v.read);
          const alfred = all.filter((e) => (e.replacement ?? e.phrase).toLowerCase() === "alfred");
          expect(alfred).toEqual([
            expect.objectContaining({ phrase: "Alfie", replacement: "Alfred" }),
          ]);
          // Each name carries its sound-alikes from the one list the wake check reads too.
          expect(all.find((e) => e.phrase === "Tessaya")).toMatchObject({
            replacement: null,
            heard: expect.arrayContaining(["teseya", "tisia"]),
          });
        }),
      { stored: JSON.stringify([{ phrase: "Alfie", replacement: "Alfred" }]) },
    ),
  );

  it.effect("takes in words typed into T3's list before it existed, once", () =>
    withStore(
      (file) =>
        Effect.gen(function* () {
          expect(stored(file)).toEqual([
            expect.objectContaining({ phrase: "Grafana", heard: ["Grafanna"] }),
          ]);
          expect(yield* customWords).toContainEqual({ term: "Grafana", aliases: ["Grafanna"] });
        }),
      { words: [{ term: "Grafana", aliases: ["Grafanna"] }] },
    ),
  );

  it.effect("never takes back an ordinary word the store dropped from T3's list", () =>
    withStore(
      (file) =>
        Effect.gen(function* () {
          // His laptop on 0.1.147: the learned "pass" was dropped on read, then came back as his own from T3's list.
          expect(stored(file)).not.toContainEqual(expect.objectContaining({ source: "added" }));
          const terms = (yield* customWords).map((w) => w.term);
          expect(terms).toContain("Kaggle");
          expect(terms).not.toContain("pass");
        }),
      {
        stored: JSON.stringify([
          { phrase: "pass", replacement: null, source: "learned", count: 1, heard: ["past"] },
          { phrase: "Kaggle", replacement: null, source: "learned", count: 3 },
        ]),
        words: [
          { term: "pass", aliases: ["past"] },
          { term: "Kaggle", aliases: [] },
        ],
      },
    ),
  );

  it.effect(
    "keeps his own small-letter words, and keeps a dropped word where he can add it back",
    () =>
      withStore(
        (file) =>
          Effect.gen(function* () {
            // 17 Nov: rebuilt from T3's list, his dokploy, whop and mushaf were skipped as "ordinary".
            const terms = (yield* customWords).map((w) => w.term);
            expect(terms).toEqual(expect.arrayContaining(["dokploy", "whop", "mushaf", "Kaggle"]));
            expect(terms).not.toContain("pass");
            const removed = stored(
              NodePath.join(NodePath.dirname(file), "dictionary-removed.json"),
            );
            expect(removed).toEqual([
              expect.objectContaining({
                phrase: "pass",
                source: "learned",
                removedAt: expect.any(String),
              }),
            ]);
          }),
        {
          stored: JSON.stringify([
            { phrase: "pass", replacement: null, source: "learned", count: 1, heard: ["past"] },
            { phrase: "Kaggle", replacement: null, source: "learned", count: 3 },
          ]),
          words: [
            { term: "pass", aliases: ["past"] },
            { term: "Kaggle", aliases: [] },
            { term: "dokploy", aliases: [] },
            { term: "whop", aliases: [] },
            { term: "mushaf", aliases: [] },
          ],
        },
      ),
  );

  it.effect("starts with every word of his list kept as it was", () =>
    withStore(
      (file) =>
        Effect.gen(function* () {
          expect(stored(file)).toEqual(HIS_WORDS);
          expect(yield* customWords).toEqual(expect.arrayContaining(HIS_TERMS));
        }),
      { stored: JSON.stringify(HIS_WORDS), words: HIS_TERMS },
    ),
  );

  it.effect("never rebuilds a list that PowerShell 5.1 wrote as one item", () => {
    const nested = JSON.stringify([HIS_WORDS]);
    return withStore(
      (file) =>
        Effect.gen(function* () {
          expect(NodeFS.readFileSync(file, "utf8")).toBe(nested);
          expect(yield* customWords).toEqual(expect.arrayContaining(HIS_TERMS));
        }),
      { stored: nested, words: HIS_TERMS },
    );
  });

  it.effect("never overwrites a file it cannot read", () =>
    withStore(
      (file) =>
        Effect.gen(function* () {
          const answer = yield* serveVoiceCall({
            kind: "act",
            op: "vocabularyChange",
            args: { verb: "add", phrase: "Kubernetes", replacement: null },
          });
          expect(answer).toMatchObject({ ok: false });
          expect(NodeFS.readFileSync(file, "utf8")).toBe("{ not json");
        }),
      { stored: "{ not json" },
    ),
  );
});

it("derives T3's list as its contract allows: added, then learned by use, then Wispr", () => {
  const entries: ReadonlyArray<VocabularyEntry> = [
    { phrase: "Wisprword", replacement: null, source: "wispr" },
    { phrase: "Rare", replacement: null, source: "learned", count: 3 },
    { phrase: "Often", replacement: null, source: "learned", count: 9, heard: ["Ofen", "often"] },
    { phrase: "tess a", replacement: "Tessaya", source: "added" },
    // The same spelling twice, and an alias another word already has.
    { phrase: "tessaya", replacement: null, source: "learned", count: 50 },
    { phrase: "Ofen", replacement: null, source: "added" },
    ...Array.from({ length: 150 }, (_, i) => ({
      phrase: `Word${i}`,
      replacement: null,
      source: "wispr" as const,
      heard: Array.from({ length: 12 }, (_, j) => `w${i}x${j}`),
    })),
  ];
  const words = customWordsOf(entries);
  expect(() => decodeCustomWords(words)).not.toThrow();
  expect(words).toHaveLength(100);
  expect(words.slice(0, 5)).toEqual([
    { term: "Tessaya", aliases: ["tess a"] },
    { term: "Ofen", aliases: [] },
    { term: "Often", aliases: [] },
    { term: "Rare", aliases: [] },
    { term: "Wisprword", aliases: [] },
  ]);
  expect(words[5]!.aliases).toHaveLength(8);
});

it("listens for a project title only when it is spoken words", () => {
  // His projects on the box, 16 Nov: only one title is a word he says.
  const titles = ["NorthWind", "t3code", "baton-media-test", "native-copy-1", "work", "The Margin"];
  expect(titles.filter(Vocabulary.spokenTitle)).toEqual(["NorthWind", "The Margin"]);
});

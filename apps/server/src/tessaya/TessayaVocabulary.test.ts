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
          Vocabulary.layer.pipe(Layer.provideMerge(settings), Layer.provide(config)),
          // The door's dictionary ops never touch the voices.
          Layer.mock(TessayaVoiceLibrary)({}),
        ),
      ),
    );
  }).pipe(Effect.scoped);

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

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  type LayerHttpRequest,
  type LayerTurn,
  loadPersonaLayers,
  PersonaLayers,
  pushAnswers,
  replyFor,
} from "./PersonaLayers.ts";

describe("loadPersonaLayers", () => {
  it("imports nothing outside an internal build, whatever the environment names", async () => {
    const layers = await loadPersonaLayers(
      { stepUp: async () => null },
      "/no/such/layer/that/would/throw/if/imported.ts",
    );
    expect(layers).toEqual([]);
  });
});

describe("replyFor", () => {
  it.effect(
    "hands a layer full voice assurance only for his voice verified on the turn's own clips",
    () =>
      Effect.gen(function* () {
        const seen: Array<number> = [];
        const layers = PersonaLayers.of({
          all: [
            {
              id: "probe",
              onTurn: async (turn: LayerTurn) => {
                seen.push(turn.assurance);
                return null;
              },
              signal: () => undefined,
              http: async () => ({ status: 404, body: "" }),
            },
          ],
        });
        const him = { kind: "owner", personId: "owner", verified: true, inherited: false } as const;
        for (const speaker of [
          him,
          { ...him, session: true },
          { ...him, lifted: true },
          { ...him, test: true },
        ])
          yield* replyFor({ vessel: { kind: "device", id: "desk" }, text: "hi", speaker }).pipe(
            Effect.provideService(PersonaLayers, layers),
          );
        expect(seen).toEqual([2, 1, 1, 1]);
      }),
  );
});

describe("pushAnswers", () => {
  it.effect(
    "pushes each long-poll answer as it comes, the next poll after its seq, until closed",
    () =>
      Effect.gen(function* () {
        const asked: Array<LayerHttpRequest["body"]> = [];
        const answers = [
          { seq: 3, cues: [] },
          { seq: 4, cues: [{ kind: "perform" }] },
          { closed: true },
        ];
        const written: string[] = [];
        yield* pushAnswers(
          {
            http: async (r) => {
              asked.push(r.body);
              return { status: 200, json: answers.shift() };
            },
          },
          { path: "body.stream", member: null, session: "s", body: { link: "L" } },
          (text) => Effect.sync(() => void written.push(text)),
        );
        // the first poll answers at once (the whole picture); later ones are held by the layer until something new
        expect(asked).toEqual([
          { link: "L", after: 0, wait: 0 },
          { link: "L", after: 3, wait: 20_000 },
          { link: "L", after: 4, wait: 20_000 },
        ]);
        expect(written.map((t) => JSON.parse(t))).toEqual([
          { seq: 3, cues: [] },
          { seq: 4, cues: [{ kind: "perform" }] },
          { closed: true },
        ]);
      }),
  );
});

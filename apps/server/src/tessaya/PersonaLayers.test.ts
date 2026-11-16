import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { type LayerTurn, loadPersonaLayers, PersonaLayers, replyFor } from "./PersonaLayers.ts";

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

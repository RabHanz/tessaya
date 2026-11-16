import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { Persona } from "@t3tools/tessaya-shared/osPack";

import * as CurrentPersona from "./CurrentPersona.ts";
import { changeGroup, groupFor, groupTurn, HIS_GROUP, type GroupChange } from "./GroupTalk.ts";
import { TessayaOneShot } from "./TessayaOneShot.ts";
import type { TurnEnvelope } from "./TessayaTurn.ts";

const persona = (id: string, extra: Partial<Persona> = {}): Persona => ({
  id,
  name: id[0]!.toUpperCase() + id.slice(1),
  wake: null,
  voice: "v",
  role: `${id}'s role`,
  lead: false,
  tools: null,
  projects: [],
  leads: [],
  ...extra,
});
const personas = [persona("freya"), persona("luna"), persona("velvet", { private: true })];
const hisKeyboard: TurnEnvelope = {
  vessel: { kind: "desktop", id: "desk" },
  text: "What do you two think?",
  speaker: null,
  member: "owner",
};
const guestVoice: TurnEnvelope = {
  ...hisKeyboard,
  vessel: { kind: "device", id: "tumble" },
  speaker: { kind: "guest", personId: null, verified: false, inherited: false },
};

// The cheap model always wants to keep going, so only the budget can stop the turn.
const picks: Array<string> = [];
const alwaysOn = Layer.succeed(TessayaOneShot, {
  run: (input: { readonly prompt: string; readonly feature: string }) =>
    Effect.sync(() => {
      picks.push(input.feature);
      return { next: /Who may speak: (\w+)/.exec(input.prompt)![1], confidence: 0.9 };
    }),
} as never);

it.layer(Layer.mergeAll(CurrentPersona.layer, alwaysOn))("GroupTalk", (it) => {
  it.effect("watch mode keeps choosing until the speaker budget stops it", () =>
    Effect.gen(function* () {
      picks.length = 0;
      const current = yield* CurrentPersona.CurrentPersona;
      yield* current.setGroup(HIS_GROUP, {
        mode: "watch",
        members: [{ id: "freya" }, { id: "luna" }],
      });
      const found = yield* groupFor(hisKeyboard, personas);
      assert.isNotNull(found);
      const spoken = yield* groupTurn({
        turn: hisKeyboard,
        ...found!,
        personas,
        speak: (p) => Effect.succeed(`${p.name} here.`),
      });
      assert.deepStrictEqual(
        spoken.map((s) => s.id),
        ["freya", "luna", "freya", "luna", "freya", "luna"],
      );
      assert.isTrue(picks.length > 0 && picks.every((f) => f === "group-turn"));
    }),
  );

  it.effect("a group with a private persona answers only his own turn", () =>
    Effect.gen(function* () {
      const current = yield* CurrentPersona.CurrentPersona;
      const members = [{ id: "freya" }, { id: "velvet" }];
      yield* current.setGroup(HIS_GROUP, { mode: "answer", members });
      yield* current.setGroup("household", { mode: "answer", members });
      assert.isTrue((yield* groupFor(hisKeyboard, personas))?.private === true);
      assert.isNull(yield* groupFor(guestVoice, personas));
      assert.isNull(yield* groupFor({ ...hisKeyboard, tainted: true }, personas));
    }),
  );
});

it.layer(CurrentPersona.layer)("changeGroup", (it) => {
  it.effect("starts, steers and ends his group, the way back included", () =>
    Effect.gen(function* () {
      const lines: Array<string> = [];
      const run = (change: GroupChange) =>
        Effect.map(changeGroup(HIS_GROUP, change, { owner: true }), (r) => {
          lines.push(r.line);
          return r.group;
        });
      assert.isNull(yield* run({ op: "start", personas: ["Freya"] }));
      yield* run({ op: "start", personas: ["Freya", "Alfred"] });
      yield* run({ op: "silent", persona: "freya" });
      const watching = yield* run({ op: "mode", mode: "watch" });
      assert.strictEqual(watching?.mode, "watch");
      assert.deepStrictEqual(
        watching?.members.map((m) => m.silent === true),
        [true, false],
      );
      assert.isNull(yield* run({ op: "leave", persona: "Alfred" }));
      assert.deepStrictEqual(lines, [
        "A group needs at least two personas.",
        "Group started: Freya and Alfred.",
        "Freya will listen, and speak when you ask.",
        "They'll talk among themselves.",
        "Alfred left, so the group is over.",
      ]);
    }),
  );
});

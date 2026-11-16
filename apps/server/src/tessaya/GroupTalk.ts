/**
 * Group conversations (M-021): one turn of his, answered by the personas of his conversation's group. Each speaker
 * runs its own turn (its walls, memory, brain, voice and mood); who speaks next is the cheap tier's closed choice
 * (Voxta G3), within a speaker and a token budget per turn. The rules are `groupTalk.ts`; this drives them.
 */
import type { Persona } from "@t3tools/tessaya-shared/osPack";
import {
  choicePrompt,
  choiceSchema,
  groupLine,
  MAX_MEMBERS,
  nextStep,
  stepFromChoice,
  type GroupMode,
  type PersonaGroup,
  type Spoken,
  type Step,
} from "@t3tools/tessaya-shared/groupTalk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { emitAction, traced } from "../provenance/ActionLog.ts";
import { hisOwnTurn } from "./consent.ts";
import { CurrentPersona } from "./CurrentPersona.ts";
import { personasList } from "./OperatingSystemPack.ts";
import { TessayaMood } from "./TessayaMood.ts";
import { TessayaOneShot } from "./TessayaOneShot.ts";
import { conversationKey, originOf, type TurnEnvelope } from "./TessayaTurn.ts";

/** His one group, whichever vessel he starts it on or speaks to it from. */
export const HIS_GROUP = "group:his";

/** Where a turn's group is kept: his own turns share his one group; anyone else's is their conversation's. */
export const groupConversation = (
  turn: Pick<TurnEnvelope, "vessel" | "speaker" | "member" | "conversation">,
  own: boolean,
): string => (own ? HIS_GROUP : conversationKey({ ...turn, text: "" }));

export type GroupChange =
  | {
      readonly op: "start" | "add";
      readonly personas: ReadonlyArray<string>;
      /** Only `start` sets it; `add` keeps the group's. */
      readonly mode?: GroupMode | undefined;
    }
  | { readonly op: "leave" | "silent" | "speak"; readonly persona: string }
  | { readonly op: "mode"; readonly mode: GroupMode }
  | { readonly op: "end" | "status" };

const listNames = (names: ReadonlyArray<string>) =>
  names.length <= 1 ? (names[0] ?? "") : `${names.slice(0, -1).join(", ")} and ${names.at(-1)!}`;

/**
 * Starts, changes, ends or reads the group of a conversation, by voice, MCP or a client. `owner`: his own turn or
 * session; only then may a private persona be in it. Returns the line to say back, and the group as it now is.
 */
export const changeGroup = Effect.fn("GroupTalk.change")(function* (
  conversation: string,
  change: GroupChange,
  who: { readonly owner: boolean },
) {
  const current = yield* Effect.serviceOption(CurrentPersona);
  if (Option.isNone(current))
    return { line: "Groups are not available here.", group: null as PersonaGroup | null };
  const { personas } = yield* personasList;
  const find = (name: string) => {
    const n = name.trim().toLowerCase();
    return personas.find((p) => p.id === n || p.name.toLowerCase() === n);
  };
  const was = yield* current.value.group(conversation);
  const nameOf = (id: string) => personas.find((p) => p.id === id)?.name ?? id;
  const done = (line: string, group: PersonaGroup | null) => ({ line, group });
  const save = (line: string, group: PersonaGroup | null) =>
    Effect.as(current.value.setGroup(conversation, group), done(line, group));
  const resolve = (names: ReadonlyArray<string>) => {
    const found = names.map((n) => ({ n, p: find(n) }));
    const unknown = found.filter((f) => f.p === undefined).map((f) => f.n);
    const ps = found.flatMap((f) => (f.p === undefined ? [] : [f.p]));
    if (unknown.length > 0) return { error: `There is no persona called ${listNames(unknown)}.` };
    if (!who.owner && ps.some((p) => p.private === true))
      return { error: "Only he can bring a private persona into a group." };
    return { ids: ps.map((p) => p.id) };
  };
  switch (change.op) {
    case "status":
      return done(
        was === null
          ? "No group: just one persona at a time."
          : `In the group: ${listNames(was.members.map((m) => `${nameOf(m.id)}${m.silent === true ? " (listening)" : ""}`))}; ${was.mode === "watch" ? "they talk among themselves" : "they answer only you"}.`,
        was,
      );
    case "end":
      return was === null
        ? done("There is no group to end.", null)
        : yield* save("Group ended.", null);
    case "mode": {
      if (was === null) return done("Start a group first.", null);
      return yield* save(
        change.mode === "watch" ? "They'll talk among themselves." : "They'll answer only you.",
        { ...was, mode: change.mode },
      );
    }
    case "start":
    case "add": {
      const r = resolve(change.personas);
      if ("error" in r) return done(r.error!, was);
      const base = change.op === "start" || was === null ? [] : was.members;
      const members = [
        ...base,
        ...r.ids.filter((id) => !base.some((m) => m.id === id)).map((id) => ({ id })),
      ].filter((m, i, all) => all.findIndex((x) => x.id === m.id) === i);
      if (members.length < 2) return done("A group needs at least two personas.", was);
      if (members.length > MAX_MEMBERS)
        return done(`A group holds at most ${MAX_MEMBERS} personas.`, was);
      const mode = change.op === "start" ? (change.mode ?? "answer") : (was?.mode ?? "answer");
      return yield* save(
        change.op === "start"
          ? `Group started: ${listNames(members.map((m) => nameOf(m.id)))}.`
          : `${listNames(r.ids.map(nameOf))} joined.`,
        { members, mode },
      );
    }
    case "leave":
    case "silent":
    case "speak": {
      if (was === null) return done("There is no group right now.", null);
      const p = find(change.persona);
      if (p === undefined || !was.members.some((m) => m.id === p.id))
        return done(`${change.persona} is not in the group.`, was);
      if (change.op === "leave") {
        const members = was.members.filter((m) => m.id !== p.id);
        return members.length < 2
          ? yield* save(`${p.name} left, so the group is over.`, null)
          : yield* save(`${p.name} left the group.`, { ...was, members });
      }
      const silent = change.op === "silent";
      return yield* save(
        silent ? `${p.name} will listen, and speak when you ask.` : `${p.name} can speak again.`,
        {
          ...was,
          members: was.members.map((m) => (m.id === p.id ? { id: m.id, silent } : m)),
        },
      );
    }
  }
});

/** The group a turn speaks to, as this turn may use it; null runs the ordinary one-persona turn. */
export const groupFor = Effect.fn("GroupTalk.groupFor")(function* (
  turn: TurnEnvelope,
  personas: ReadonlyArray<Persona>,
) {
  if (turn.rehearsal === true || turn.tainted === true || turn.sharedRoom === true) return null;
  const current = yield* Effect.serviceOption(CurrentPersona);
  if (Option.isNone(current)) return null;
  const own = hisOwnTurn(originOf(turn));
  const group = yield* current.value.group(groupConversation(turn, own));
  if (group === null) return null;
  const members = group.members.filter((m) => personas.some((p) => p.id === m.id));
  if (members.length === 0) return null;
  // A group with a private persona (M-002) answers only his own verified voice or his own keyboard.
  const isPrivate = members.some((m) => personas.find((p) => p.id === m.id)?.private === true);
  if (isPrivate && !own) return null;
  return { group: { ...group, members }, private: isPrivate };
});

/**
 * Runs his turn through the group: `speak` answers as one persona with its group line and returns what it said
 * (null stops the turn: it failed, or he barged in). Returns who said what, in order.
 */
export const groupTurn = Effect.fn("GroupTalk.turn")(
  function* <R>(input: {
    readonly turn: TurnEnvelope;
    readonly group: PersonaGroup;
    readonly private: boolean;
    readonly personas: ReadonlyArray<Persona>;
    readonly speak: (
      speaker: Persona,
      line: string,
      first: boolean,
    ) => Effect.Effect<string | null, never, R>;
  }) {
    const { group, personas, turn } = input;
    const current = yield* Effect.serviceOption(CurrentPersona);
    // His word keeps the group alive.
    if (Option.isSome(current))
      yield* current.value.setGroup(groupConversation(turn, hisOwnTurn(originOf(turn))), group);
    const oneShot = yield* Effect.serviceOption(TessayaOneShot);
    // The room's mood (MA-021): each member's general mood, never a relationship, so nothing private crosses speakers.
    const mood = yield* Effect.serviceOption(TessayaMood);
    const views = Option.isNone(mood)
      ? []
      : yield* Effect.forEach(group.members, (m) =>
          Effect.map(mood.value.view(m.id, turn.timeZone), (v) => ({ id: m.id, v })),
        );
    const moods = Object.fromEntries(
      views.filter(({ v }) => v.intensity >= 0.2).map(({ id, v }) => [id, v.label]),
    );
    const spoken: Array<Spoken> = [];
    let stopped: string = "done";
    for (;;) {
      const state = { group, personas, text: turn.text, spoken };
      let step: Step = nextStep(state);
      if ("ask" in step) {
        const candidates = step.ask;
        const answer = Option.isNone(oneShot)
          ? null
          : yield* oneShot.value
              .run({
                prompt: choicePrompt({ ...state, candidates }),
                outputSchema: choiceSchema(candidates),
                role: "intent",
                feature: "group-turn",
              })
              .pipe(Effect.orElseSucceed(() => null));
        step = stepFromChoice(state, candidates, answer);
        yield* emitAction({
          kind: "group.choice",
          actor: { kind: "system", id: "group-turn", certainty: answer?.confidence ?? 0 },
          subject: candidates.join(","),
          outcome: "next" in step ? step.next : "end",
          data: { picked: answer?.next ?? null, confidence: answer?.confidence ?? null },
          private: input.private,
        });
      }
      if ("stop" in step) {
        stopped = step.stop;
        break;
      }
      if (!("next" in step)) break;
      const id = step.next;
      const speaker = personas.find((p) => p.id === id);
      if (speaker === undefined) break;
      const said = yield* input.speak(
        speaker,
        groupLine({
          group,
          personas,
          speaker: id,
          spoken,
          moods,
          jealousy: views.find((x) => x.id === id)?.v.leanings?.jealousy ?? 0,
        }),
        spoken.length === 0,
      );
      if (said === null || said.trim() === "") {
        stopped = "failed";
        break;
      }
      spoken.push({ id, said });
    }
    yield* Effect.logInfo("group turn", {
      speakers: spoken.map((s) => s.id),
      stopped,
      mode: group.mode,
    });
    return spoken;
  },
  (effect, input) =>
    traced({
      kind: "group.turn",
      actor: { kind: "system", id: "group-turn", certainty: 1 },
      subject: input.group.members.map((m) => m.id).join(","),
      private: input.private,
    })(effect),
);

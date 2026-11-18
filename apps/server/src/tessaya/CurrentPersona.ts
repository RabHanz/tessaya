/**
 * Who each person is talking to, as brain state (SPINE-UNIFY §10, P5): the persona of their conversation's last turn on
 * any vessel. Its own service, so the turn writes it and the device broker tells the room loops without importing each
 * other; the loop's session hold stays the policy for when to follow it. A worker sends each change to her brain
 * (BrainHost), so a persona he talks to at his desk is the one every vessel follows (B-044).
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { MAX_MEMBERS, type PersonaGroup } from "@t3tools/tessaya-shared/groupTalk";

import { makeBrainLink } from "./BrainHost.ts";

/** As long as a conversation itself lasts (TessayaTurn's idle boundary). */
const HELD_MS = 10 * 60_000;

type Listener = (conversation: string, persona: string) => Effect.Effect<void>;

export class CurrentPersona extends Context.Service<
  CurrentPersona,
  {
    /** A turn of this conversation was answered by this persona; listeners hear only a change. */
    readonly set: (conversation: string, persona: string) => Effect.Effect<void>;
    readonly of: (conversation: string) => Effect.Effect<string | null>;
    readonly listen: (listener: Listener) => Effect.Effect<void>;
    /** The personas he talks to together in this conversation (M-021), null when it is one persona's. */
    readonly group: (conversation: string) => Effect.Effect<PersonaGroup | null>;
    /** Starts, changes or (null) ends the conversation's group; a group turn keeps it alive. */
    readonly setGroup: (conversation: string, group: PersonaGroup | null) => Effect.Effect<void>;
  }
>()("t3/tessaya/CurrentPersona") {}

/** A group outlives a quiet spell: it ends when he ends it or after half a day without a word. */
const GROUP_HELD_MS = 12 * 60 * 60_000;
export const GroupValue = Schema.NullOr(
  Schema.Struct({
    members: Schema.Array(
      Schema.Struct({
        id: Schema.String.check(Schema.isPattern(/^[\w-]{1,40}$/)),
        silent: Schema.optional(Schema.Boolean),
      }),
    ).check(Schema.isMaxLength(MAX_MEMBERS)),
    mode: Schema.Literals(["answer", "watch"]),
  }),
);

const make = Effect.gen(function* () {
  const brain = yield* makeBrainLink;
  // shortcut: in this server's memory, like the conversations it follows; a restart starts each on its lead.
  const held = new Map<string, { readonly persona: string; readonly at: number }>();
  const listeners = new Set<Listener>();
  const of = Effect.fn("CurrentPersona.of")(function* (conversation: string) {
    const now = yield* Clock.currentTimeMillis;
    const h = held.get(conversation);
    return h !== undefined && now - h.at <= HELD_MS ? h.persona : null;
  });
  const hold = Effect.fn("CurrentPersona.hold")(function* (
    conversation: string,
    persona: string,
    at: number,
  ) {
    const was = yield* of(conversation);
    held.set(conversation, { persona, at });
    if (was !== persona) for (const l of listeners) yield* l(conversation, persona);
  });
  const set = Effect.fn("CurrentPersona.set")(function* (conversation: string, persona: string) {
    const at = yield* Clock.currentTimeMillis;
    yield* hold(conversation, persona, at);
    if (!(yield* brain.isBrain)) yield* brain.send("persona", { conversation, persona });
  });
  const listen = (listener: Listener) => Effect.sync(() => void listeners.add(listener));
  const groups = new Map<string, { readonly group: PersonaGroup | null; readonly at: number }>();
  const group = Effect.fn("CurrentPersona.group")(function* (conversation: string) {
    const now = yield* Clock.currentTimeMillis;
    const g = groups.get(conversation);
    return g !== undefined && now - g.at <= GROUP_HELD_MS ? g.group : null;
  });
  const setGroup = Effect.fn("CurrentPersona.setGroup")(function* (
    conversation: string,
    next: PersonaGroup | null,
  ) {
    const at = yield* Clock.currentTimeMillis;
    groups.set(conversation, { group: next, at });
    if (!(yield* brain.isBrain)) yield* brain.send("group", { conversation, group: next });
  });
  return CurrentPersona.of({ set, of, listen, group, setGroup });
});

export const layer = Layer.effect(CurrentPersona, make);

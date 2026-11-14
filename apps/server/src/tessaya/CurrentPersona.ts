/**
 * Who each person is talking to, as brain state (SPINE-UNIFY §10, P5): the persona of their conversation's last turn on
 * any vessel. Its own service, so the turn writes it and the device broker tells the room loops without importing each
 * other; the loop's session hold stays the policy for when to follow it.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

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
  }
>()("t3/tessaya/CurrentPersona") {}

const make = Effect.sync(() => {
  // shortcut: in this server's memory, like the conversations it follows; a restart starts each on its lead.
  const held = new Map<string, { readonly persona: string; readonly at: number }>();
  const listeners = new Set<Listener>();
  const of = Effect.fn("CurrentPersona.of")(function* (conversation: string) {
    const now = yield* Clock.currentTimeMillis;
    const h = held.get(conversation);
    return h !== undefined && now - h.at <= HELD_MS ? h.persona : null;
  });
  const set = Effect.fn("CurrentPersona.set")(function* (conversation: string, persona: string) {
    const was = yield* of(conversation);
    held.set(conversation, { persona, at: yield* Clock.currentTimeMillis });
    if (was !== persona) for (const l of listeners) yield* l(conversation, persona);
  });
  const listen = (listener: Listener) => Effect.sync(() => void listeners.add(listener));
  return CurrentPersona.of({ set, of, listen });
});

export const layer = Layer.effect(CurrentPersona, make);

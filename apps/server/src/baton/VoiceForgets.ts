/**
 * Members whose voice print every vessel on this server must forget (their data was destroyed). The household
 * publishes; each vessel's owner (the device broker for the room loop) listens. Its own service, with no other
 * dependency, so both sides see it without importing each other.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

export class VoiceForgets extends Context.Service<
  VoiceForgets,
  {
    readonly forget: (member: string) => Effect.Effect<void>;
    readonly forgotten: Stream.Stream<string>;
  }
>()("t3/baton/VoiceForgets") {}

export const layer = Layer.effect(
  VoiceForgets,
  Effect.map(PubSub.unbounded<string>(), (hub) =>
    VoiceForgets.of({
      forget: Effect.fn("VoiceForgets.forget")((member: string) =>
        PubSub.publish(hub, member).pipe(Effect.asVoid),
      ),
      forgotten: Stream.fromPubSub(hub),
    }),
  ),
);

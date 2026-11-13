/**
 * The household's voices, for every vessel on this server: the members' shared profiles to recognise them by, and the
 * members whose voice must be forgotten now (their data was destroyed). The household sets them; each vessel's owner
 * (the device broker for the room loop) listens. Its own service with no other dependency, so neither side imports
 * the other.
 */
import type { BatonVoiceProfile } from "@t3tools/baton-contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface VoiceListener {
  /** Every member's shared profile now. */
  readonly profiles: (profiles: ReadonlyArray<BatonVoiceProfile>) => Effect.Effect<void>;
  readonly forgotten: (member: string) => Effect.Effect<void>;
}

export class VoiceForgets extends Context.Service<
  VoiceForgets,
  {
    readonly forget: (member: string) => Effect.Effect<void>;
    readonly setProfiles: (profiles: ReadonlyArray<BatonVoiceProfile>) => Effect.Effect<void>;
    /** The profiles now. */
    readonly current: Effect.Effect<ReadonlyArray<BatonVoiceProfile>>;
    /** Told of each change, in the caller's fiber: nothing to fork, nothing missed. */
    readonly listen: (listener: VoiceListener) => Effect.Effect<void>;
  }
>()("t3/baton/VoiceForgets") {}

export const layer = Layer.effect(
  VoiceForgets,
  Effect.sync(() => {
    let shared: ReadonlyArray<BatonVoiceProfile> = [];
    const listeners = new Set<VoiceListener>();
    return VoiceForgets.of({
      forget: Effect.fn("VoiceForgets.forget")(function* (member: string) {
        for (const l of listeners) yield* l.forgotten(member);
      }),
      setProfiles: Effect.fn("VoiceForgets.setProfiles")(function* (
        profiles: ReadonlyArray<BatonVoiceProfile>,
      ) {
        shared = profiles;
        for (const l of listeners) yield* l.profiles(profiles);
      }),
      current: Effect.sync(() => shared),
      listen: Effect.fn("VoiceForgets.listen")((listener: VoiceListener) =>
        Effect.sync(() => void listeners.add(listener)),
      ),
    });
  }),
);

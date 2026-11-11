/**
 * Whose voice each utterance is (VOICE-ID slice 4), for the voice core, the trust path, the approval path and the
 * memory stores. One service and one `SpeakerIdentity` shape for all of them. Identity only narrows: no verdict
 * grants more than his turn gets today.
 */
import {
  adaptProfile,
  admits,
  decideSpeaker,
  identityOf,
  INHERIT_MS,
  UNVERIFIED,
  type SpeakerGate,
  type SpeakerIdentity,
  type SpeakerPolicy,
} from "@t3tools/baton-voice";

import type { VoiceId } from "./voiceId.ts";
import type { VoiceIdSettings } from "./voiceIdRows.ts";

const RATE = 16_000;

export const createSpeakerIdentity = (input: {
  readonly voiceId: Pick<VoiceId, "embedder" | "profiles" | "save">;
  readonly settings: () => VoiceIdSettings;
  readonly policy: SpeakerPolicy;
  readonly now: () => number;
  readonly onNote?: (kind: string, fields: Readonly<Record<string, unknown>>) => void;
}) => {
  let last: SpeakerIdentity | null = null;
  const listeners = new Set<(identity: SpeakerIdentity) => void>();

  /** Voice ID is on with the model and his profile from that model: only then does a verdict decide anything. */
  const running = () =>
    input.settings().on &&
    input.voiceId.embedder() !== null &&
    input.voiceId
      .profiles()
      .some((p) => p.kind === "owner" && p.model === input.policy.model);

  const gate = (): SpeakerGate => {
    const s = input.settings();
    // Strict (D8) means "Voice ID cannot run", which needs Voice ID to be on in the first place.
    return { ...s, strictWhenUnavailable: s.on && s.strictWhenUnavailable };
  };

  const decided = (identity: SpeakerIdentity, use: "turn" | "barge", ms: number) => {
    if (use === "turn") {
      last = identity;
      listeners.forEach((l) => l(identity));
    }
    input.onNote?.("speaker", {
      use,
      kind: identity.kind,
      personId: identity.personId,
      confidence: identity.confidence === null ? null : Math.round(identity.confidence * 1000) / 1000,
      verified: identity.verified,
      inherited: identity.inherited,
      ms,
    });
    return identity;
  };

  const hear = async (pcm: Int16Array, use: "turn" | "barge"): Promise<SpeakerIdentity> => {
    const at = input.now();
    const ms = Math.round((pcm.length * 1000) / RATE);
    const embedder = input.voiceId.embedder();
    if (!input.settings().on || embedder === null) return decided(UNVERIFIED(at), use, ms);
    if (ms < input.policy.minSpeechMs) {
      // A short follow-up keeps the last verdict for listening only; it is never verified.
      const kept =
        use === "turn" && last !== null && last.kind !== "unverified" && at - last.at < INHERIT_MS
          ? { ...last, verified: false, inherited: true, at }
          : UNVERIFIED(at);
      return decided(kept, use, ms);
    }
    const vector = await embedder.embed(pcm).catch(() => null);
    if (vector === null) return decided(UNVERIFIED(at), use, ms);
    const clip = { vector, ms };
    const base = {
      clips: [clip],
      model: embedder.model,
      profiles: input.voiceId.profiles(),
      policy: input.policy,
    };
    const identity = identityOf(
      decideSpeaker({ ...base, use: use === "barge" ? "steer" : "listen" }),
      decideSpeaker({ ...base, use: "act" }),
      at,
    );
    if (identity.kind === "owner" && input.settings().adapt) {
      const owner = base.profiles.find((p) => p.kind === "owner" && p.model === embedder.model);
      const moved = owner === undefined ? null : adaptProfile(owner, clip, input.policy);
      if (moved !== null) input.voiceId.save(moved);
    }
    return decided(identity, use, ms);
  };

  return {
    hear,
    admits: (identity: SpeakerIdentity, use: "turn" | "barge") => admits(identity, gate(), use),
    /** While Voice ID is running, a cut-in waits for this much speech to be judged (D3); otherwise none. */
    bargeMs: () => (running() ? input.policy.minSpeechMs : null),
    /** Voice ID decides something here: on, with the model and his profile. Off this, everything is as before. */
    running,
    /** Who spoke the turn now running; unverified before anyone has. */
    current: (): SpeakerIdentity => last ?? UNVERIFIED(input.now()),
    onTurn: (listener: (identity: SpeakerIdentity) => void) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    /** Another microphone: an earlier verdict says nothing about who is on this one. */
    reset: () => {
      last = null;
    },
  };
};

export type SpeakerIdentityService = ReturnType<typeof createSpeakerIdentity>;

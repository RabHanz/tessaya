// @effect-diagnostics globalDate:off
/**
 * Voice ID on this computer (VOICE-ID): the voice model while it is on, the profiles, and enrolment by reading
 * aloud through Tessaya's own microphone. Settings drives it (voiceIdRows.ts). Only vectors are kept, never audio.
 */
import type { SpeakerEmbedder, SpeakerProfile } from "@t3tools/baton-voice";

import {
  ENROLMENT_SENTENCES,
  enrolOwner,
  enrolSaved,
  SAVED_PERSON_LINES,
} from "./speakerEnrolment.ts";
import { createSpeakerStore } from "./speakerStore.ts";
import type { VoiceIdModelState, VoiceIdSettings, VoiceIdView } from "./voiceIdRows.ts";

const RATE = 16_000;
/** His read with the Wispr seed beside it; alone it is all there is, so it is longer. */
const OWNER_READ_S = 20;
const OWNER_ONLY_READ_S = 30;
const PERSON_READ_S = 20;

type Embedder = SpeakerEmbedder & { readonly close: () => void };

interface Capture {
  readonly who: { readonly kind: "owner" } | { readonly kind: "saved"; readonly name: string };
  readonly lines: ReadonlyArray<string>;
  readonly need: number;
  readonly frames: Int16Array[];
  got: number;
}

export const createVoiceId = (input: {
  readonly stateDir: string;
  /** His name, for his profile. */
  readonly ownerName: () => string;
  readonly settings: () => VoiceIdSettings;
  /** The model file on disk, downloaded on first use. */
  readonly ensureModel: () => Promise<string>;
  /** Opens it in the voice model worker. */
  readonly openModel: (path: string) => Promise<Embedder>;
  readonly model: string;
  readonly appData: string | undefined;
  readonly onChange: () => void;
  /** A saved person was removed: their own memory goes with them. */
  readonly onPersonDeleted?: (id: string) => void;
  readonly onNote?: (kind: string, fields: Readonly<Record<string, unknown>>) => void;
}) => {
  const store = createSpeakerStore(input.stateDir);
  let profiles = store.list();
  let embedder: Embedder | null = null;
  let modelState: VoiceIdModelState = "off";
  let capture: Capture | null = null;
  let note: string | null = null;
  let opening: Promise<void> | null = null;
  /** The last model load or enrolment, for whoever must wait for it (tests, a re-render). */
  let busy: Promise<void> = Promise.resolve();

  const changed = () => input.onChange();
  const reread = () => {
    profiles = store.list();
  };

  const start = () => {
    if (!input.settings().on || embedder !== null || opening !== null) return;
    modelState = "loading";
    changed();
    opening = (async () => {
      try {
        const opened = await input.openModel(await input.ensureModel());
        if (!input.settings().on) opened.close();
        else embedder = opened;
        modelState = input.settings().on ? "ready" : "off";
      } catch (error) {
        modelState = "failed";
        input.onNote?.("voice_id_model_failed", {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        opening = null;
        changed();
      }
    })();
    busy = opening;
  };

  const stop = () => {
    embedder?.close();
    embedder = null;
    capture = null;
    modelState = "off";
    changed();
  };

  const finish = async (done: Capture) => {
    const pcm = new Int16Array(done.got);
    let at = 0;
    for (const f of done.frames) {
      pcm.set(f.subarray(0, Math.min(f.length, pcm.length - at)), at);
      at += f.length;
    }
    const model = embedder;
    if (model === null) return;
    try {
      if (done.who.kind === "owner") {
        const result = await enrolOwner({
          name: input.ownerName(),
          embedder: model,
          useWispr: input.settings().wisprSeed,
          appData: input.appData,
          spoken: pcm,
          save: store.save,
          now: new Date(),
        });
        note = result.saved
          ? `Your voice: made from ${result.samples} clips${result.wisprClips > 0 ? ` (${result.wisprClips} Wispr recordings read)` : ""}.`
          : "Not enough of your voice was heard to tell it apart. Try again somewhere quieter.";
        input.onNote?.("voice_id_enrolled", { who: "owner", ...result });
      } else {
        const name = done.who.name;
        const made = await enrolSaved({
          name,
          taken: profiles.map((p) => p.id),
          embedder: model,
          spoken: pcm,
          consentNote: `${name} agreed aloud in Settings and read the lines, ${new Date().toISOString()}.`,
          save: store.save,
          now: new Date(),
        });
        note =
          made === null
            ? `Not enough of ${name}'s voice was heard. Try again with ${name} reading all three lines.`
            : `I'll know ${name}'s voice now. They can ask me things, but they can't make me do anything.`;
        input.onNote?.("voice_id_enrolled", { who: "saved", saved: made !== null });
      }
    } catch (error) {
      note = "The voice profile could not be made. Nothing was saved.";
      input.onNote?.("voice_id_enrol_failed", {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    reread();
    changed();
  };

  return {
    /** Settings changed: the model follows the switch. */
    sync: () => (input.settings().on ? start() : stop()),
    profiles: () => profiles,
    /** The open model, while Voice ID is on and ready. */
    embedder: () => (modelState === "ready" ? embedder : null),
    /** Starts a read: the next seconds of the microphone are this person's. */
    read: (who: Capture["who"]) => {
      if (embedder === null || capture !== null) return;
      const seconds =
        who.kind === "saved"
          ? PERSON_READ_S
          : input.settings().wisprSeed
            ? OWNER_READ_S
            : OWNER_ONLY_READ_S;
      capture = {
        who,
        lines: who.kind === "saved" ? SAVED_PERSON_LINES : ENROLMENT_SENTENCES,
        need: seconds * RATE,
        frames: [],
        got: 0,
      };
      note = null;
      changed();
    },
    /** Every microphone frame; only a read keeps any, and only until it has enough. */
    push: (frame: Int16Array) => {
      const c = capture;
      if (c === null) return;
      const before = Math.ceil((c.need - c.got) / RATE);
      c.frames.push(frame.slice());
      c.got += frame.length;
      if (c.got >= c.need) {
        capture = null;
        c.got = c.need;
        changed();
        busy = finish(c);
      } else if (Math.ceil((c.need - c.got) / RATE) !== before) changed();
    },
    remove: (id: string) => {
      store.remove(id);
      reread();
      if (id !== "owner") input.onPersonDeleted?.(id);
      note = id === "owner" ? "Your voice profile is deleted." : "Removed.";
      changed();
    },
    /** A profile that changed elsewhere (adaptation). */
    save: (profile: SpeakerProfile) => {
      store.save(profile);
      reread();
    },
    settled: () => busy,
    view: (listening: boolean): VoiceIdView => ({
      settings: input.settings(),
      profiles,
      model: input.model,
      modelState,
      capture:
        capture === null
          ? null
          : {
              name: capture.who.kind === "owner" ? "you" : capture.who.name,
              lines: capture.lines,
              secondsLeft: Math.ceil((capture.need - capture.got) / RATE),
            },
      note,
      listening,
    }),
    close: stop,
  };
};

export type VoiceId = ReturnType<typeof createVoiceId>;

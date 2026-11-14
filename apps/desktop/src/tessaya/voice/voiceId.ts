// @effect-diagnostics globalDate:off
/**
 * Voice ID on this computer (VOICE-ID): the voice model while it is on, the profiles, and enrolment by reading
 * aloud through Tessaya's own microphone. Settings drives it (voiceIdRows.ts). Only vectors are kept, never audio.
 */
import {
  CAMPLUS_POLICY,
  createEnrolGuide,
  createSpeakerStore,
  enrolScript,
  type EnrolGuide,
  type SpeakerEmbedder,
  type SpeakerProfile,
} from "@t3tools/tessaya-voice";

import { DEVICE } from "@t3tools/tessaya-shared/productNames";
import { enrolOwner, enrolSaved, personId, SAVED_PERSON_LINES } from "./speakerEnrolment.ts";
import type { VoiceIdModelState, VoiceIdSettings, VoiceIdView } from "./voiceIdRows.ts";

const RATE = 16_000;
/** New speech before the recogniser hears the sentence again, for the card's highlight. */
const HEAR_EVERY = RATE * 0.7;

type Embedder = SpeakerEmbedder & { readonly close: () => void };

interface Capture {
  readonly who:
    | { readonly kind: "owner" }
    /** `id`: a household member's id, so their profile and their member are one person. */
    | { readonly kind: "saved"; readonly name: string; readonly id?: string };
  readonly guide: EnrolGuide;
  /** The take and how much of it the recogniser last heard; one transcription at a time. */
  heard: { no: number; samples: number } | null;
  hearing: boolean;
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
  /** A new enrolment here: the home server keeps it as that member's one profile, for every device. */
  /** The saved profile, and the read lines' audio (16 kHz PCM16) it was made from. */
  readonly onEnrolled?: (profile: SpeakerProfile, clips: ReadonlyArray<Int16Array>) => void;
  /** The local recogniser, so the card can follow his words; without it the card follows his pauses alone. */
  readonly transcribe?: (pcm: Int16Array) => Promise<string>;
  /** The microphone he is reading into, in his words. */
  readonly micName?: () => string;
  /** His first name for the script, or null. */
  readonly scriptName?: string | null;
  /**
   * Whether a saved person is a member of this home, asked of its home server: only members' voices are kept. Absent,
   * anyone may be saved (a desktop with no household).
   */
  readonly isMember?: (id: string) => Promise<boolean>;
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
    const clips = done.guide.clips();
    const pcm = new Int16Array(clips.reduce((n, c) => n + c.length, 0));
    let at = 0;
    for (const c of clips) {
      pcm.set(c, at);
      at += c.length;
    }
    const model = embedder;
    if (model === null) return;
    let saved = false;
    let rows: Array<{ label: string; value: string }> = [];
    try {
      if (done.who.kind === "owner") {
        const result = await enrolOwner({
          name: input.ownerName(),
          embedder: model,
          useWispr: input.settings().wisprSeed,
          appData: input.appData,
          spoken: pcm,
          save: (p: SpeakerProfile) => {
            store.save(p);
            input.onEnrolled?.(p, clips);
          },
          now: new Date(),
        });
        saved = result.saved;
        if (result.wisprClips > 0)
          rows = [{ label: "Also used", value: `${result.wisprClips} of your Wispr recordings` }];
        note = result.saved
          ? `Your voice: made from ${result.samples} clips${result.wisprClips > 0 ? ` (${result.wisprClips} Wispr recordings read)` : ""}.`
          : "Not enough of your voice was heard to tell it apart. Try again somewhere quieter.";
        input.onNote?.("voice_id_enrolled", { who: "owner", ...result });
      } else {
        const name = done.who.name;
        const member =
          done.who.id ??
          personId(
            name,
            profiles.map((p) => p.id),
          );
        const isMember =
          input.isMember === undefined || (await input.isMember(member).catch(() => false));
        const made = !isMember
          ? null
          : await enrolSaved({
              name,
              ...(done.who.id === undefined ? {} : { id: done.who.id }),
              taken: profiles.map((p) => p.id),
              embedder: model,
              spoken: pcm,
              consentNote: `${name} agreed aloud in Settings and read the lines, ${new Date().toISOString()}.`,
              save: (p: SpeakerProfile) => {
                store.save(p);
                input.onEnrolled?.(p, clips);
              },
              now: new Date(),
            });
        saved = made !== null;
        note = !isMember
          ? `${name} isn't a member of this home yet. Add them under Memory, Household, then enrol their voice there.`
          : made === null
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
    done.guide.finish({
      saved,
      headline: saved
        ? done.who.kind === "owner"
          ? "Your voice profile is ready"
          : `${done.who.name}'s voice is saved`
        : "Nothing was saved",
      rows: saved ? rows : [{ label: "What happened", value: note ?? "" }],
    });
    reread();
    changed();
  };

  /** The recogniser hears the sentence so far again once there is enough new speech; its words move the highlight. */
  const hear = (c: Capture) => {
    if (input.transcribe === undefined || c.hearing) return;
    const take = c.guide.take();
    if (take.pcm === null) return;
    const last = c.heard?.no === take.no ? c.heard.samples : 0;
    if (take.pcm.length - last < HEAR_EVERY) return;
    c.heard = { no: take.no, samples: take.pcm.length };
    c.hearing = true;
    void input
      .transcribe(take.pcm)
      .then((text) => {
        if (capture === c && c.guide.heard(text, take.no)) changed();
      })
      .catch(() => undefined)
      .finally(() => {
        c.hearing = false;
      });
  };

  /** A sentence passed its checks: its voice is compared with the others', then the profile is made once all are in. */
  const accept = (c: Capture, index: number, sentence: Int16Array) => {
    const model = embedder;
    const judged = (
      model === null ? Promise.resolve(null) : model.embed(sentence).catch(() => null)
    ).then(async (vector) => {
      if (capture !== c) return;
      const step = c.guide.voice(index, vector);
      if (step.changed) changed();
      if (step.ready) await finish(c);
    });
    // `settled` waits for every sentence's voice and the profile made after the last.
    busy = Promise.all([busy, judged]).then(() => undefined);
  };

  return {
    /** Settings changed: the model follows the switch. */
    sync: () => (input.settings().on ? start() : stop()),
    profiles: () => profiles,
    /** The open model, while Voice ID is on and ready. */
    embedder: () => (modelState === "ready" ? embedder : null),
    /** Starts a read: the card opens with the sentences, and the microphone is this person's until it is done. */
    read: (who: Capture["who"]) => {
      if (embedder === null || capture !== null) return;
      const owner = who.kind === "owner";
      capture = {
        who,
        guide: createEnrolGuide({
          sentences: owner ? enrolScript(input.scriptName ?? null) : SAVED_PERSON_LINES,
          title: owner ? "Read these aloud" : `${who.name}: read these aloud`,
          lead: "Use your normal voice, at your usual distance from the mic. One sentence at a time, with a short pause between them.",
          mic: input.micName?.() ?? "This computer's microphone",
          tip: owner
            ? `Using the ${DEVICE} too? Enrol again from Hardware, so Tessaya knows you on the room mic as well.`
            : null,
          otherVoiceBelow: CAMPLUS_POLICY.single.listen,
          strongFrom: CAMPLUS_POLICY.single.act + 0.15,
        }),
        heard: null,
        hearing: false,
      };
      note = null;
      changed();
    },
    /** Every microphone frame; only a read in progress keeps any, and only its sentences. */
    push: (frame: Int16Array) => {
      const c = capture;
      if (c === null || c.guide.phase() !== "reading") return;
      const step = c.guide.frame(frame);
      if (step.accepted !== null) accept(c, step.accepted.index, step.accepted.pcm);
      if (step.changed) changed();
      hear(c);
    },
    /** A read is under way: her wake word in the script must not wake her. */
    reading: () => capture !== null && capture.guide.phase() === "reading",
    /** The card's buttons: Redo starts the read again, Done or Cancel closes it. */
    card: (action: "redo" | "close") => {
      const c = capture;
      if (c === null) return;
      if (action === "close") capture = null;
      else if (c.guide.phase() !== "saving") {
        c.guide.restart();
        c.heard = null;
      }
      changed();
    },
    remove: (id: string) => {
      store.remove(id);
      reread();
      if (id !== "owner") input.onPersonDeleted?.(id);
      note = id === "owner" ? "Your voice profile is deleted." : "Removed.";
      changed();
    },
    /**
     * Keeps saved voices only for these household members: someone removed from the home, whose data was destroyed,
     * is forgotten here too. Returns the ids it removed.
     */
    keepOnly: (members: ReadonlySet<string>): ReadonlyArray<string> => {
      const gone = profiles
        .filter((p) => p.kind === "saved" && !members.has(p.id))
        .map((p) => p.id);
      for (const id of gone) {
        store.remove(id);
        input.onPersonDeleted?.(id);
      }
      if (gone.length > 0) {
        reread();
        changed();
      }
      return gone;
    },
    /**
     * Takes the home's shared profiles: a newer one replaces this device's copy and its refinements start again from it.
     * Returns the ids it took.
     */
    adoptShared: (shared: ReadonlyArray<SpeakerProfile>): ReadonlyArray<string> => {
      const taken: Array<string> = [];
      for (const p of shared) {
        const mine = profiles.find((x) => x.id === p.id && x.model === p.model);
        if (mine !== undefined && (mine.version ?? 0) >= (p.version ?? 0)) continue;
        store.save({ ...p, base: p.centroid });
        taken.push(p.id);
      }
      if (taken.length > 0) {
        reread();
        changed();
      }
      return taken;
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
      enrol: capture === null ? null : capture.guide.view(),
      note,
      listening,
    }),
    close: stop,
  };
};

export type VoiceId = ReturnType<typeof createVoiceId>;

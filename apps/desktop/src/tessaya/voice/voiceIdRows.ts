// @effect-diagnostics globalDate:off
/**
 * Settings, Voice and wake words: the Voice ID section (VOICE-ID slice 3). His profile with Re-enrol and Delete,
 * the people he saved, and one switch per open decision (D1-D8 in voiceid-plan.md), each at the plan's default
 * until he changes it.
 */
import type { EnrolCard, VoiceLearning } from "@t3tools/tessaya-contracts";
import type { SpeakerProfile } from "@t3tools/tessaya-voice";

import {
  FORGET_LEARNING,
  VOICE_ID_GATE_ROWS,
  voiceLearningLines,
  type VoiceIdGateSwitch,
} from "@t3tools/tessaya-shared/voiceIdGate";

import type { HomeControl } from "../home/tessayaHome.ts";

const gateRow = (key: VoiceIdGateSwitch) => VOICE_ID_GATE_ROWS.find((r) => r.key === key)!;

export interface VoiceIdSettings {
  /** Voice ID itself. Off: everyone who says the wake word is heard, as before. */
  readonly on: boolean;
  /** D1: other voices get read-only answers. Off: only he (and, per D2, saved people) can wake her. */
  readonly respondToOthers: boolean;
  /** D2: with the switch above off, saved people are silenced too. Off: only unknown voices are. */
  readonly offSilencesSaved: boolean;
  /** D3: saved people may talk over her. He always can. */
  readonly savedBarge: boolean;
  /** D4: his verified "yes" confirms ordinary things. Risky acts always need the card, whatever this says. */
  readonly voiceYes: boolean;
  /** D5: saved people may leave him a message, besides read-only answers. */
  readonly savedMessages: boolean;
  /** D6: his profile follows his voice slowly from confident turns. */
  readonly adapt: boolean;
  /** D7: his profile is seeded from his Wispr Flow recordings, read-only, when he enrols. */
  readonly wisprSeed: boolean;
  /** D8: with no voice model or no profile, nobody is heard. Off: she behaves as today, logged "unverified". */
  readonly strictWhenUnavailable: boolean;
  /** When he last asked every Tessel to forget what it learnt of his voice (ms); his profile stays. */
  readonly forgetLearningAt?: number;
}

type VoiceIdSwitch = Exclude<keyof VoiceIdSettings, "forgetLearningAt">;

export const VOICE_ID_DEFAULTS: VoiceIdSettings = {
  on: false,
  respondToOthers: false,
  offSilencesSaved: false,
  savedBarge: false,
  voiceYes: true,
  savedMessages: true,
  adapt: true,
  wisprSeed: true,
  strictWhenUnavailable: false,
};

/** The switches that say who else she hears: her brain's one `voiceIdGate`, which the Tessel reads too. */
export const VOICE_ID_GATE_KEYS: ReadonlyArray<VoiceIdSwitch> = [
  "respondToOthers",
  "offSilencesSaved",
  "savedBarge",
  "strictWhenUnavailable",
];
export const gateOf = (v: VoiceIdSettings) => ({
  respondToOthers: v.respondToOthers,
  offSilencesSaved: v.offSilencesSaved,
  savedBarge: v.savedBarge,
  strictWhenUnavailable: v.strictWhenUnavailable,
  ...(v.forgetLearningAt === undefined ? {} : { forgetLearningAt: v.forgetLearningAt }),
});

/** Each saved field on its own: a missing or wrong-typed one keeps its default. */
export const parseVoiceIdSettings = (saved: unknown): VoiceIdSettings => {
  const v = typeof saved === "object" && saved !== null ? (saved as Record<string, unknown>) : {};
  const pick = (key: VoiceIdSwitch) =>
    typeof v[key] === "boolean" ? (v[key] as boolean) : VOICE_ID_DEFAULTS[key];
  return {
    on: pick("on"),
    respondToOthers: pick("respondToOthers"),
    offSilencesSaved: pick("offSilencesSaved"),
    savedBarge: pick("savedBarge"),
    voiceYes: pick("voiceYes"),
    savedMessages: pick("savedMessages"),
    adapt: pick("adapt"),
    wisprSeed: pick("wisprSeed"),
    strictWhenUnavailable: pick("strictWhenUnavailable"),
    ...(typeof v["forgetLearningAt"] === "number"
      ? { forgetLearningAt: v["forgetLearningAt"] }
      : {}),
  };
};

/** The switch rows' ids and the setting each one flips. */
export const VOICE_ID_SWITCHES: Readonly<Record<string, VoiceIdSwitch>> = {
  "vid.on": "on",
  "vid.others": "respondToOthers",
  "vid.savedOff": "offSilencesSaved",
  "vid.savedBarge": "savedBarge",
  "vid.voiceYes": "voiceYes",
  "vid.messages": "savedMessages",
  "vid.adapt": "adapt",
  "vid.wispr": "wisprSeed",
  "vid.strict": "strictWhenUnavailable",
};

export type VoiceIdModelState = "off" | "loading" | "ready" | "failed";

export interface VoiceIdView {
  readonly settings: VoiceIdSettings;
  readonly profiles: ReadonlyArray<SpeakerProfile>;
  /** The model id profiles must match to be used. */
  readonly model: string;
  readonly modelState: VoiceIdModelState;
  /** The guided read under way, or its summary until he closes it. */
  readonly enrol: EnrolCard | null;
  /** The result of the last enrolment or deletion. */
  readonly note: string | null;
  /** The microphone is open, so a read can be heard. */
  readonly listening: boolean;
  /** What each Tessel learnt of his far voice, from her brain. */
  readonly learning?: ReadonlyArray<VoiceLearning>;
}

const SECTION = "Voice ID";

const SOURCE_LABEL = {
  wispr: "your Wispr recordings",
  spoken: "your read",
  adapted: "your recent turns",
} as const;

const statusOf = (
  view: VoiceIdView,
  owner: SpeakerProfile | undefined,
): { readonly label: string; readonly status: "ok" | "warn" | "bad"; readonly detail: string } => {
  const { settings } = view;
  if (!settings.on)
    return {
      label: "Voice ID is off",
      status: "ok",
      detail: "Anyone who says the wake word is heard.",
    };
  if (view.modelState === "loading")
    return { label: "Getting the voice model ready", status: "warn", detail: "30 MB, once." };
  if (view.modelState === "failed")
    return {
      label: "The voice model did not load",
      status: "bad",
      detail: settings.strictWhenUnavailable
        ? "Nobody is heard until it loads. Turn Voice ID off and on to try again."
        : "Everyone is heard as before, logged as unverified. Turn Voice ID off and on to try again.",
    };
  if (owner === undefined)
    return {
      label: view.profiles.some((p) => p.kind === "owner")
        ? "Voice ID needs re-enrolling after a model change"
        : "Voice ID needs your voice",
      status: "warn",
      detail: settings.strictWhenUnavailable
        ? "Nobody is heard until you enrol."
        : "Until you enrol, everyone is heard as before.",
    };
  return {
    label: "Voice ID is on",
    status: "ok",
    detail: settings.respondToOthers
      ? "Other voices get read-only answers."
      : settings.offSilencesSaved
        ? "Only you can wake her."
        : "Only you and the people you saved can wake her.",
  };
};

/** One line per Tessel, worded as on the web and the phone (tessaya-shared voiceIdGate). */
const learningRows = (
  learning: ReadonlyArray<VoiceLearning>,
  forgotAt: number | undefined,
): ReadonlyArray<HomeControl> =>
  learning.length === 0
    ? []
    : [
        ...voiceLearningLines(learning, forgotAt, (at) =>
          new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }),
        ).map((l): HomeControl => ({
          id: `vid.learning.${l.device}`,
          section: SECTION,
          kind: "check",
          status: "ok",
          label: l.label,
          detail: l.detail,
        })),
        {
          id: "vid.forgetLearning",
          section: SECTION,
          label: FORGET_LEARNING.label,
          hint: FORGET_LEARNING.hint,
          kind: "action",
          button: FORGET_LEARNING.button,
        },
      ];

export const voiceIdControls = (view: VoiceIdView): ReadonlyArray<HomeControl> => {
  const { settings } = view;
  const usable = view.profiles.filter((p) => p.model === view.model);
  const owner = usable.find((p) => p.kind === "owner");
  const people = usable.filter((p) => p.kind === "saved");
  const status = statusOf(view, owner);
  const toggle = (
    id: string,
    label: string,
    hint: string,
    on: boolean,
    more = false,
  ): HomeControl => ({ id, section: SECTION, label, hint, kind: "toggle", on, more });
  const rows: HomeControl[] = [
    toggle(
      "vid.on",
      "Voice ID",
      "Tessaya learns your voice and knows when it is you. Your profile is a list of numbers, never audio, and it stays on this computer.",
      settings.on,
    ),
    { id: "vid.status", section: SECTION, kind: "check", ...status },
  ];
  if (view.enrol !== null)
    rows.push({
      id: "vid.card",
      section: SECTION,
      label: view.enrol.title,
      kind: "enrol",
      card: view.enrol,
    });
  if (view.note !== null)
    rows.push({
      id: "vid.note",
      section: SECTION,
      kind: "check",
      status: "ok",
      label: view.note,
      detail: "",
    });
  if (settings.on && view.modelState === "ready" && view.enrol === null) {
    const cannot = view.listening ? {} : { disabled: true };
    rows.push(
      owner === undefined
        ? {
            id: "vid.enrol",
            section: SECTION,
            label: "Your voice",
            hint: view.listening
              ? `You read six short sentences aloud (about 30 s), and the card follows along${settings.wisprSeed ? ", and Tessaya also reads up to 60 of your Wispr recordings, read-only" : ""}.`
              : "Turn on voice first: the read goes through Tessaya's microphone.",
            kind: "action",
            button: "Make my voice profile",
            ...cannot,
          }
        : {
            id: "vid.enrol",
            section: SECTION,
            label: "Your voice",
            hint: `Made from ${owner.samples} clips of ${owner.sources.map((s) => SOURCE_LABEL[s]).join(" and ")}, on ${owner.enrolledAt.slice(0, 10)}.`,
            kind: "action",
            button: "Re-enrol",
            secondary: "Delete",
            ...cannot,
          },
      {
        id: "vid.people",
        section: SECTION,
        label: "People",
        hint: "Someone you add says yes and reads three lines while they sit with you. Saved people get read-only answers, and Tessaya calls them by name. Removing someone also removes what Tessaya remembers for them.",
        kind: "list",
        items: people.map((p) => p.name),
        placeholder: view.listening ? "Their name, then they read" : "Turn on voice first",
        addLabel: "Add",
        ...cannot,
      },
    );
  }
  rows.push(
    toggle(
      "vid.others",
      gateRow("respondToOthers").label,
      gateRow("respondToOthers").hint,
      settings.respondToOthers,
    ),
    toggle(
      "vid.savedBarge",
      gateRow("savedBarge").label,
      gateRow("savedBarge").hint,
      settings.savedBarge,
    ),
    toggle(
      "vid.savedOff",
      gateRow("offSilencesSaved").label,
      gateRow("offSilencesSaved").hint,
      settings.offSilencesSaved,
      true,
    ),
    toggle(
      "vid.voiceYes",
      "Your voice can say yes",
      "Your recognised voice confirms everyday things. Anything risky still needs the card on screen or on your phone.",
      settings.voiceYes,
      true,
    ),
    toggle(
      "vid.messages",
      "Saved people can leave you a message",
      "Besides read-only answers, someone you saved can ask Tessaya to tell you something.",
      settings.savedMessages,
      true,
    ),
    toggle(
      "vid.adapt",
      "Keep learning voices on this computer",
      "When Tessaya is sure who is speaking, this computer's copy of their voice moves a little towards how they sound on its mic. It stays here; every device keeps its own. Enrolling again starts from the new voice everywhere.",
      settings.adapt,
      true,
    ),
    toggle(
      "vid.wispr",
      "Use your Wispr recordings",
      "When you enrol, Tessaya reads up to 60 of your Wispr Flow recordings once, read-only, on this computer. Nothing is copied.",
      settings.wisprSeed,
      true,
    ),
    toggle(
      "vid.strict",
      gateRow("strictWhenUnavailable").label,
      gateRow("strictWhenUnavailable").hint,
      settings.strictWhenUnavailable,
      true,
    ),
    ...learningRows(view.learning ?? [], settings.forgetLearningAt),
  );
  return rows;
};

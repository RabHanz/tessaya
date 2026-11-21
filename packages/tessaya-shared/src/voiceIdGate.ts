/**
 * Voice ID's "who else she hears" switches (her brain's one `voiceIdGate`, which every Tessel reads) and what each
 * Tessel learnt of his far voice, worded once for every Settings surface: the desk, the web and the phone (M-127).
 */
import type { VoiceIdGate } from "@t3tools/contracts";
import type { VoiceLearning } from "@t3tools/tessaya-contracts";

export type VoiceIdGateSwitch = Exclude<keyof VoiceIdGate, "forgetLearningAt">;

export interface VoiceIdGateRow {
  readonly key: VoiceIdGateSwitch;
  readonly label: string;
  readonly hint: string;
  /** Matters only with Respond to other people off. */
  readonly dependsOnOthersOff?: boolean;
}

export const VOICE_ID_GATE_ROWS: ReadonlyArray<VoiceIdGateRow> = [
  {
    key: "respondToOthers",
    label: "Respond to other people",
    hint: "On: voices Tessaya does not know get read-only answers. Off: they are ignored.",
  },
  {
    key: "savedBarge",
    label: "Saved people can talk over her",
    hint: "You can always cut in by talking. On: the people you saved can too.",
  },
  {
    key: "offSilencesSaved",
    label: "Off also silences saved people",
    hint: "With Respond to other people off, the people you saved are ignored too, and only you can wake her.",
    dependsOnOthersOff: true,
  },
  {
    key: "strictWhenUnavailable",
    label: "Ignore everyone if Voice ID cannot run",
    hint: "Off: without the model or your profile, Tessaya hears everyone as before and logs it as unverified. On: nobody is heard until it works.",
  },
];

export const FORGET_LEARNING = {
  label: "Forget recent voice learning",
  hint: "Each Tessel drops what it learnt of how you sound across the room and learns again from your next turns. Your voice profile stays.",
  button: "Forget",
} as const;

/** One line per Tessel; learning from before his last Forget reads as none until it learns again. */
export const voiceLearningLines = (
  learning: ReadonlyArray<VoiceLearning>,
  forgotAt: number | undefined,
  when: (at: number) => string,
): ReadonlyArray<{ readonly device: string; readonly label: string; readonly detail: string }> =>
  learning.map((l) => {
    const kept = l.farAt !== null && (forgotAt === undefined || l.farAt > forgotAt);
    return {
      device: l.device,
      label: `Voice learning on Tumble${learning.length > 1 ? ` (${l.device})` : ""}`,
      detail:
        kept && l.farClips > 0 && l.farAt !== null
          ? `${l.farClips} far ${l.farClips === 1 ? "sample" : "samples"}, last added ${when(l.farAt)}`
          : "None yet",
    };
  });

/** The gate after one change: switches set over the current ones, the last Forget kept unless he forgets again now. */
export const nextVoiceIdGate = (
  current: VoiceIdGate,
  change: { readonly gate?: Partial<VoiceIdGate>; readonly forgetLearning?: true },
  now: number,
): VoiceIdGate => {
  const { forgetLearningAt: _ignored, ...switches } = change.gate ?? {};
  return {
    ...current,
    ...switches,
    ...(change.forgetLearning === true ? { forgetLearningAt: now } : {}),
  };
};

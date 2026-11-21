/**
 * Voice ID on the web (M-127): her brain's who-else-she-hears switches and each Tessel's far-voice learning with
 * Forget, worded as on the desk and the phone (tessaya-shared voiceIdGate).
 */
import { useAtomValue } from "@effect/atom-react";
import type { VoiceIdGate } from "@t3tools/contracts";
import type { EnvironmentId, VoiceLearning } from "@t3tools/tessaya-contracts";
import {
  FORGET_LEARNING,
  VOICE_ID_GATE_ROWS,
  voiceLearningLines,
} from "@t3tools/tessaya-shared/voiceIdGate";
import { useEffect, useState } from "react";

import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

interface VoiceIdView {
  readonly gate: VoiceIdGate;
  readonly learning: ReadonlyArray<VoiceLearning>;
}
const SET = { kind: "owner", op: "setVoiceId" } as const;

export function VoiceIdSettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const voiceCall = useAtomCommand(tessayaWorkSessions.voiceCall, { reportFailure: false });
  const canSet = useAtomValue(tessayaWorkSessions.voiceCall.permissionAtom(environmentId, SET));
  const [view, setView] = useState<VoiceIdView | null>(null);
  const [note, setNote] = useState("");
  const call = async (input: { kind: "read" | "owner"; op: string; args: object }) => {
    const r = await voiceCall({
      environmentId,
      input: { ...input, args: input.args as Record<string, unknown> },
    });
    if (r._tag === "Success" && r.value.ok) {
      setView(r.value.value as VoiceIdView);
      setNote("");
    } else
      setNote(
        r._tag === "Success"
          ? (r.value.error ?? "That was not saved.")
          : "Couldn't reach her brain.",
      );
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads her brain's switches once per environment
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect, react/exhaustive-effect-dependencies -- the read closes over this environment
    void call({ kind: "read", op: "voiceId", args: {} });
  }, [environmentId]);
  const gate = view?.gate;
  return (
    <SettingsSection id="voice-id" title="Voice ID">
      {VOICE_ID_GATE_ROWS.map((row) => (
        <SettingsRow
          key={row.key}
          title={row.label}
          description={row.hint}
          control={
            <Switch
              aria-label={row.label}
              checked={gate?.[row.key] ?? false}
              disabled={
                gate === undefined ||
                !canSet ||
                (row.dependsOnOthersOff === true && gate.respondToOthers)
              }
              onCheckedChange={(on) =>
                void call({ ...SET, args: { gate: { ...gate, [row.key]: on } } })
              }
            />
          }
        />
      ))}
      {voiceLearningLines(view?.learning ?? [], gate?.forgetLearningAt, (at) =>
        new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }),
      ).map((l) => (
        <SettingsRow key={l.device} title={l.label} description={l.detail} />
      ))}
      <SettingsRow
        title={FORGET_LEARNING.label}
        description={note === "" ? FORGET_LEARNING.hint : note}
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={!canSet || gate === undefined}
            onClick={() => void call({ ...SET, args: { forgetLearning: true } })}
          >
            {FORGET_LEARNING.button}
          </Button>
        }
      />
    </SettingsSection>
  );
}

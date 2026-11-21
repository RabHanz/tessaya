/**
 * Voice ID on the phone (M-127): her brain's who-else-she-hears switches and each Tessel's far-voice learning with
 * Forget, worded as on the desk and the web (tessaya-shared voiceIdGate).
 */
import { useAtomValue } from "@effect/atom-react";
import type { VoiceIdGate } from "@t3tools/contracts";
import type { VoiceLearning } from "@t3tools/tessaya-contracts";
import {
  FORGET_LEARNING,
  VOICE_ID_GATE_ROWS,
  voiceLearningLines,
} from "@t3tools/tessaya-shared/voiceIdGate";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { ListToggleRow } from "../../../components/ui/ListToggleRow";
import { tessayaEnvironmentIdAtom } from "../../../state/tessayaHousehold";
import { tessayaWorkSessions } from "../../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../../state/use-atom-command";
import { SettingsSection } from "../../settings/components/SettingsSection";

interface VoiceIdView {
  readonly gate: VoiceIdGate;
  readonly learning: ReadonlyArray<VoiceLearning>;
}
const SET = { kind: "owner", op: "setVoiceId" } as const;

export function VoiceIdSection() {
  const environmentId = useAtomValue(tessayaEnvironmentIdAtom);
  const voiceCall = useAtomCommand(tessayaWorkSessions.voiceCall, { reportFailure: false });
  const canSet = useAtomValue(tessayaWorkSessions.voiceCall.permissionAtom(environmentId, SET));
  const [view, setView] = useState<VoiceIdView | null>(null);
  const [note, setNote] = useState("");
  const call = async (input: { kind: "read" | "owner"; op: string; args: object }) => {
    if (environmentId === null) return;
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
  if (environmentId === null) return null;
  const gate = view?.gate;
  return (
    <SettingsSection
      title="Voice ID"
      footer="Who besides you she hears, on every Tessel. Your own voice profile is set up on your computer."
    >
      {VOICE_ID_GATE_ROWS.map((row) => (
        <ListToggleRow
          key={row.key}
          label={row.label}
          description={row.hint}
          disabled={
            gate === undefined ||
            !canSet ||
            (row.dependsOnOthersOff === true && gate.respondToOthers)
          }
          value={gate?.[row.key] ?? false}
          onValueChange={(on) => void call({ ...SET, args: { gate: { ...gate, [row.key]: on } } })}
        />
      ))}
      {voiceLearningLines(view?.learning ?? [], gate?.forgetLearningAt, (at) =>
        new Date(at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }),
      ).map((l) => (
        <ListRowLayout key={l.device} label={l.label} description={l.detail} />
      ))}
      <View className="flex-row items-center justify-between gap-3 px-4 py-3">
        <View className="flex-1">
          <Text className="text-base text-foreground">{FORGET_LEARNING.label}</Text>
          <Text className="text-sm text-foreground-muted">{FORGET_LEARNING.hint}</Text>
        </View>
        <Button
          size="compact"
          tone="text"
          label={FORGET_LEARNING.button}
          disabled={!canSet || gate === undefined}
          onPress={() => void call({ ...SET, args: { forgetLearning: true } })}
        />
      </View>
      {note === "" ? null : <Text className="px-4 pb-3 text-sm text-foreground-muted">{note}</Text>}
    </SettingsSection>
  );
}

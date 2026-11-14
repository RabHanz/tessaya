import { useAtomValue } from "@effect/atom-react";
import type { PillDesign, PillWave } from "@t3tools/tessaya-shared/composerDictation";
import { useColorScheme, View } from "react-native";
import { useSharedValue } from "react-native-reanimated";

import { SegmentedControl } from "../../../../components/ui/SegmentedControl";
import { tessayaWorkSessions } from "../../../../state/tessayaWorkSessions";
import { useEnvironments } from "../../../../state/environments";
import { useAtomCommand } from "../../../../state/use-atom-command";
import {
  saveLocalPillChoice,
  sharedEnvironmentsAtom,
  useLocalPillChoice,
  usePillLook,
  type PillChoice,
} from "../../../voice-input/pillLook";
import { TessayaDictationPill } from "../../../voice-input/TessayaDictationPill";
import { SettingsSection } from "../../components/SettingsSection";

const DESIGNS: ReadonlyArray<{ readonly value: PillDesign; readonly label: string }> = [
  { value: "tessaya", label: "Tessaya" },
  { value: "quiet", label: "Quiet" },
  { value: "lively", label: "Lively" },
];
const WAVES: ReadonlyArray<{ readonly value: PillWave; readonly label: string }> = [
  { value: "match", label: "Match" },
  { value: "mound", label: "Mound" },
  { value: "bars", label: "Bars" },
  { value: "beads", label: "Beads" },
];
/** The preview's still waveform: a moment of ordinary speech. */
const PREVIEW = Array.from({ length: 64 }, (_, i) => 0.45 + 0.2 * Math.cos(i * 0.55));

/** Settings → Appearance → Dictation: the chat box's dictation control, shared with a desktop that reports one. */
export function DictationAppearanceSection() {
  const { environments } = useEnvironments();
  const shared = useAtomValue(
    sharedEnvironmentsAtom(environments.map((e) => e.environmentId).join(",")),
  );
  // Shown as the phone holds it, so a change shows at once; the desktop takes it on its next report.
  const choice = useLocalPillChoice();
  const setDesktop = useAtomCommand(tessayaWorkSessions.desktopSettingsSet, {
    reportFailure: false,
  });
  const look = usePillLook(null);
  const dark = useColorScheme() === "dark";
  const previewLevels = useSharedValue<ReadonlyArray<number>>(PREVIEW);

  const choose = (next: PillChoice) => {
    saveLocalPillChoice(next);
    for (const { environmentId } of shared)
      void setDesktop({
        environmentId,
        input: { patch: { pillDesign: next.design, pillWaveform: next.wave } },
      });
  };

  return (
    <SettingsSection
      title="Dictation"
      footer={
        shared.length > 0
          ? "Shared with your desktop: a change here changes it there too."
          : "The control in the chat box while you dictate. Colours follow your theme."
      }
    >
      <View pointerEvents="none" className="items-center py-3">
        <TessayaDictationPill
          design={look.design}
          wave={look.wave}
          tokens={look.tokens}
          dark={dark}
          levels={previewLevels}
          label="Preview"
          confirmable
          onCancel={() => {}}
          onConfirm={() => {}}
        />
      </View>
      <View className="gap-3 px-4 pb-3">
        <SegmentedControl
          variant="card"
          options={DESIGNS}
          selected={choice.design}
          onSelect={(design) => choose({ ...choice, design })}
        />
        <SegmentedControl
          variant="card"
          options={WAVES}
          selected={choice.wave}
          onSelect={(wave) => choose({ ...choice, wave })}
        />
      </View>
    </SettingsSection>
  );
}

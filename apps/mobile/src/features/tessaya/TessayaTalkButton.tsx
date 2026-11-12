import * as Haptics from "expo-haptics";
import { useRef, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { batonWorkSessions } from "../../state/batonWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { CompactVoiceWaveform } from "../voice-input/ComposerDictationControl";
import { useVoiceInputController } from "../voice-input/useVoiceInputController";
import { talkGesture } from "./tessayaTabs";
import { useTessayaHome } from "./TessayaTodayScreen";

const SIZE = 64;
// Clears the tab bar (iOS 49pt, Android's 80dp) and sits in the thumb's reach, centred.
const ABOVE_TAB_BAR = Platform.OS === "android" ? 92 : 58;
const NO_SELECTION = { start: 0, end: 0 } as const;

/**
 * Talk to Tessaya from any tab: hold and speak, let go to send; a short tap keeps listening until tapped again. What
 * was heard goes to her on his computer (the phone relay's `ask`), and her answer line shows above the button.
 */
export function TessayaTalkButton() {
  const insets = useSafeAreaInsets();
  const home = useTessayaHome();
  const phoneCall = useAtomCommand(batonWorkSessions.phoneCall, { reportFailure: false });
  const [line, setLine] = useState<string | null>(null);
  const pressedAt = useRef(0);
  const draft = useRef("");
  const ask = (text: string) => {
    const words = text.trim();
    if (home === null || words.length === 0) return;
    setLine("Sent to Tessaya…");
    void phoneCall({
      environmentId: home,
      input: { op: "ask", args: { id: `talk-${Date.now().toString(36)}`, text: words } },
    }).then((result) => {
      const value = result._tag === "Success" ? (result.value.value as { line?: unknown }) : null;
      setLine(typeof value?.line === "string" ? value.line : "Tessaya didn't get that. Try again.");
    });
  };
  const voice = useVoiceInputController({
    ownerKey: "tessaya-talk",
    label: "Tessaya",
    readDraftMessage: () => draft.current,
    subscribeToDraftChanges: () => () => undefined,
    selection: NO_SELECTION,
    disabled: home === null,
    onChangeDraftMessage: (text) => {
      draft.current = "";
      ask(text);
    },
    onChangeSelection: () => undefined,
  });
  const listening = voice.isBusy;
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: insets.bottom + ABOVE_TAB_BAR,
        alignItems: "center",
        gap: 8,
      }}
    >
      {line === null ? null : (
        <Text textRole="footnote" className="rounded-full bg-sheet px-3 py-1 text-foreground">
          {line}
        </Text>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={listening ? "Stop and send to Tessaya" : "Talk to Tessaya"}
        accessibilityHint="Hold to talk, let go to send. Tap to keep listening."
        disabled={home === null || !voice.isAvailable}
        onPressIn={() => {
          pressedAt.current = Date.now();
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);
          if (!listening) {
            setLine(null);
            voice.start();
          }
        }}
        onPressOut={() => {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => undefined);
          // A hold sends on release; a tap starts listening and the next tap sends.
          const held = talkGesture(Date.now() - pressedAt.current) === "hold";
          if (held || listening) void voice.stop();
        }}
        className="items-center justify-center rounded-full bg-primary"
        style={{ width: SIZE, height: SIZE }}
      >
        {listening ? (
          <CompactVoiceWaveform audioLevels={voice.audioLevels} />
        ) : (
          <SymbolView name="mic" size={26} tintColorClassName="text-primary-foreground" />
        )}
      </Pressable>
    </View>
  );
}

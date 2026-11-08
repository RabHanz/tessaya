import { batonDesktopBridge } from "@t3tools/baton-contracts";

import { Button } from "../components/ui/button";
import {
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "../components/settings/settingsLayout";

type TessayaDictation = NonNullable<
  NonNullable<ReturnType<typeof batonDesktopBridge>>["tessayaDictation"]
>;

/** Tessaya's dictation when its voice runs on this desktop (P8); web and mobile keep T3's own. */
export const tessayaDictation = (): TessayaDictation | undefined =>
  batonDesktopBridge()?.tessayaDictation;

/**
 * T3's microphone controls driving Tessaya's engine and pill: always available (Tessaya owns setup and the microphone),
 * and T3's own recording state stays idle, since the pill shows the recording and Tessaya types the words in.
 */
export function withTessayaDictation<
  Speech extends {
    readonly available: boolean;
    readonly start: () => Promise<void>;
    readonly stop: () => Promise<void>;
    readonly cancel: () => void;
  },
>(speech: Speech, dictation: TessayaDictation | undefined): Speech {
  if (dictation === undefined) return speech;
  return {
    ...speech,
    available: true,
    start: async () => dictation.start(),
    stop: async () => dictation.stop(),
    cancel: () => dictation.stop(),
  };
}

/** Settings → Voice on a desktop where Tessaya's voice runs: one place for dictation settings, Tessaya's. */
export function BatonVoiceSettingsNotice({ dictation }: { readonly dictation: TessayaDictation }) {
  return (
    <SettingsPageContainer>
      <SettingsSection id="voice-input" title="Input">
        <SettingsRow
          title="Dictation on this computer is Tessaya's"
          description="T3's microphone buttons dictate through Tessaya: its pill, its engine, its words and keys."
          control={
            <Button size="sm" variant="outline" onClick={dictation.openSettings}>
              Open Dictation settings
            </Button>
          }
        />
      </SettingsSection>
    </SettingsPageContainer>
  );
}

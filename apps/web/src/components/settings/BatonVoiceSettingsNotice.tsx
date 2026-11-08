import type { TessayaDictation } from "../../speech/batonDictation";
import { Button } from "../ui/button";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

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

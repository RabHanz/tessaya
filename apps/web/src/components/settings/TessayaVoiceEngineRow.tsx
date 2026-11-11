import type { EnvironmentId, SpeechEngine } from "@t3tools/contracts";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow } from "./settingsLayout";

const LABELS: Readonly<Record<SpeechEngine, string>> = {
  tessaya: "Tessaya voice",
  t3: "T3 built-in",
};

/** Whose recogniser and cleanup hear audio sent to this environment; a setting of that environment. */
export function TessayaVoiceEngineRow(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly disabled: boolean;
}) {
  const engine = useEnvironmentSettings(props.environmentId, (settings) => settings.speechEngine);
  const update = useUpdateEnvironmentSettings(props.environmentId);
  return (
    <SettingsRow
      title="Voice engine"
      description={
        engine === "tessaya"
          ? `English. Heard by the desktop app’s recogniser when ${props.label} runs it and is free, else by the model below, then cleaned as Tessaya dictation is: names, punctuation, lists. Sent to Claude as text.`
          : `${props.label}'s model as T3 ships it, for other languages and translation. Cleanup is the separate option below.`
      }
      control={
        <Select
          value={engine}
          disabled={props.disabled}
          onValueChange={(value) => {
            if (value === "tessaya" || value === "t3") update({ speechEngine: value });
          }}
        >
          <SelectTrigger size="sm" aria-label="Voice engine" className="max-w-72">
            <SelectValue>{LABELS[engine]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            <SelectItem value="tessaya">{LABELS.tessaya}</SelectItem>
            <SelectItem value="t3">{LABELS.t3}</SelectItem>
          </SelectPopup>
        </Select>
      }
    />
  );
}

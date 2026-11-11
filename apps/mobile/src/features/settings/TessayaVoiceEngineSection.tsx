import { AuthSettingsWriteScope } from "@t3tools/contracts";

import { ListChoiceRow } from "../../components/ui/ListChoiceRow";
import type { EnvironmentPresentation } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

/** Whose recogniser and cleanup hear what this phone sends to the environment; a setting of that environment. */
export function TessayaVoiceEngineSection(props: {
  readonly environment: EnvironmentPresentation;
}) {
  const { environment } = props;
  const writable = useEnvironmentsWithScope([environment], AuthSettingsWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "voice engine update",
    reportFailure: true,
  });
  const engine = environment.serverConfig?.settings.speechEngine;
  if (engine === undefined) return null;
  const disabled = !writable.has(environment.environmentId);
  const choose = (speechEngine: typeof engine) =>
    void updateSettings({
      environmentId: environment.environmentId,
      input: { patch: { speechEngine } },
    });
  return (
    <SettingsSection title={`Voice engine on ${environment.label}`}>
      <ListChoiceRow
        label="Tessaya voice"
        description="English. Tessaya's recogniser when that computer runs the desktop app, then its cleanup: your names, punctuation and lists. The words go to Claude as text."
        selected={engine === "tessaya"}
        disabled={disabled}
        onPress={() => choose("tessaya")}
      />
      <ListChoiceRow
        label="T3 built-in"
        description="The environment's model as T3 ships it, for other languages and translation."
        selected={engine === "t3"}
        separated
        disabled={disabled}
        onPress={() => choose("t3")}
      />
    </SettingsSection>
  );
}

import {
  AuthSettingsWriteScope,
  chooseDictationCleanup,
  newestDictationCleanup,
} from "@t3tools/contracts";
import { supportsSharedSettingsSync } from "@t3tools/client-runtime/state/shared-settings";

import { useEnvironments } from "../../state/environments";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentsWithScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

/** Tessaya: the one dictation cleanup setting, shown as its newest copy and changed on every environment reached. */
export function DictationCleanupSection() {
  const targets = useEnvironments().environments.filter(supportsSharedSettingsSync);
  const writable = useEnvironmentsWithScope(targets, AuthSettingsWriteScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "dictation cleanup update",
    reportFailure: true,
  });
  const current = newestDictationCleanup(
    targets.flatMap((target) =>
      target.serverConfig ? [target.serverConfig.settings.dictationCleanup] : [],
    ),
  );
  if (current === null) return null;
  const choose = (enabled: boolean) => {
    const dictationCleanup = chooseDictationCleanup(current, { enabled }, Date.now());
    for (const { environmentId } of targets)
      if (writable.has(environmentId))
        void updateSettings({ environmentId, input: { patch: { dictationCleanup } } });
  };
  return (
    <SettingsSection title="Dictation cleanup">
      <SettingsSwitchRow
        label="Clean up dictation"
        subtitle="Fixes punctuation, numbers and spoken corrections with a model. One setting for the desktop app, the web and this phone, on every environment."
        value={current.enabled}
        disabled={writable.size === 0}
        onValueChange={choose}
      />
    </SettingsSection>
  );
}

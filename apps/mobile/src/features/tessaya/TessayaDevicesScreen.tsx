import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";

/** Devices in Tessaya's phone app: the same Hardware and Home Assistant pages as her computer window. */
export function TessayaDevicesScreen() {
  return (
    <SettingsScreen title="Devices" workspaceRoot>
      <SettingsSection title="Around you">
        <SettingsRow
          icon="face.smiling"
          label="Hardware"
          value="Your R1, NFC tags and the room brain"
          valuePosition="below"
          target="SettingsHardware"
        />
        <SettingsRow
          icon="house"
          label="Home Assistant"
          value="Lights and rooms she can switch"
          valuePosition="below"
          target="SettingsHome"
        />
      </SettingsSection>
    </SettingsScreen>
  );
}

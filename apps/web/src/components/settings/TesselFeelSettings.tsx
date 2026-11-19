/**
 * Tessels › how a Tessel answers being moved, and its haptics: moved here whole from Brain (D-038), since both are
 * about the device in his hand, not her mind.
 */
import type { EnvironmentId } from "@t3tools/tessaya-contracts";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Switch } from "../ui/switch";
import { Choice } from "./BrainSettings";
import { SettingsRow, SettingsSection } from "./settingsLayout";

const SENSITIVITY_LABELS: Readonly<Record<string, string>> = {
  low: "Low",
  normal: "Normal",
  high: "High",
};
const MOVED_ROWS = [
  { key: "lifted", title: "Picked up", description: "Lifted off its spot or carried about." },
  { key: "setdown", title: "Put down", description: "Set back on a desk, dock or table." },
  {
    key: "shaken",
    title: "Shaken",
    description: "A hard or long shake also speaks during a talk.",
  },
  { key: "dropped", title: "Dropped", description: "A fall that lands; also at night." },
] as const;

/** How a Tessel answers being moved: her eyes, her mood and a line of her own. */
export function BeingMoved({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const moved = useEnvironmentSettings(environmentId, (s) => s.tessayaMotion);
  const update = useUpdateEnvironmentSettings(environmentId);
  return (
    <SettingsSection title="Being moved">
      <SettingsRow
        title="Sensitivity"
        description="How hard a shake or pick-up must be to count. Low ignores desk bumps best; high feels a gentle lift."
        control={
          <Choice
            label="Motion sensitivity"
            value={moved.sensitivity}
            options={["low", "normal", "high"] as const}
            labels={SENSITIVITY_LABELS}
            onChange={(next) => update({ tessayaMotion: { sensitivity: next } })}
          />
        }
      />
      {MOVED_ROWS.map((row) => (
        <SettingsRow
          key={row.key}
          title={row.title}
          description={row.description}
          control={
            <Switch
              aria-label={row.title}
              checked={moved[row.key]}
              onCheckedChange={(on) => update({ tessayaMotion: { [row.key]: on } })}
            />
          }
        />
      ))}
    </SettingsSection>
  );
}

const HAPTIC_LABELS: Readonly<Record<string, string>> = {
  off: "Off",
  low: "Low",
  normal: "Normal",
  high: "High",
};
const HAPTIC_ROWS = [
  {
    key: "reactions",
    title: "Being moved",
    description: "A purr when picked up, a giggle when shaken, a jolt when dropped.",
  },
  { key: "moods", title: "Moods", description: "A rare, soft beat when her mood changes." },
  { key: "wake", title: "Listening", description: "A double tap in your hand when she hears you." },
  {
    key: "reminders",
    title: "Reminders",
    description: "A nudge in your hand or face down. Quiet hours stay still unless it's urgent.",
  },
] as const;

/** The Tessel's vibration: how strong, and what may buzz. Softer on a desk and on a low battery by itself. */
export function Haptics({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const haptics = useEnvironmentSettings(environmentId, (s) => s.tessayaHaptics);
  const update = useUpdateEnvironmentSettings(environmentId);
  return (
    <SettingsSection title="Haptics">
      <SettingsRow
        title="Vibration"
        description="How strongly the Tessel buzzes. Off keeps it still everywhere."
        control={
          <Choice
            label="Vibration strength"
            value={haptics.intensity}
            options={["off", "low", "normal", "high"] as const}
            labels={HAPTIC_LABELS}
            onChange={(next) => update({ tessayaHaptics: { intensity: next } })}
          />
        }
      />
      {HAPTIC_ROWS.map((row) => (
        <SettingsRow
          key={row.key}
          title={row.title}
          description={row.description}
          control={
            <Switch
              aria-label={`Vibrate for ${row.title.toLowerCase()}`}
              checked={haptics[row.key]}
              disabled={haptics.intensity === "off"}
              onCheckedChange={(on) => update({ tessayaHaptics: { [row.key]: on } })}
            />
          }
        />
      ))}
    </SettingsSection>
  );
}

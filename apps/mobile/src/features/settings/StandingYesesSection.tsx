/**
 * Settings → Team → Always allowed, mirroring web's Settings → Brain row: his standing yeses, the one list on his
 * server every vessel reads. "Ask again" revokes one everywhere.
 */
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { grantLabel } from "@t3tools/tessaya-shared/consent";
import { useEffect, useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "./components/SettingsSection";

const QUIET = { reportFailure: false } as const;

export function StandingYesesSection(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string | null;
}) {
  const { environmentId } = props;
  const allowed = useAtomValue(tessayaWorkSessions.consentList.permissionAtom(environmentId));
  const mayRevoke = useAtomValue(tessayaWorkSessions.consentSet.permissionAtom(environmentId));
  const list = useAtomCommand(tessayaWorkSessions.consentList, QUIET);
  const set = useAtomCommand(tessayaWorkSessions.consentSet);
  const [keys, setKeys] = useState<ReadonlyArray<string> | null>(null);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads his standing yeses from his server once per environment
  useEffect(() => {
    if (!allowed) return;
    void list({ environmentId, input: {} }).then((r) => {
      if (r._tag === "Success") setKeys(r.value.keys);
    });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- one read per environment; the command is stable
  }, [environmentId, allowed]);

  if (!allowed || keys === null) return null;
  const revoke = async (key: string) => {
    const r = await set({ environmentId, input: { key, allow: false } });
    if (r._tag === "Success") setKeys(r.value.keys);
  };
  return (
    <SettingsSection
      title={`${props.label === null ? "" : `${props.label} · `}Always allowed`}
      footer="Only your own voice or your own devices count; anyone else is still asked."
    >
      {keys.length === 0 ? (
        <Text textRole="footnote" className="px-4 py-3 text-foreground-muted">
          When she asks, answer “Always” and she stops asking about that on every device.
        </Text>
      ) : (
        keys.map((key, i) => (
          <View
            key={key}
            className={`min-h-16 flex-row items-center gap-3 px-4 py-3${i > 0 ? " border-t border-border-subtle" : ""}`}
          >
            <View accessible className="min-w-0 flex-1 gap-0.5">
              <Text textRole="body" className="text-foreground">
                {grantLabel(key)}
              </Text>
              <Text textRole="footnote" className="text-foreground-muted">
                She does this without asking you, on every device.
              </Text>
            </View>
            <ControlPill
              variant="pill"
              label="Ask again"
              disabled={!mayRevoke}
              onPress={() => void revoke(key)}
            />
          </View>
        ))
      )}
    </SettingsSection>
  );
}

/**
 * Tessels on the phone: a Tessel's saved Wi-Fi networks in his order, a new one (hotspot or backup), the
 * name its setup network shows (Tumble-3d57), and his servers' hubs in order. Mirrors the web WifiSection; every
 * change is the same `wifi`/`hubs` device op that voice and MCP use.
 */
import type { DeviceView } from "@t3tools/tessaya-contracts";
import { DEVICE_LINES } from "@t3tools/tessaya-shared/productNames";
import { useState } from "react";
import { TextInput, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { SettingsSection } from "./components/SettingsSection";

const INPUT_CLASS = "rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground";

type Run = (kind: "act" | "owner", op: string, args: Record<string, unknown>) => Promise<unknown>;

/** One id moved by `steps` within the order, clamped to its ends. */
const moved = (ids: ReadonlyArray<string>, id: string, steps: number): Array<string> => {
  const next = ids.filter((x) => x !== id);
  next.splice(Math.min(Math.max(ids.indexOf(id) + steps, 0), next.length), 0, id);
  return next;
};

function RankedRows(props: {
  readonly rows: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly note: string;
  }>;
  readonly disabled: boolean;
  readonly onOrder: (order: ReadonlyArray<string>) => void;
  readonly onForget?: (id: string) => void;
}) {
  const ids = props.rows.map((r) => r.id);
  return props.rows.map((r, i) => (
    <View key={r.id} className="gap-2 border-t border-border-subtle px-4 py-3">
      <View accessible className="min-w-0 gap-0.5">
        <Text textRole="body" className="text-foreground">
          {`${i + 1}. ${r.name}`}
        </Text>
        {r.note === "" ? null : (
          <Text textRole="footnote" className="text-foreground-muted">
            {r.note}
          </Text>
        )}
      </View>
      <View className="flex-row flex-wrap gap-2">
        <ControlPill
          variant="pill"
          label="Move up"
          disabled={props.disabled || i === 0}
          onPress={() => props.onOrder(moved(ids, r.id, -1))}
        />
        <ControlPill
          variant="pill"
          label="Move down"
          disabled={props.disabled || i === ids.length - 1}
          onPress={() => props.onOrder(moved(ids, r.id, 1))}
        />
        {props.onForget === undefined ? null : (
          <ControlPill
            variant="pill"
            label="Forget"
            disabled={props.disabled || ids.length <= 1}
            onPress={() => props.onForget?.(r.id)}
          />
        )}
      </View>
    </View>
  ));
}

export function WifiSection(props: {
  readonly device: DeviceView;
  readonly busy: boolean;
  readonly run: Run;
  readonly prefix: string;
}) {
  const d = props.device;
  const off = props.busy || d.online !== true;
  const [ssid, setSsid] = useState("");
  const [password, setPassword] = useState("");
  const [hotspot, setHotspot] = useState(false);
  const [backup, setBackup] = useState(false);
  if (d.wifi === undefined && d.hubs === undefined) return null;
  const wifi = (args: Record<string, unknown>) => props.run("act", "wifi", { id: d.id, ...args });
  const add = async () => {
    await wifi({ action: "add", ssid: ssid.trim(), password, hotspot, backup });
    setSsid("");
    setPassword("");
  };
  return (
    <SettingsSection title={`${props.prefix}Wi-Fi and servers · ${d.id}`}>
      {d.wifi === undefined ? null : (
        <>
          <View className="gap-0.5 px-4 py-3">
            <Text textRole="body" className="text-foreground">
              Wi-Fi order
            </Text>
            <Text textRole="footnote" className="text-foreground-muted">
              It joins the first network in range, and moves back up when a higher one returns and
              it is idle.
            </Text>
          </View>
          <RankedRows
            rows={d.wifi.map((n) => ({
              id: n.ssid,
              name: n.ssid,
              note: [
                n.current ? "On it now" : "",
                n.hotspot ? "Phone hotspot" : "",
                n.badPass ? "Wrong password" : "",
              ]
                .filter((s) => s !== "")
                .join(" · "),
            }))}
            disabled={off}
            onOrder={(order) => void wifi({ action: "order", order })}
            onForget={(id) => void wifi({ action: "forget", ssid: id })}
          />
          <View className="gap-2 border-t border-border-subtle px-4 py-3">
            <Text textRole="body" className="text-foreground">
              Add a network
            </Text>
            <TextInput
              accessibilityLabel="Network name"
              className={INPUT_CLASS}
              placeholderTextColorClassName="accent-foreground-muted"
              placeholder="Network name"
              autoCapitalize="none"
              autoCorrect={false}
              maxLength={32}
              editable={!off}
              value={ssid}
              onChangeText={setSsid}
            />
            <TextInput
              accessibilityLabel="Password"
              className={INPUT_CLASS}
              placeholderTextColorClassName="accent-foreground-muted"
              placeholder="Password (empty for an open network)"
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              maxLength={63}
              editable={!off}
              value={password}
              onChangeText={setPassword}
            />
            <View className="flex-row flex-wrap gap-2">
              <ControlPill
                variant={hotspot ? "primary" : "pill"}
                label="Phone hotspot"
                disabled={off}
                onPress={() => setHotspot(!hotspot)}
              />
              <ControlPill
                variant={backup ? "primary" : "pill"}
                label="Only save as a backup"
                disabled={off}
                onPress={() => setBackup(!backup)}
              />
              <ControlPill
                variant="primary"
                label="Add network"
                disabled={off || ssid.trim() === "" || (password !== "" && password.length < 8)}
                onPress={() => void add()}
              />
            </View>
          </View>
          <View className="gap-2 border-t border-border-subtle px-4 py-3">
            <View accessible className="gap-0.5">
              <Text textRole="body" className="text-foreground">
                Setup network name
              </Text>
              <Text textRole="footnote" className="text-foreground-muted">
                Which line it is. Its setup Wi-Fi shows as that name and four letters, like
                Tumble-3d57.
              </Text>
            </View>
            <View className="flex-row flex-wrap gap-2">
              {DEVICE_LINES.map((line) => (
                <ControlPill
                  key={line}
                  variant="pill"
                  label={line}
                  disabled={off}
                  onPress={() => void wifi({ action: "line", line })}
                />
              ))}
            </View>
          </View>
        </>
      )}
      {d.hubs === undefined ? null : (
        <>
          <View className="gap-0.5 border-t border-border-subtle px-4 py-3">
            <Text textRole="body" className="text-foreground">
              Servers it connects to
            </Text>
            <Text textRole="footnote" className="text-foreground-muted">
              It uses the first one that answers, and moves back to the first when that one returns.
            </Text>
          </View>
          <RankedRows
            rows={d.hubs.map((h) => ({
              id: h.id,
              name: h.label,
              note: h.current ? "Connected now" : "",
            }))}
            disabled={props.busy}
            onOrder={(order) => void props.run("owner", "hubs", { id: d.id, order })}
          />
        </>
      )}
    </SettingsSection>
  );
}

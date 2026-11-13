/**
 * Settings → Hardware → Add an R1 on the phone: scan the right eye's pairing QR, give the Wi-Fi details, then set it
 * up over Bluetooth (react-native-ble-plx). The phone's own pairing prompt asks for the 6 digits on the R1's eyes.
 * The steps are the web page's (`@t3tools/baton-shared/r1Setup`); then, once per server, the away-from-home question.
 */
import {
  parsePairingQr,
  R1_SETUP_SERVICE,
  runR1Setup,
  type R1SetupPort,
  type R1SetupStep,
} from "@t3tools/baton-shared/r1Setup";
import { useCameraPermissions } from "expo-camera";
import { useState } from "react";
import { PermissionsAndroid, Platform, TextInput, View } from "react-native";
import { BleManager, type Device } from "react-native-ble-plx";

import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";
import { PairingScanCard } from "../connection/ConnectionsNewRouteScreen";
import { SettingsSection } from "./components/SettingsSection";

const INPUT_CLASS = "rounded-lg border border-border-subtle px-3 py-2 text-base text-foreground";
const FIND_TIMEOUT_MS = 30_000;
const SETUP_TIMEOUT_MS = 90_000;

type Reply = { readonly ok: boolean; readonly value?: unknown; readonly error?: string } | null;
export type R1Call = (
  kind: "read" | "owner",
  op: string,
  args: Record<string, unknown>,
) => Promise<Reply>;

const STEP_LINE: Record<R1SetupStep, string> = {
  wifi: "Sending your Wi-Fi…",
  claim: "Pairing it with this server…",
  joining: "Joining your Wi-Fi…",
  online: "Your R1 is set up.",
  failed: "Setup did not finish.",
};

// ble-plx speaks base64; Hermes has btoa and atob.
const toBase64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes));
const fromBase64 = (text: string | null) =>
  Uint8Array.from(atob(text ?? ""), (c) => c.charCodeAt(0));

/** Android 12 and later ask at run time; iOS asks by itself on first use. */
const allowBluetooth = async (): Promise<boolean> => {
  if (Platform.OS !== "android") return true;
  const asked = await PermissionsAndroid.requestMultiple([
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_SCAN,
    PermissionsAndroid.PERMISSIONS.BLUETOOTH_CONNECT,
  ]);
  return Object.values(asked).every((r) => r === PermissionsAndroid.RESULTS.GRANTED);
};

/** The first R1 in setup mode nearby (it offers the setup service), connected. */
const findR1 = (manager: BleManager): Promise<Device> =>
  new Promise((resolve, reject) => {
    const giveUp = setTimeout(() => {
      manager.stopDeviceScan();
      reject(
        new Error("No R1 in setup mode nearby. Hold S1 and S3 for 5 seconds, then try again."),
      );
    }, FIND_TIMEOUT_MS);
    void manager.startDeviceScan([R1_SETUP_SERVICE], null, (error, device) => {
      if (error !== null || device === null) {
        if (error !== null) {
          clearTimeout(giveUp);
          reject(error);
        }
        return;
      }
      clearTimeout(giveUp);
      manager.stopDeviceScan();
      // The phone's pairing prompt (the 6 digits on the R1's eyes) comes up here.
      device
        .connect()
        .then((d) => d.discoverAllServicesAndCharacteristics())
        .then(resolve, reject);
    });
  });

const portOf = (device: Device): R1SetupPort => ({
  write: async (uuid, value) => {
    await device.writeCharacteristicWithResponseForService(R1_SETUP_SERVICE, uuid, toBase64(value));
  },
  read: async (uuid) =>
    fromBase64((await device.readCharacteristicForService(R1_SETUP_SERVICE, uuid)).value),
  watch: async (uuid, onNotify) => {
    const sub = device.monitorCharacteristicForService(R1_SETUP_SERVICE, uuid, (error) => {
      if (error === null) onNotify();
    });
    return () => sub.remove();
  },
});

export function R1SetupSection(props: {
  readonly prefix: string;
  readonly call: R1Call;
  /** The server already asked about away-from-home. */
  readonly awayOffered: boolean;
  readonly onChanged: () => void;
}) {
  const [, requestCamera] = useCameraPermissions();
  const [scanning, setScanning] = useState(false);
  const [qr, setQr] = useState("");
  const [ssid, setSsid] = useState("");
  const [pass, setPass] = useState("");
  const [line, setLine] = useState("");
  const [busy, setBusy] = useState(false);
  const [askAway, setAskAway] = useState<string | null>(null);
  const pairing = parsePairingQr(qr);

  const startScan = async () => {
    if ((await requestCamera()).granted) setScanning(true);
    else setLine("Tessaya needs the camera to read the R1's pairing code.");
  };
  const setUp = async () => {
    if (pairing === null) return;
    setBusy(true);
    const manager = new BleManager();
    try {
      if (!(await allowBluetooth())) throw new Error("Tessaya needs Bluetooth to set up the R1.");
      setLine("Looking for your R1… When asked, type the 6 digits on its eyes.");
      const device = await findR1(manager);
      const ok = await runR1Setup({
        port: portOf(device),
        ssid,
        pass,
        claim: async () => {
          const reply = await props.call("owner", "claim", { ...pairing });
          if (reply?.ok !== true)
            throw new Error(reply?.error ?? "This server could not pair the R1.");
          return (reply.value as { blob: string }).blob;
        },
        onStep: (step, why) => setLine(why === "" ? STEP_LINE[step] : why),
        timeout: new Promise((resolve) => setTimeout(resolve, SETUP_TIMEOUT_MS)),
      });
      await device.cancelConnection().catch(() => undefined);
      if (ok && !props.awayOffered) setAskAway(pairing.deviceId);
      props.onChanged();
    } catch (cause) {
      setLine(cause instanceof Error ? cause.message : "Setup did not finish.");
    }
    manager.destroy();
    setBusy(false);
  };
  const answerAway = async (enabled: boolean) => {
    if (askAway === null) return;
    const reply = await props.call("owner", "away", { id: askAway, enabled });
    setLine(
      reply?.ok === true
        ? String((reply.value as { line?: string } | undefined)?.line ?? "")
        : (reply?.error ?? ""),
    );
    setAskAway(null);
    props.onChanged();
  };
  const field = (label: string, value: string, set: (v: string) => void, secret = false) => (
    <TextInput
      accessibilityLabel={label}
      className={INPUT_CLASS}
      placeholderTextColorClassName="accent-foreground-muted"
      placeholder={label}
      autoCapitalize="none"
      autoCorrect={false}
      secureTextEntry={secret}
      editable={!busy}
      value={value}
      onChangeText={set}
    />
  );

  return (
    <SettingsSection title={`${props.prefix}Add an R1`}>
      <View className="gap-2 px-4 py-3">
        <PairingScanCard
          cameraActive={scanning}
          hint="Scan the pairing code on the R1's right eye"
          onScanPress={() => void startScan()}
          onScan={({ data }) => {
            if (parsePairingQr(data) === null) return;
            setScanning(false);
            setQr(data);
          }}
        />
        <Text textRole="footnote" className="text-foreground-muted">
          {pairing === null ? "Or type the code below it." : `Found ${pairing.deviceId}.`}
        </Text>
        {pairing === null ? field("T3R1:R1-…", qr, setQr) : null}
        {field("Your Wi-Fi name", ssid, setSsid)}
        {field("Its password", pass, setPass, true)}
        <View className="flex-row">
          <ControlPill
            variant="primary"
            label="Set up over Bluetooth"
            disabled={busy || pairing === null || ssid.trim() === ""}
            onPress={() => void setUp()}
          />
        </View>
        {line === "" ? null : (
          <Text textRole="footnote" className="text-foreground-muted">
            {line}
          </Text>
        )}
        {askAway === null ? null : (
          <View className="gap-2">
            <Text>Use your R1 away from home too?</Text>
            <Text textRole="footnote" className="text-foreground-muted">
              It connects through T3 Connect when it is not on your Wi-Fi. You can change this later
              in Settings.
            </Text>
            <View className="flex-row gap-2">
              <ControlPill
                variant="primary"
                label="Yes, turn it on"
                onPress={() => void answerAway(true)}
              />
              <ControlPill
                variant="pill"
                label="Home only for now"
                onPress={() => void answerAway(false)}
              />
            </View>
          </View>
        )}
      </View>
    </SettingsSection>
  );
}

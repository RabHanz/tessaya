/**
 * Settings → Hardware → Add an R1: the pairing QR's text and Wi-Fi, then over Bluetooth
 * where the browser has it (Chrome, the desktop app), or as a setup code for the R1's own Wi-Fi page anywhere else. Then, once per server,
 * the away-from-home question. The steps are shared with the phone (`@t3tools/baton-shared/r1Setup`).
 */
import {
  parsePairingQr,
  R1_SETUP_SERVICE,
  runR1Setup,
  type R1SetupPort,
  type R1SetupStep,
} from "@t3tools/baton-shared/r1Setup";
import { batonDesktopBridge } from "@t3tools/baton-contracts";
import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SecretInput } from "./SecretInput";
import { SettingsRow, SettingsSection } from "./settingsLayout";

type Reply = { readonly ok: boolean; readonly value?: unknown; readonly error?: string } | null;
export type R1Call = (
  kind: "read" | "owner",
  op: string,
  args: Record<string, unknown>,
) => Promise<Reply>;

// Web Bluetooth's few calls used here; the DOM types do not carry it.
interface GattCharacteristic extends EventTarget {
  writeValueWithResponse(value: Uint8Array): Promise<void>;
  readValue(): Promise<DataView>;
  startNotifications(): Promise<unknown>;
}
interface Bluetooth {
  requestDevice(options: { filters: Array<{ services: Array<string> }> }): Promise<{
    gatt?: {
      connect(): Promise<{
        getPrimaryService(uuid: string): Promise<{
          getCharacteristic(uuid: string): Promise<GattCharacteristic>;
        }>;
      }>;
    };
  }>;
}
const webBluetooth = (): Bluetooth | null =>
  (globalThis.navigator as { bluetooth?: Bluetooth } | undefined)?.bluetooth ?? null;

const SETUP_TIMEOUT_MS = 90_000;

/** An R1 in range, over Web Bluetooth; the OS asks for the passkey the eyes show while it pairs. */
const connectR1 = async (bluetooth: Bluetooth): Promise<R1SetupPort> => {
  const device = await bluetooth.requestDevice({ filters: [{ services: [R1_SETUP_SERVICE] }] });
  if (device.gatt === undefined) throw new Error("This R1 has no setup service.");
  const service = await (await device.gatt.connect()).getPrimaryService(R1_SETUP_SERVICE);
  return {
    write: async (uuid, value) =>
      (await service.getCharacteristic(uuid)).writeValueWithResponse(value),
    read: async (uuid) => {
      const v = await (await service.getCharacteristic(uuid)).readValue();
      return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    },
    watch: async (uuid, onNotify) => {
      const ch = await service.getCharacteristic(uuid);
      const listener = () => onNotify();
      ch.addEventListener("characteristicvaluechanged", listener);
      await ch.startNotifications();
      return () => ch.removeEventListener("characteristicvaluechanged", listener);
    },
  };
};

const STEP_LINE: Record<R1SetupStep, string> = {
  wifi: "Sending your Wi-Fi…",
  claim: "Pairing it with this server…",
  joining: "Joining your Wi-Fi…",
  online: "Your R1 is set up.",
  failed: "Setup did not finish.",
};

export function R1SetupSection({
  call,
  awayOffered,
  bluetooth = webBluetooth(),
  onChanged,
}: {
  readonly call: R1Call;
  /** The server already asked about away-from-home (at an earlier setup, or it was changed since). */
  readonly awayOffered: boolean;
  readonly bluetooth?: Bluetooth | null;
  readonly onChanged: () => void;
}) {
  const [qr, setQr] = useState("");
  const [ssid, setSsid] = useState("");
  const [pass, setPass] = useState("");
  const [line, setLine] = useState("");
  const [busy, setBusy] = useState(false);
  const [code, setCode] = useState<string | null>(null);
  const [askAway, setAskAway] = useState<string | null>(null);
  const pairing = parsePairingQr(qr);
  // The desktop app's pairing, waiting for him: the R1's eyes show the digits; nothing is filled in for him.
  const [pairAsk, setPairAsk] = useState<{
    readonly kind: "providePin" | "confirmPin" | "confirm";
    readonly pin?: string;
    readonly answer: (reply: { confirmed: boolean; pin?: string }) => void;
  } | null>(null);
  const [typed, setTyped] = useState("");

  const claim = async () => {
    if (pairing === null) throw new Error("That is not the R1's pairing code.");
    const reply = await call("owner", "claim", { ...pairing });
    if (reply?.ok !== true) throw new Error(reply?.error ?? "This server could not pair the R1.");
    return (reply.value as { blob: string }).blob;
  };
  const finish = (ok: boolean) => {
    if (ok && pairing !== null && !awayOffered) setAskAway(pairing.deviceId);
    onChanged();
  };
  const viaBluetooth = async () => {
    if (bluetooth === null || pairing === null) return;
    setBusy(true);
    // In the desktop app the pairing asks here; a browser or phone shows the system's own prompt.
    const stopAsking = batonDesktopBridge()?.onR1BlePairing?.(
      (request) =>
        new Promise((answer) => {
          setTyped("");
          setPairAsk({ ...request, answer });
        }),
    );
    try {
      const port = await connectR1(bluetooth);
      const ok = await runR1Setup({
        port,
        ssid,
        pass,
        claim,
        onStep: (step, why) => setLine(why === "" ? STEP_LINE[step] : why),
        timeout: new Promise((resolve) => setTimeout(resolve, SETUP_TIMEOUT_MS)),
      });
      finish(ok);
    } catch (cause) {
      setLine(cause instanceof Error ? cause.message : "Setup did not finish.");
    }
    stopAsking?.();
    setPairAsk(null);
    setBusy(false);
  };
  const viaCode = async () => {
    setBusy(true);
    try {
      setCode(await claim());
      setLine(
        "Join the R1's own Wi-Fi (the QR on its left eye), open any page, and paste this into “From the Tessaya app” with your Wi-Fi.",
      );
      finish(true);
    } catch (cause) {
      setLine(cause instanceof Error ? cause.message : "This server could not pair the R1.");
    }
    setBusy(false);
  };
  const answerAway = async (enabled: boolean) => {
    if (askAway === null) return;
    const reply = await call("owner", "away", { id: askAway, enabled });
    setLine(
      reply?.ok === true
        ? String((reply.value as { line?: string })?.line ?? "")
        : (reply?.error ?? ""),
    );
    setAskAway(null);
    onChanged();
  };

  return (
    <SettingsSection title="Add an R1">
      <SettingsRow
        title="Pairing code"
        description="Scan the QR on the R1's right eye with your phone's camera and paste the text here (T3R1:…), or use the Tessaya phone app."
      >
        <div className="flex flex-col gap-2 pt-2">
          <Input
            aria-label="Pairing code"
            value={qr}
            placeholder="T3R1:R1-…"
            onChange={(e) => setQr(e.target.value)}
          />
          <Input
            aria-label="Wi-Fi name"
            value={ssid}
            placeholder="Your Wi-Fi name"
            onChange={(e) => setSsid(e.target.value)}
          />
          <SecretInput
            aria-label="Wi-Fi password"
            value={pass}
            placeholder="Its password"
            onChange={(e) => setPass(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            {bluetooth === null ? null : (
              <Button
                size="xs"
                disabled={busy || pairing === null || ssid.trim() === ""}
                onClick={() => void viaBluetooth()}
              >
                Set up over Bluetooth
              </Button>
            )}
            <Button
              size="xs"
              variant="outline"
              disabled={busy || pairing === null}
              onClick={() => void viaCode()}
            >
              Get a setup code
            </Button>
          </div>
          {pairAsk === null ? null : (
            <div className="flex flex-col gap-2">
              {pairAsk.kind === "providePin" ? (
                <Input
                  aria-label="The 6 digits on the R1's eyes"
                  inputMode="numeric"
                  autoFocus
                  value={typed}
                  placeholder="Type the 6 digits on the R1's eyes"
                  onChange={(e) => setTyped(e.target.value.replace(/\D/g, "").slice(0, 6))}
                />
              ) : (
                <p className="text-sm">
                  {pairAsk.kind === "confirmPin"
                    ? `Do the R1's eyes show ${pairAsk.pin ?? ""}?`
                    : "Pair with this R1?"}
                </p>
              )}
              <div className="flex gap-2">
                <Button
                  size="xs"
                  disabled={pairAsk.kind === "providePin" && typed.length !== 6}
                  onClick={() => {
                    pairAsk.answer(
                      pairAsk.kind === "providePin"
                        ? { confirmed: true, pin: typed }
                        : { confirmed: true },
                    );
                    setPairAsk(null);
                  }}
                >
                  Pair
                </Button>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => {
                    pairAsk.answer({ confirmed: false });
                    setPairAsk(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {code === null ? null : (
            <Input
              aria-label="Setup code"
              readOnly
              value={code}
              onFocus={(e) => e.target.select()}
            />
          )}
          {line === "" ? null : (
            <p aria-live="polite" className="text-sm text-muted-foreground">
              {line}
            </p>
          )}
        </div>
      </SettingsRow>
      {askAway === null ? null : (
        <SettingsRow
          title="Use your R1 away from home too?"
          description="It connects through T3 Connect when it is not on your Wi-Fi. You can change this later in Settings."
          control={
            <div className="flex gap-2">
              <Button size="xs" onClick={() => void answerAway(true)}>
                Yes, turn it on
              </Button>
              <Button size="xs" variant="outline" onClick={() => void answerAway(false)}>
                Home only for now
              </Button>
            </div>
          }
        />
      )}
    </SettingsSection>
  );
}

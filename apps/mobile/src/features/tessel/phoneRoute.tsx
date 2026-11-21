/**
 * The phone route: this phone plays her replies on its headphones (AirPods too) and lends its mic, near a Tessel chosen
 * in Tessels (apps/server/src/home/PhoneLink.ts); its headset's button starts a talk, her buzz plays on its motor.
 * Away from that Tessel, or with "Reach her on this phone", it is a vessel of its own on her environment's hub.
 */
import { resolveDeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import type { EnvironmentId } from "@t3tools/contracts";
import type { HapticRendering } from "@t3tools/tessaya-shared/haptics";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";
import * as Device from "expo-device";
import { File, Paths } from "expo-file-system";
import * as Network from "expo-network";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { Haptics } from "../../../modules/t3-haptics";
import { PhoneAudio, type PhoneAudioRoute } from "../../../modules/t3-phone-audio";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { environmentSession } from "../../state/session";
import { tessayaEnvironmentIdAtom } from "../../state/tessayaHousehold";

export interface PhoneRouteChoice {
  readonly environmentId: EnvironmentId;
  readonly deviceId: string;
}

const file = () => new File(Paths.document, "tessel-phone-route.json");
const read = (): PhoneRouteChoice | null => {
  try {
    const v = JSON.parse(file().textSync()) as Partial<PhoneRouteChoice> | null;
    return typeof v?.environmentId === "string" && typeof v.deviceId === "string"
      ? { environmentId: v.environmentId as EnvironmentId, deviceId: v.deviceId }
      : null;
  } catch {
    return null;
  }
};
let choice: PhoneRouteChoice | null | undefined;
const listeners = new Set<() => void>();
const current = () => (choice === undefined ? (choice = read()) : choice);

export const setPhoneRoute = (next: PhoneRouteChoice | null) => {
  choice = next;
  try {
    file().write(JSON.stringify(next));
  } catch {
    // Kept for this run only; it is asked again after a restart.
  }
  for (const l of listeners) l();
};

export const usePhoneRoute = () =>
  useSyncExternalStore((l) => (listeners.add(l), () => void listeners.delete(l)), current);

/** Only on a store build with the native module; older builds show no switch. */
export const phoneRouteAvailable = PhoneAudio !== null;

const accessAtom = Atom.family((environmentId: EnvironmentId) =>
  // Tickets are single use: each attempt is its own family member.
  Atom.family((_attempt: number) =>
    connectionAtomRuntime
      .atom((get) => {
        const prepared = Option.getOrNull(
          get(environmentSession.preparedConnectionValueAtom(environmentId)),
        );
        return prepared === null
          ? Effect.never
          : resolveDeviceHubAccess({ prepared, hubBasePath: "/api/tessel/phone" });
      })
      .pipe(Atom.withLabel(`mobile-tessel-phone-access:${environmentId}`)),
  ),
);

/** Headphones (it may take private replies) when the phone plays on a headset; its own speaker otherwise. */
const kindOf = (r: PhoneAudioRoute) =>
  r.output.startsWith("bluetooth") || r.output === "wired" ? "headphones" : "speaker";

/** The same install id the phone registers with in Tessels. */
const installId =
  `${Device.modelName ?? ""}${Device.deviceName ?? ""}`.replace(/[^\w.-]/g, "").slice(0, 60) ||
  "phone";
const phoneName = Device.deviceName ?? Device.modelName ?? "Phone";

/** The server's words only; anything else is ignored. */
const parse = (text: string): { t?: string; on?: boolean; r?: HapticRendering } => {
  try {
    return JSON.parse(text) as { t?: string };
  } catch {
    return {};
  }
};

const decode = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

/** Whether the phone's link to her is open now, for Talk to show; false on builds without the native module. */
let linked = false;
const linkListeners = new Set<() => void>();
const setLinked = (next: boolean) => {
  if (next === linked) return;
  linked = next;
  for (const l of linkListeners) l();
};
export const usePhoneVesselReady = () =>
  useSyncExternalStore(
    (l) => (linkListeners.add(l), () => void linkListeners.delete(l)),
    () => linked,
  );

/** The choice's `device` for no Tessel: the server makes the phone a vessel of its own. */
export const PHONE_VESSEL_DEVICE = "phone";

/**
 * "Reach her on this phone": the phone holds her route as its own vessel, with no Tessel chosen. It follows her one
 * environment (failing over with it), so the saved environment is only where it was turned on.
 */
export const setPhoneVessel = (environmentId: EnvironmentId | null) =>
  setPhoneRoute(environmentId === null ? null : { environmentId, deviceId: PHONE_VESSEL_DEVICE });

/** Holds the link while a Tessel or this phone itself is chosen; mounted once at the app root. */
export function PhoneRouteHost() {
  const chosen = usePhoneRoute();
  const environmentId = useAtomValue(tessayaEnvironmentIdAtom);
  if (PhoneAudio === null || chosen === null) return null;
  // Opt-in: an audio session takes the headset's button from his music, so it is held only when he asked.
  const c =
    chosen.deviceId !== PHONE_VESSEL_DEVICE
      ? chosen
      : environmentId === null
        ? null
        : { environmentId, deviceId: PHONE_VESSEL_DEVICE };
  // Keyed: another environment or Tessel is a fresh link with fresh tickets.
  return c === null ? null : <PhoneRouteLink key={`${c.environmentId}/${c.deviceId}`} choice={c} />;
}

function PhoneRouteLink({ choice: c }: { readonly choice: PhoneRouteChoice }) {
  const [attempt, setAttempt] = useState(0);
  /** Tries refused in a row since the link last opened. */
  const refused = useRef(0);
  const access = useEnvironmentQuery(accessAtom(c.environmentId)(attempt)).data;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds a WebSocket and the phone's audio session
  useEffect(() => {
    const audio = PhoneAudio;
    if (access == null || audio === null) return;
    const query = new URLSearchParams({
      ...access.query,
      device: c.deviceId,
      phone: installId,
      name: phoneName,
    });
    const ws = new WebSocket(`${access.wsBase}?${query.toString()}`);
    ws.binaryType = "arraybuffer";
    let retry: ReturnType<typeof setTimeout> | null = null;
    const sendRoute = (r: PhoneAudioRoute) =>
      void Network.getIpAddressAsync()
        .catch(() => null)
        .then((ip) => {
          if (ws.readyState === WebSocket.OPEN)
            ws.send(
              JSON.stringify({
                t: "route",
                kind: kindOf(r),
                name: r.name,
                ip,
                haptic: Haptics?.hardware() ?? null,
              }),
            );
        });
    const subs = [
      audio.addListener("onRoute", sendRoute),
      audio.addListener("onMic", (e) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(decode(e.pcm).buffer);
      }),
      audio.addListener("onButton", () => {
        if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: "talk" }));
      }),
    ];
    ws.onopen = () => {
      setLinked(true);
      refused.current = 0;
      void audio
        .start()
        .then(sendRoute)
        .catch(() => ws.close());
    };
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return audio.play(new Uint8Array(e.data as ArrayBuffer));
      const m = parse(e.data);
      if (m.t === "listen") void audio.setMic(m.on === true);
      // She was interrupted: what the player still holds goes now.
      else if (m.t === "flush") audio.flush();
      else if (m.t === "haptic" && m.r !== undefined) Haptics?.play(m.r);
    };
    // A dropped link comes back with a fresh ticket; the server routes to her speaker meanwhile.
    // A server that cannot serve it (no room loop yet) refuses each try: waits grow to a minute.
    ws.onclose = () => {
      setLinked(false);
      const wait = Math.min(60_000, 3_000 * 2 ** refused.current++);
      retry = setTimeout(() => setAttempt((n) => n + 1), wait);
    };
    return () => {
      ws.onclose = null;
      setLinked(false);
      if (retry !== null) clearTimeout(retry);
      for (const s of subs) s.remove();
      ws.close();
      void audio.stop();
    };
  }, [access, c.deviceId]);
  return null;
}

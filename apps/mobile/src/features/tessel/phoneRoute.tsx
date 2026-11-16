/**
 * The phone route: this phone plays her replies on whatever it is playing through (AirPods, headphones) and lends its
 * mic, so a Tessel's own radio stays on Wi-Fi. One Tessel at a time, chosen in Settings → Hardware; the server's output
 * and input orders decide when the phone is used (apps/server/src/home/PhoneLink.ts). Its headset's button starts a
 * talk on that Tessel, and her buzz on the word plays on this phone's own motor.
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
import { useEffect, useState, useSyncExternalStore } from "react";

import { Haptics } from "../../../modules/t3-haptics";
import { PhoneAudio, type PhoneAudioRoute } from "../../../modules/t3-phone-audio";
import { connectionAtomRuntime } from "../../connection/runtime";
import { useEnvironmentQuery } from "../../state/query";
import { environmentSession } from "../../state/session";

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

/** The same install id the phone registers with in Settings → Hardware. */
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

/** Holds the link while a Tessel is chosen; mounted once at the app root. */
export function PhoneRouteHost() {
  const chosen = usePhoneRoute();
  return chosen === null || PhoneAudio === null ? null : <PhoneRouteLink choice={chosen} />;
}

function PhoneRouteLink({ choice: c }: { readonly choice: PhoneRouteChoice }) {
  const [attempt, setAttempt] = useState(0);
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
    ws.onopen = () =>
      void audio
        .start()
        .then(sendRoute)
        .catch(() => ws.close());
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return audio.play(new Uint8Array(e.data as ArrayBuffer));
      const m = parse(e.data);
      if (m.t === "listen") void audio.setMic(m.on === true);
      // She was interrupted: what the player still holds goes now.
      else if (m.t === "flush") audio.flush();
      else if (m.t === "haptic" && m.r !== undefined) Haptics?.play(m.r);
    };
    // A dropped link comes back with a fresh ticket; the server routes to her speaker meanwhile.
    ws.onclose = () => {
      retry = setTimeout(() => setAttempt((n) => n + 1), 3_000);
    };
    return () => {
      ws.onclose = null;
      if (retry !== null) clearTimeout(retry);
      for (const s of subs) s.remove();
      ws.close();
      void audio.stop();
    };
  }, [access, c.deviceId]);
  return null;
}

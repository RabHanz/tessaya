/**
 * The laptop route (R-073): this computer joins a Tessel's phone route (apps/server/src/home/PhoneLink.ts) as one more
 * peer, playing her replies on its own output and lending its mic, so he can talk to her at the desk on his headset.
 * The mic is the one he chose for dictation; Chromium's echo canceller (getUserMedia's default) takes her voice out.
 */
import { useAtomValue } from "@effect/atom-react";
import { resolveDeviceHubAccess } from "@t3tools/client-runtime/state/deviceHubAccess";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useEffect, useState, useSyncExternalStore } from "react";

import { connectionAtomRuntime } from "./connection/runtime";
import { chooseRecordingMicrophone } from "./speech/browserMicrophones";
import { requestMicrophone } from "./speech/requestMicrophone";
import workletUrl from "./speech/routeWorklet.ts?worker&url";
import { environmentSession } from "./state/session";

export interface LaptopRouteChoice {
  readonly environmentId: EnvironmentId;
  readonly deviceId: string;
}

const KEY = "tessaya.laptopRoute";
const ID_KEY = "tessaya.laptopRoute.id";

const read = (): LaptopRouteChoice | null => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? "null") as Partial<LaptopRouteChoice> | null;
    return typeof v?.environmentId === "string" && typeof v.deviceId === "string"
      ? { environmentId: v.environmentId as EnvironmentId, deviceId: v.deviceId }
      : null;
  } catch {
    return null;
  }
};
let choice: LaptopRouteChoice | null | undefined;
const listeners = new Set<() => void>();
const current = () => (choice === undefined ? (choice = read()) : choice);
const changed = () => {
  for (const l of listeners) l();
};

export const setLaptopRoute = (next: LaptopRouteChoice | null) => {
  choice = next;
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    // Kept for this window's run only.
  }
  changed();
};

const subscribe = (l: () => void) => {
  listeners.add(l);
  // Settings may be in Tessaya's window: the main window's host follows its choice.
  const onStorage = (e: StorageEvent) => {
    if (e.key !== KEY) return;
    choice = read();
    changed();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
};

export const useLaptopRoute = () => useSyncExternalStore(subscribe, current);

/** A stable id for this computer on the route, as a phone's install id. */
const laptopId = () => {
  try {
    const kept = localStorage.getItem(ID_KEY);
    if (kept !== null && /^[\w.-]{1,80}$/.test(kept)) return kept;
    const hex = Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) =>
      b.toString(16).padStart(2, "0"),
    ).join("");
    const made = `laptop-${hex}`;
    localStorage.setItem(ID_KEY, made);
    return made;
  } catch {
    return "laptop";
  }
};

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
      .pipe(Atom.withLabel(`web-tessel-laptop-access:${environmentId}`)),
  ),
);

const HEADPHONES = /head(phone|set)|airpods|buds|earphone|hands-free|bluetooth/i;

/** Headphones (it may take private replies) when the OS plays on a headset; its own speakers otherwise. */
const outputRoute = async () => {
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const out = devices.find((d) => d.kind === "audiooutput" && d.deviceId === "default");
  const name = out?.label.replace(/^Default - /, "") || null;
  return { kind: name !== null && HEADPHONES.test(name) ? "headphones" : "speaker", name };
};

const parse = (text: string): { t?: string; on?: boolean } => {
  try {
    return JSON.parse(text) as { t?: string };
  } catch {
    return {};
  }
};

/** Holds the link while a Tessel is chosen; mounted once in the main window. */
export function LaptopRouteHost() {
  const chosen = useLaptopRoute();
  return chosen === null ? null : <LaptopRouteLink choice={chosen} />;
}

function LaptopRouteLink({ choice: c }: { readonly choice: LaptopRouteChoice }) {
  const [attempt, setAttempt] = useState(0);
  const result = useAtomValue(accessAtom(c.environmentId)(attempt));
  const access = AsyncResult.isSuccess(result) ? result.value : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds a WebSocket, the speakers and the mic
  useEffect(() => {
    if (access === null) return;
    const query = new URLSearchParams({
      ...access.query,
      device: c.deviceId,
      phone: laptopId(),
      name: "Laptop",
    });
    const ws = new WebSocket(`${access.wsBase}?${query.toString()}`);
    ws.binaryType = "arraybuffer";
    const speakers = new AudioContext({ sampleRate: 16_000 });
    const playing = new Set<AudioBufferSourceNode>();
    let playAt = 0;
    let mic: { stop: () => void } | null = null;
    let micWanted = false;
    let retry: ReturnType<typeof setTimeout> | null = null;

    const play = (data: ArrayBuffer) => {
      const pcm = new Int16Array(data, 0, data.byteLength >> 1);
      if (pcm.length === 0) return;
      // A browser tab may start it suspended until a gesture; the desktop never does.
      if (speakers.state === "suspended") void speakers.resume();
      const buffer = speakers.createBuffer(1, pcm.length, 16_000);
      const out = buffer.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) out[i] = pcm[i]! / 32768;
      const source = speakers.createBufferSource();
      source.buffer = buffer;
      source.connect(speakers.destination);
      playAt = Math.max(playAt, speakers.currentTime);
      source.start(playAt);
      playAt += buffer.duration;
      playing.add(source);
      source.addEventListener("ended", () => playing.delete(source));
    };
    const flush = () => {
      for (const s of playing) s.stop();
      playing.clear();
      playAt = 0;
    };
    const openMic = async () => {
      const stream = await requestMicrophone(await chooseRecordingMicrophone());
      const context = new AudioContext();
      const stop = () => {
        stream.getTracks().forEach((t) => t.stop());
        void context.close();
      };
      if (!micWanted) return stop();
      await context.audioWorklet.addModule(workletUrl);
      const node = new AudioWorkletNode(context, "t3-route-capture", { channelCount: 1 });
      node.port.onmessage = ({ data }: MessageEvent<ArrayBuffer>) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(data);
      };
      context.createMediaStreamSource(stream).connect(node);
      await context.resume();
      mic = { stop };
      if (!micWanted) setMic(false);
    };
    const setMic = (on: boolean) => {
      micWanted = on;
      if (on && mic === null) void openMic().catch(() => (micWanted = false));
      if (!on && mic !== null) {
        mic.stop();
        mic = null;
      }
    };
    const sendRoute = () =>
      void outputRoute().then(({ kind, name }) => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(JSON.stringify({ t: "route", kind, name, ip: null }));
      });
    navigator.mediaDevices.addEventListener("devicechange", sendRoute);
    ws.onopen = sendRoute;
    ws.onmessage = (e) => {
      if (typeof e.data !== "string") return play(e.data as ArrayBuffer);
      const m = parse(e.data);
      if (m.t === "listen") setMic(m.on === true);
      // She was interrupted: what is still queued goes now.
      else if (m.t === "flush") flush();
    };
    // A dropped link comes back with a fresh ticket; the server routes to her speaker meanwhile.
    ws.onclose = () => {
      retry = setTimeout(() => setAttempt((n) => n + 1), 3_000);
    };
    return () => {
      ws.onclose = null;
      if (retry !== null) clearTimeout(retry);
      navigator.mediaDevices.removeEventListener("devicechange", sendRoute);
      setMic(false);
      flush();
      void speakers.close();
      ws.close();
    };
  }, [access, c.deviceId]);
  return null;
}

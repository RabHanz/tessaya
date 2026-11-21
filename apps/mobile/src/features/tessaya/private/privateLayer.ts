/**
 * The phone's side of the owner-only private layer (M-133), through the same seams as the desk's
 * (desktop personaLayerLink.ts): a report to /tessaya/layer/_vessel says what happened here and answers whether a
 * private moment is open and where the layer's pages are; the layer's own `window` and `activate` open one with his
 * step-up. A server with no layer answers 404, and the phone then shows no private entry at all.
 */
import { useAtomValue } from "@effect/atom-react";
import { useSyncExternalStore } from "react";

import { tessayaEnvironmentIdAtom } from "../../../state/tessayaHousehold";
import { useSavedRemoteConnection } from "../../../state/use-remote-environment-registry";
import { thisPhoneId } from "../devices/DevicesRouteScreen";
import type { StepUpCall } from "../lock/stepUp";

export interface LayerAnswer {
  readonly open: boolean;
  readonly persona: string | null;
  readonly page: string | null;
  readonly presence: "alone" | "others" | "unknown";
}

// shared by More's row and the private screen: null until asked, false on a server with no layer
let known: LayerAnswer | false | null = null;
let shown = false;
const listeners = new Set<() => void>();
const tell = () => {
  for (const l of listeners) l();
};
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
export const setPrivateShown = (on: boolean) => {
  shown = on;
  tell();
};
export const usePrivateShown = () => useSyncExternalStore(subscribe, () => shown);
export const useLayerKnown = () => useSyncExternalStore(subscribe, () => known);

export function usePrivateLayer() {
  const environmentId = useAtomValue(tessayaEnvironmentIdAtom);
  const connection = useSavedRemoteConnection(environmentId);
  const base = connection?.httpBaseUrl ?? null;
  const token = connection?.bearerToken ?? null;
  const send = async (path: string, body: unknown) => {
    if (base === null || token === null) return null;
    return fetch(new URL(path, base), {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => null);
  };
  /** Tells the layer what happened here; its answer, or null when it couldn't be reached. */
  const report = async (signals: ReadonlyArray<string> = []) => {
    const r = await send("/tessaya/layer/_vessel", { vessel: thisPhoneId(), signals });
    if (r === null) return null;
    if (r.status === 404) {
      known = false;
      tell();
      return null;
    }
    if (!r.ok) return null;
    known = (await r.json().catch(() => null)) as LayerAnswer | null;
    tell();
    return known === null ? null : known;
  };
  /** His step-up, checked by the layer through her brain's household PIN store, opens a private moment here. */
  const activate: StepUpCall = async (pin) => {
    const page = known === false ? null : known?.page;
    if (page == null) return { ok: false, refused: false, line: "Your private layer isn't here." };
    const w = await send(`${page}/window`, { surface: "phone" });
    const vessel =
      w?.ok === true ? ((await w.json().catch(() => ({}))) as { vessel?: unknown }).vessel : null;
    if (typeof vessel !== "string")
      return { ok: false, refused: false, line: "Your private layer can't open here." };
    const a = await send(`${page}/activate`, { surface: "phone", vessel, stepUp: { pin } });
    if (a?.ok === true) {
      await report();
      return { ok: true, refused: false, line: "" };
    }
    return a === null || a.status >= 500
      ? { ok: false, refused: false, line: "Her brain can't be reached." }
      : { ok: false, refused: true, line: "That PIN wasn't right." };
  };
  return { base, token, report, activate };
}

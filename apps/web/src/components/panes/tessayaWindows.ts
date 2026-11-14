// @effect-diagnostics cryptoRandomUUID:off -- plain browser code, outside any Effect runtime
/**
 * Detached windows (D96). A window is a plain second renderer of the same app and server. It is
 * named by `window.name`, which outlives reloads and route changes, so each window has its own
 * pane layout. A thread lives in one window: the window that opens it claims it, and any other
 * window drops its ChatView for a "Bring here" note, so one thread never has two composers.
 */
import type { ThreadRouteTarget } from "../../threadRoutes";

const WINDOW_PARAM = "batonWindow";
const WINDOW_NAME_PREFIX = "baton-window-";
const WINDOW_ID = /^[a-z0-9-]{1,40}$/;
const CHANNEL = "t3code:baton-panes";
const ATTACH_ANSWER_MS = 1500;

export const MAIN_WINDOW_ID = "main";

export function tessayaWindowId(): string {
  if (typeof window === "undefined") return MAIN_WINDOW_ID;
  const param = new URLSearchParams(window.location.search).get(WINDOW_PARAM);
  if (param !== null && WINDOW_ID.test(param)) window.name = `${WINDOW_NAME_PREFIX}${param}`;
  return window.name.startsWith(WINDOW_NAME_PREFIX)
    ? window.name.slice(WINDOW_NAME_PREFIX.length)
    : MAIN_WINDOW_ID;
}

/**
 * A detached window runs this same app with the same preload, but work for the whole desktop app
 * belongs to one window: the main process only answers the main one.
 */
export const isMainWindow = (): boolean => tessayaWindowId() === MAIN_WINDOW_ID;

export function detachedWindowUrl(
  target: ThreadRouteTarget,
  id: string,
  location: { readonly protocol: string; readonly host: string; readonly pathname: string },
  hashRouted: boolean,
): string {
  // Not `origin`: it is the string "null" on the desktop app's custom scheme.
  const base = `${location.protocol}//${location.host}`;
  const route =
    target.kind === "server"
      ? `/${encodeURIComponent(target.threadRef.environmentId)}/${encodeURIComponent(target.threadRef.threadId)}`
      : `/draft/${encodeURIComponent(target.draftId)}`;
  const query = `?${WINDOW_PARAM}=${id}`;
  return hashRouted ? `${base}${location.pathname}${query}#${route}` : `${base}${route}${query}`;
}

/** False when the browser blocked the popup. */
export function openDetachedWindow(target: ThreadRouteTarget): boolean {
  const id = crypto.randomUUID().slice(0, 13);
  const url = detachedWindowUrl(target, id, window.location, window.desktopBridge !== undefined);
  return window.open(url, `${WINDOW_NAME_PREFIX}${id}`, "popup,width=1100,height=800") !== null;
}

type WindowMessage =
  | { readonly type: "claim"; readonly key: string; readonly from: string }
  | { readonly type: "attach"; readonly target: ThreadRouteTarget; readonly request: string }
  | { readonly type: "attached"; readonly request: string };

const channel = typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(CHANNEL);

const send = (message: WindowMessage) => channel?.postMessage(message);

export const announceClaim = (key: string) => send({ type: "claim", key, from: tessayaWindowId() });

export function onThreadClaimed(listener: (key: string) => void): () => void {
  const handle = (event: MessageEvent<WindowMessage>) => {
    const message = event.data;
    if (message.type === "claim" && message.from !== tessayaWindowId()) listener(message.key);
  };
  channel?.addEventListener("message", handle);
  return () => channel?.removeEventListener("message", handle);
}

/** The main window takes a thread back; a detached window listens for nothing. */
export function onAttachRequest(listener: (target: ThreadRouteTarget) => void): () => void {
  if (tessayaWindowId() !== MAIN_WINDOW_ID) return () => {};
  const handle = (event: MessageEvent<WindowMessage>) => {
    const message = event.data;
    if (message.type !== "attach") return;
    listener(message.target);
    window.focus();
    send({ type: "attached", request: message.request });
  };
  channel?.addEventListener("message", handle);
  return () => channel?.removeEventListener("message", handle);
}

/** True once the main window has the thread; false when no main window answered. */
export function requestAttach(target: ThreadRouteTarget): Promise<boolean> {
  return new Promise((resolve) => {
    const request = crypto.randomUUID();
    const handle = (event: MessageEvent<WindowMessage>) => {
      if (event.data.type === "attached" && event.data.request === request) finish(true);
    };
    const finish = (attached: boolean) => {
      channel?.removeEventListener("message", handle);
      clearTimeout(timer);
      resolve(attached);
    };
    const timer = setTimeout(() => finish(false), ATTACH_ANSWER_MS);
    channel?.addEventListener("message", handle);
    send({ type: "attach", target, request });
  });
}

// @effect-diagnostics globalTimers:off
/**
 * Bluetooth setup of an R1 from the desktop (Settings → Hardware → Add an R1). Chromium leaves two answers to the app:
 * which device a page's `requestDevice` gets, and, on Windows and Linux, the pairing itself (unanswered, Electron
 * cancels it). The R1's eyes show its stack's random 6 digits; the page that asked for the R1 asks him for them.
 */
import * as Electron from "electron";

import { R1_BLE_PAIRING_REQUEST_CHANNEL, R1_BLE_PAIRING_RESPONSE_CHANNEL } from "../channels.ts";

/** He has this long to type the digits before the pairing is cancelled. */
const ANSWER_TIMEOUT_MS = 2 * 60_000;
/** A request with no R1 in range ends instead of waiting for ever. */
const CHOOSE_TIMEOUT_MS = 30_000;

/** The page's answer, checked: digits only as six of them, a yes only as a boolean; anything else cancels. */
export const pairingAnswer = (
  kind: string,
  reply: unknown,
): { readonly confirmed: boolean; readonly pin?: string } => {
  const r = (reply ?? {}) as { confirmed?: unknown; pin?: unknown };
  if (r.confirmed !== true) return { confirmed: false };
  if (kind === "providePin")
    return typeof r.pin === "string" && /^\d{6}$/.test(r.pin)
      ? { confirmed: true, pin: r.pin }
      : { confirmed: false };
  return kind === "confirmPin" || kind === "confirm" ? { confirmed: true } : { confirmed: false };
};

export function installR1Bluetooth(existing: ReadonlyArray<Electron.WebContents>): void {
  // The page that last asked for a Bluetooth device: the pairing that follows is its R1's.
  let requester: Electron.WebContents | null = null;
  const waiting = new Map<
    number,
    { kind: string; answer: (r: { confirmed: boolean; pin?: string }) => void }
  >();
  let next = 0;
  const settle = (id: number, reply: unknown) => {
    const w = waiting.get(id);
    if (w === undefined) return;
    waiting.delete(id);
    w.answer(pairingAnswer(w.kind, reply));
  };
  Electron.ipcMain.on(R1_BLE_PAIRING_RESPONSE_CHANNEL, (event, message: unknown) => {
    const id = (message as { id?: unknown } | null)?.id;
    if (typeof id === "number" && event.sender === requester) settle(id, message);
  });
  const sessions = new WeakSet<Electron.Session>();
  const watch = (contents: Electron.WebContents) => {
    let giveUp: ReturnType<typeof setTimeout> | null = null;
    // The page asked for the R1's setup service only, so the first device found is an R1 in setup mode.
    contents.on("select-bluetooth-device", (event, devices, choose) => {
      event.preventDefault();
      requester = contents;
      const found = devices[0];
      if (found !== undefined) {
        if (giveUp !== null) clearTimeout(giveUp);
        giveUp = null;
        choose(found.deviceId);
      } else
        giveUp ??= setTimeout(() => {
          giveUp = null;
          choose("");
        }, CHOOSE_TIMEOUT_MS);
    });
    const session = contents.session;
    // Electron uses the handler on Windows and Linux; macOS pairs through the system and ignores it.
    if (sessions.has(session)) return;
    sessions.add(session);
    session.setBluetoothPairingHandler((details, answer) => {
      const page = requester;
      if (page === null || page.isDestroyed()) return answer({ confirmed: false });
      const id = ++next;
      waiting.set(id, { kind: details.pairingKind, answer });
      page.send(R1_BLE_PAIRING_REQUEST_CHANNEL, {
        id,
        kind: details.pairingKind,
        ...(details.pin === undefined ? {} : { pin: details.pin }),
      });
      setTimeout(() => settle(id, null), ANSWER_TIMEOUT_MS).unref();
    });
  };
  for (const contents of existing) watch(contents);
  Electron.app.on("web-contents-created", (_event, contents) => watch(contents));
}

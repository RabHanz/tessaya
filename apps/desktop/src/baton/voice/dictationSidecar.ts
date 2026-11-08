// @effect-diagnostics globalDate:off globalTimers:off nodeBuiltinImport:off
/**
 * `tessaya-voice` (native/baton-dictation): Handy's engine stack as a child process. It owns
 * the hold and toggle keys, the recording, Parakeet and the paste; this file is the line protocol.
 * The same binary is the wake path's microphone (`makeSidecarAudioInput`), so what voice-lab
 * measures is exactly what the product hears.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";

import type { CaretContext } from "@t3tools/baton-shared/dictationFit";
import { outsideLanguages } from "@t3tools/baton-shared/dictationLanguages";
import { encodeWav, SET_ASIDE, type SttProvider } from "@t3tools/baton-voice";

import { makeFramer } from "./pcm.ts";
import type { AudioInputDevice, AudioInputProvider } from "./voiceTypes.ts";

export type PasteMethod = "ctrl_v" | "shift_insert" | "ctrl_shift_v";

export interface DictationConfig {
  readonly model: string | null;
  /** null while Wispr is the chosen engine: Baton then holds no global key at all. */
  readonly hold: ReadonlyArray<string> | null;
  readonly toggle: ReadonlyArray<string> | null;
  readonly device: string | null;
  readonly channel: number | null;
  readonly paste: PasteMethod;
  readonly language: string | null;
  /** Cloud recognition: each recording is written as a WAV into this private folder and handed back, not recognised here. */
  readonly external?: string | null;
  /** The sidecar leaves the paste to the desktop, which cleans the text up first. */
  readonly cleanup: boolean;
  /** Two quick taps of the hold key keep the microphone open until the next press. */
  readonly latch?: boolean;
  /** The input-bindings file the sidecar's mouse hook reads; null or empty means no hook. */
  readonly mouse?: string | null;
  /** Keep the speech model loaded between dictations (about 1.2 GB for v3); off on a machine with under 10 GB. */
  readonly keepLoaded?: boolean;
}

/**
 * Whether the recorder is recording after this event. Only its state events say so: a result fed back
 * from the cloud, a notice or a reconfigure leaves a live recording as it was.
 */
/** Whether the sidecar is busy with a key dictation (recording it, or writing it out) after this event. */
export const busyAfter = (ev: DictationEvent["ev"], was: boolean): boolean =>
  ev === "recording" || ev === "transcribing"
    ? true
    : ev === "idle" || ev === "error"
      ? false
      : was;

export const recordingAfter = (ev: DictationEvent["ev"], was: boolean): boolean =>
  ev === "recording" || ev === "transcribing" || ev === "idle" || ev === "error"
    ? ev === "recording"
    : was;

export interface FocusedApp {
  readonly exe: string;
  readonly title: string;
  readonly window?: number;
  /** Physical pixels; null when the OS would not say. */
  readonly rect?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  } | null;
}

/** The accessibility tree's element for a label, in physical pixels. */
export interface LocatedElement {
  readonly found: boolean;
  readonly name?: string;
  readonly x?: number;
  readonly y?: number;
  /** The control's size in physical pixels. */
  readonly width?: number;
  readonly height?: number;
  /** What is on top at the control's centre, when a click there would not reach it. */
  readonly covered_by?: string;
  /** How the control was acted on without a pointer (invoke, select, toggle, expand); "pending" while a dialog it opened is up. */
  readonly invoked?: string;
  /** The tree line asked for by number is gone or no longer that control: read the tree again. */
  readonly stale?: boolean;
  /** After a press by its pattern: the control's own value and states, since the keyboard does not move. */
  readonly state?: string;
  readonly error?: string;
}

/** The hands' pointer and keys, sent by the sidecar: physical pixels, SendInput mouse flags and virtual-key codes. */
export type SidecarInput =
  | {
      readonly op: "at";
      readonly x?: number;
      readonly y?: number;
      readonly buttons: ReadonlyArray<number>;
      readonly wheel?: number;
    }
  | { readonly op: "keys"; readonly vks: ReadonlyArray<number> };

/** The names and kinds of what the keyboard's window offers, from the accessibility tree. */
/** A window's picture written at `out`: its size and top-left in physical pixels. */
export interface WindowPicture {
  readonly width?: number;
  readonly height?: number;
  readonly left?: number;
  readonly top?: number;
  readonly error?: string;
}

export interface UiTree {
  readonly window?: string;
  readonly controls?: ReadonlyArray<string>;
  readonly total?: number;
  /** How many lines matched before the cut; more than `controls` holds means the list was cut. */
  readonly shown?: number;
  /** A numbered tree's id: a click by number names it, and is refused once another tree was numbered. */
  readonly tree?: number;
  readonly error?: string;
}

/** Where the keyboard is: the window's title and the focused control's tree line (no number). */
export interface FocusState {
  readonly window?: string;
  readonly focus?: string | null;
  readonly error?: string;
}

export type DictationEvent =
  | { readonly ev: "ready" }
  | { readonly ev: "configured"; readonly mouse?: boolean }
  /** A mouse binding fired; `id` is the action of the Keyboard and mouse page. */
  | { readonly ev: "binding"; readonly id: string; readonly up?: boolean }
  | { readonly ev: "recording"; readonly app?: string; readonly title?: string }
  | { readonly ev: "transcribing" }
  /** The words so far, at a pause while the key is still held. */
  | { readonly ev: "partial"; readonly text: string }
  /** The speech model is being read from disk; one line a second while it is, so a slow load is told from a hang. */
  | { readonly ev: "loading"; readonly elapsedMs: number }
  | { readonly ev: "idle" }
  | { readonly ev: "error"; readonly message: string }
  /** Just before the chord, what the clipboard held (ours or something else); when settled, whether it was read. */
  | {
      readonly ev: "paste_check";
      readonly phase: "chord" | "settled";
      readonly held?: "ours" | "other";
      readonly chars?: number;
      readonly read?: boolean;
      readonly restored?: boolean;
      readonly changedOutside?: boolean;
    }
  /** The paste chord went out and nothing read the clipboard. */
  /** False when something else wrote the clipboard since: the desktop keeps the words (tray: Copy last transcript). */
  | { readonly ev: "unread"; readonly text: string; readonly onClipboard?: boolean }
  | {
      readonly ev: "text";
      readonly id: number | null;
      /** Set by the desktop as the event arrives: its recording's window, and whether it was discarded. */
      readonly app?: FocusedApp;
      readonly discarded?: boolean;
      /** Cloud recognition: when the sidecar's recording reached the desktop, before the cloud heard it. */
      readonly arrivedAt?: number;
      /** Cloud recognition: the recording for the desktop to recognise, deleted once it has; the text is then empty. */
      readonly wav?: string | null;
      readonly audioMs?: number;
      /** Above 0 when the model had to be read first (after an idle unload). */
      readonly loadMs?: number;
      readonly model?: string | null;
      readonly text?: string;
      readonly error?: string;
      readonly pasteError?: string | null;
      readonly dictated?: boolean;
      readonly pasted?: boolean;
      /** The window it was spoken for; null when it must not be pasted. */
      readonly target?: number | null;
      readonly releaseMs?: number | null;
      readonly inferMs?: number;
      readonly pieces?: number;
      /** How long the sidecar's own paste took (cleanup off); null when it did not paste. */
      readonly pasteMs?: number | null;
      readonly timing?: SidecarTiming | null;
    };

/** A live dictation's stage times from its key press (`dictationTiming`). */
export interface SidecarTiming {
  readonly via: "hold" | "toggle" | "start";
  readonly micMs: number;
  readonly firstAudioMs: number | null;
  readonly releasedMs: number;
}

export interface SidecarDevice {
  readonly name: string;
  readonly channels: number | null;
  readonly isDefault?: boolean;
}

export interface DictationSidecar {
  readonly configure: (config: DictationConfig) => void;
  readonly toggle: () => void;
  /** Starts a recording unless one is running (a mouse button held to dictate). */
  readonly start: () => void;
  /** Ends the running recording, if any, and writes it out. */
  readonly finish: () => void;
  /** The desktop's voice dictation is on: a dictation key press is its ✓, not a second recording. */
  readonly voice: (on: boolean) => void;
  readonly cancel: () => void;
  readonly devices: () => Promise<ReadonlyArray<SidecarDevice>>;
  /** `model`: a model file of its own (the wake path's); dictation's when absent or null. */
  readonly transcribe: (wavPath: string, model?: string | null) => Promise<string>;
  /** Loads the speech model now. Resolves with the load time in ms; waits as long as the load shows progress. */
  readonly preload: () => Promise<number>;
  readonly paste: (text: string) => Promise<void>;
  /** False when that window is no longer the focused one, and nothing was pasted. */
  readonly pasteInto: (text: string, target: number) => Promise<boolean>;
  readonly foreground: () => Promise<FocusedApp>;
  /** The top-level window under a physical point. */
  readonly windowAt: (point: {
    readonly x: number;
    readonly y: number;
  }) => Promise<{ readonly window: number; readonly label: string } | null>;
  /** Lab only (BATON_LAB): real mouse input from inside the sidecar. */
  readonly nudge: (dx: number, dy: number) => void;
  readonly locate: (input: {
    readonly label: string;
    readonly x: number;
    readonly y: number;
    /** Search the window with the keyboard instead of the one under the point. */
    readonly foreground?: boolean;
    /** Search the window whose title contains this, wherever it is, without bringing it forward. */
    readonly window?: string;
    /** Also act on the control through its own UI Automation pattern: no pointer, no focus change. */
    readonly invoke?: boolean;
    /** A line number of a numbered tree, in place of the label, and that tree's id. */
    readonly ref?: number;
    readonly tree?: number;
  }) => Promise<LocatedElement>;
  /** A running count of desktop changes (foreground, menus, focus, values) from WinEvents. */
  readonly uiChanges: () => Promise<{ readonly count?: number; readonly error?: string }>;
  /** `number`: the model's own read, numbered and kept for clicks by number; other reads leave those numbers alone. */
  readonly uiTree: (window?: string, find?: string, number?: boolean) => Promise<UiTree>;
  readonly focusState: (window?: string) => Promise<FocusState>;
  /** The words either side of the caret in the focused field; null when it does not say. */
  readonly caret: () => Promise<CaretContext | null>;
  readonly input: (input: SidecarInput) => Promise<void>;
  /** Adds text to the box of a window by its UI Automation value: no keyboard, clipboard or focus. */
  readonly setValue: (
    window: string,
    text: string,
  ) => Promise<{ readonly set: boolean; readonly name?: string; readonly error?: string }>;
  /** A picture of one window (PrintWindow, so covered or in the background) written as a BMP at `out`. */
  /** Gives the keyboard back to a window by the handle `foreground` reported. */
  readonly focusWindow: (window: number) => Promise<{ readonly error?: string }>;
  /** Brings an open window to the front with the keyboard, by part of its title; no pointer. */
  readonly focusWindowTitled: (
    title: string,
  ) => Promise<{ readonly title?: string; readonly error?: string }>;
  readonly captureWindow: (input: {
    readonly window?: string;
    /** The window exactly, by the handle `foreground` reported. */
    readonly handle?: number;
    readonly out: string;
  }) => Promise<WindowPicture>;
  readonly dispose: () => void;
}

/** Packaged next to the app; BATON_DICTATION points a dev build at a local binary. Builds before the rename ship `baton-dictation`. */
export const resolveDictationBinary = (input: {
  readonly resourcesPath: string;
  readonly platform: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly exists?: (path: string) => boolean;
}): string | null => {
  const exists = input.exists ?? NodeFS.existsSync;
  const exe = input.platform === "win32" ? ".exe" : "";
  const candidates = [
    input.env["BATON_DICTATION"],
    ...["tessaya-voice", "baton-dictation"].map((name) =>
      NodePath.join(input.resourcesPath, "baton-voice", `${name}${exe}`),
    ),
  ];
  return candidates.find((path): path is string => path !== undefined && exists(path)) ?? null;
};

/** The sidecar's foreground event. Without `window` a drive cannot see the keyboard move. */
export const focusedFrom = (event: Readonly<Record<string, unknown>>): FocusedApp => {
  const { app, title, rect, window } = event as {
    app?: string;
    title?: string;
    rect?: FocusedApp["rect"];
    window?: number;
  };
  return {
    exe: app ?? "",
    title: title ?? "",
    rect: rect ?? null,
    ...(typeof window === "number" && window !== 0 ? { window } : {}),
  };
};

const CALL_TIMEOUT_MS = 120_000;
/** A model load that has said nothing for this long is stuck; while it says "loading" every second, a call waits for it. */
export const LOAD_SILENCE_MS = 30_000;
/** A process that lived this long was working, so its next failure starts the backoff again. */
export const HEALTHY_RUN_MS = 30_000;

/** Seconds, not a hot loop: 1, 2, 4 … up to a minute. */
export const restartDelayMs = (failures: number): number =>
  Math.min(60_000, 1_000 * 2 ** Math.max(0, failures - 1));

const lastLine = (text: string): string | null => {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  return lines.length === 0 ? null : lines[lines.length - 1]!.slice(0, 200);
};

export const startDictationSidecar = (input: {
  readonly binary: string;
  readonly onEvent: (event: DictationEvent) => void;
  /** A recognition started or ended in the sidecar process `pid`. */
  readonly recognising?: (pid: number, active: boolean) => void;
  /** Each clip's recognition, for the turn log: time in the model against time waiting for it. */
  readonly onRecognised?: (timing: {
    readonly audioMs: number;
    readonly inferMs: number;
    readonly loadMs: number;
    readonly roundTripMs: number;
    /** The model file that recognised it; null from a sidecar too old to say. */
    readonly model: string | null;
  }) => void;
}): DictationSidecar => {
  let child: NodeChildProcess.ChildProcessWithoutNullStreams | null = null;
  let disposed = false;
  let lastConfig: DictationConfig | null = null;
  let nextId = 0;
  type Pending = {
    resolve: (value: never) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
    /** Waiting on the model: each "loading" line gives it more time. */
    readonly onLoad: boolean;
    readonly sentAt: number;
  };
  const pending = new Map<number, Pending>();
  let deviceWaiters: Array<(devices: ReadonlyArray<SidecarDevice>) => void> = [];
  let failures = 0;

  const send = (message: unknown) => {
    if (child?.stdin.writable === true) child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const settle = (id: number | null | undefined, result: { value?: unknown; error?: string }) => {
    const entry = id === null || id === undefined ? undefined : pending.get(id);
    if (entry === undefined) return;
    pending.delete(id as number);
    clearTimeout(entry.timer);
    if (result.error !== undefined) entry.reject(new Error(result.error));
    else entry.resolve(result.value as never);
  };
  const arm = (id: number, ms: number): ReturnType<typeof setTimeout> =>
    setTimeout(() => settle(id, { error: NO_ANSWER }), ms);
  const call = <T>(message: Record<string, unknown>, onLoad = false): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, {
        resolve: resolve as (value: never) => void,
        reject,
        timer: arm(id, onLoad ? LOAD_SILENCE_MS + CALL_TIMEOUT_MS : CALL_TIMEOUT_MS),
        onLoad,
        sentAt: Date.now(),
      });
      send({ ...message, id });
    });
  /** The model is loading and says so: everything waiting on it waits on, as long as it keeps saying so. */
  const loadingHeard = () => {
    for (const [id, entry] of pending) {
      if (!entry.onLoad) continue;
      clearTimeout(entry.timer);
      entry.timer = arm(id, LOAD_SILENCE_MS + CALL_TIMEOUT_MS);
    }
  };

  const spawn = () => {
    const proc = NodeChildProcess.spawn(input.binary, ["serve"], { windowsHide: true });
    child = proc;
    const startedAt = Date.now();
    let stderr = "";
    proc.stderr.on("data", (data: Buffer) => {
      stderr = (stderr + data.toString()).slice(-2_000);
    });
    // The exit handler restarts it; a write in the gap after it died must not throw.
    proc.stdin.on("error", () => {});
    proc.on("error", (error) => input.onEvent({ ev: "error", message: error.message }));
    NodeReadline.createInterface({ input: proc.stdout }).on("line", (line) => {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line) as Record<string, unknown>;
      } catch {
        return;
      }
      if (event["ev"] === "devices") {
        const devices = (event["devices"] as ReadonlyArray<SidecarDevice>) ?? [];
        deviceWaiters.forEach((resolve) => resolve(devices));
        deviceWaiters = [];
        return;
      }
      if (event["ev"] === "loading") {
        loadingHeard();
        return input.onEvent(event as unknown as DictationEvent);
      }
      if (event["ev"] === "model_ready") {
        const error = typeof event["error"] === "string" ? event["error"] : undefined;
        return settle(
          event["id"] as number,
          error === undefined ? { value: event["loadMs"] } : { error },
        );
      }
      if (event["ev"] === "pasted") {
        const error = typeof event["error"] === "string" ? event["error"] : undefined;
        return settle(
          event["id"] as number,
          error === undefined ? { value: event["moved"] !== true } : { error },
        );
      }
      if (event["ev"] === "input") {
        const error = typeof event["error"] === "string" ? event["error"] : undefined;
        return settle(
          event["id"] as number,
          error === undefined ? { value: undefined } : { error },
        );
      }
      if (event["ev"] === "caret") {
        const { before, after } = event;
        return settle(event["id"] as number, {
          value: typeof before === "string" && typeof after === "string" ? { before, after } : null,
        });
      }
      if (event["ev"] === "foreground") {
        return settle(event["id"] as number, { value: focusedFrom(event) });
      }
      if (event["ev"] === "window_at") {
        const { window, app, title } = event as { window?: number; app?: string; title?: string };
        return settle(event["id"] as number, {
          value:
            typeof window === "number" && window !== 0
              ? { window, label: `${app ?? ""}: ${title ?? ""}` }
              : null,
        });
      }
      if (
        event["ev"] === "located" ||
        event["ev"] === "tree" ||
        event["ev"] === "captured" ||
        event["ev"] === "focused" ||
        event["ev"] === "value_set"
      ) {
        return settle(event["id"] as number, { value: event });
      }
      if (event["ev"] === "text" && event["dictated"] !== true) {
        const error = typeof event["error"] === "string" ? event["error"] : undefined;
        const sentAt = pending.get(event["id"] as number)?.sentAt;
        if (error === undefined && sentAt !== undefined)
          input.onRecognised?.({
            audioMs: Number(event["audioMs"] ?? 0),
            inferMs: Number(event["inferMs"] ?? 0),
            loadMs: Number(event["loadMs"] ?? 0),
            roundTripMs: Date.now() - sentAt,
            model: typeof event["model"] === "string" ? event["model"] : null,
          });
        return settle(
          event["id"] as number,
          error === undefined ? { value: event["text"] } : { error },
        );
      }
      input.onEvent(event as unknown as DictationEvent);
    });
    proc.on("exit", () => {
      child = null;
      for (const entry of pending.values()) entry.reject(new Error("Dictation stopped."));
      pending.clear();
      deviceWaiters.forEach((resolve) => resolve([]));
      deviceWaiters = [];
      if (disposed) return;
      failures = Date.now() - startedAt >= HEALTHY_RUN_MS ? 1 : failures + 1;
      const delay = restartDelayMs(failures);
      const reason = lastLine(stderr) ?? "it exited";
      input.onEvent({
        ev: "error",
        message: `Dictation stopped (${reason}). Trying again in ${Math.round(delay / 1000)} s.`,
      });
      setTimeout(() => {
        if (disposed) return;
        spawn();
        if (lastConfig !== null) send({ cmd: "configure", ...lastConfig });
      }, delay);
    });
  };
  spawn();

  return {
    configure: (config) => {
      lastConfig = config;
      send({ cmd: "configure", ...config });
    },
    toggle: () => send({ cmd: "toggle" }),
    start: () => send({ cmd: "start" }),
    finish: () => send({ cmd: "finish" }),
    voice: (on) => send({ cmd: "voice", on }),
    cancel: () => send({ cmd: "cancel" }),
    devices: () =>
      new Promise((resolve) => {
        deviceWaiters.push(resolve);
        send({ cmd: "devices" });
      }),
    transcribe: async (wav, model) => {
      const pid = child?.pid;
      if (pid !== undefined) input.recognising?.(pid, true);
      try {
        return await call<string>(
          { cmd: "transcribe", wav, ...(model == null ? {} : { model }) },
          true,
        );
      } finally {
        if (pid !== undefined) input.recognising?.(pid, false);
      }
    },
    preload: () => call<number>({ cmd: "load" }, true),
    paste: (text) => call<void>({ cmd: "paste", text }),
    pasteInto: (text, target) => call<boolean>({ cmd: "paste", text, target }),
    foreground: () => call<FocusedApp>({ cmd: "foreground" }),
    windowAt: ({ x, y }) =>
      call<{ window: number; label: string } | null>({ cmd: "window_at", x, y }),
    nudge: (dx, dy) => send({ cmd: "nudge", dx, dy }),
    locate: (input) => call<LocatedElement>({ cmd: "locate", ...input }),
    uiChanges: () => call<{ count?: number; error?: string }>({ cmd: "ui_changes" }),
    uiTree: (window, find, number) =>
      call<UiTree>({
        cmd: "ui_tree",
        ...(window === undefined ? {} : { window }),
        ...(find === undefined ? {} : { find }),
        ...(number === true ? { number: true } : {}),
      }),
    caret: () => call<CaretContext | null>({ cmd: "caret" }),
    focusState: (window) =>
      call<FocusState>({ cmd: "focus_state", ...(window === undefined ? {} : { window }) }),
    input: (input) => call<void>({ cmd: "input", ...input }),
    setValue: (window, text) =>
      call<{ set: boolean; name?: string; error?: string }>({ cmd: "set_value", window, text }),
    focusWindow: (window) => call<{ error?: string }>({ cmd: "focus_window", window }),
    focusWindowTitled: (title) =>
      call<{ title?: string; error?: string }>({ cmd: "focus_window", title }),
    captureWindow: (input) => call<WindowPicture>({ cmd: "capture_window", ...input }),
    dispose: () => {
      disposed = true;
      child?.stdin.end();
      child?.kill();
    },
  };
};

/** Parakeet behind the core's `SttProvider`, in the sidecar that already holds the model. */
/** A call the sidecar did not answer in time: a busy machine, not a sign that the model it was given is bad. */
const NO_ANSWER = "Dictation did not answer.";

export const makeSidecarStt = (
  sidecar: DictationSidecar,
  /** His languages; what reads as another one is not heard, and `onOutside` is told which. */
  languages: () => ReadonlyArray<string> = () => [],
  onOutside?: (code: string) => void,
  /** His cloud recogniser when he chose one: it gets the clip and falls back to `local` itself. */
  recognise?: (wav: Uint8Array, audioMs: number, local: () => Promise<string>) => Promise<string>,
  /** The model file to recognise with, read for each clip; dictation's when it gives null. */
  model?: () => string | null,
  /** That model failed (it would not load): told once per failure, and the clip is heard by dictation's instead. */
  onModelFailed?: (file: string, error: unknown) => void,
): SttProvider => ({
  name: "parakeet",
  transcribe: async (pcm) => {
    const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "baton-voice-"));
    const file = NodePath.join(dir, "utterance.wav");
    try {
      const wav = encodeWav(pcm);
      await NodeFSP.writeFile(file, wav);
      const own = model?.() ?? null;
      const local = () =>
        own === null
          ? sidecar.transcribe(file)
          : sidecar.transcribe(file, own).catch((error: unknown) => {
              // Asking again with dictation's model would only wait out another timeout.
              if (error instanceof Error && error.message === NO_ANSWER) throw error;
              onModelFailed?.(own, error);
              return sidecar.transcribe(file);
            });
      const text = await (recognise === undefined
        ? local()
        : recognise(wav, pcm.length / 16, local));
      const outside = outsideLanguages(text, languages());
      if (outside === null) return text;
      onOutside?.(outside);
      return SET_ASIDE;
    } finally {
      await NodeFSP.rm(dir, { recursive: true, force: true });
    }
  },
});

/** Wake-word capture: `tessaya-voice record` piped straight in, with no browser in the path. */
export const makeSidecarAudioInput = (input: {
  readonly binary: string;
  readonly listDevices: () => Promise<ReadonlyArray<AudioInputDevice>>;
  /** The input of a multi-input interface to read, for a device. */
  readonly channelFor: (device: string) => number | null;
  /** The recorder ended without being asked: the device probably left. */
  readonly onLost: (reason: string | null, ranMs: number) => void;
}): AudioInputProvider => {
  let proc: NodeChildProcess.ChildProcessWithoutNullStreams | null = null;
  return {
    listDevices: input.listDevices,
    start: async ({ deviceId, onFrame }) => {
      proc?.kill();
      const channel = deviceId === null ? null : input.channelFor(deviceId);
      const args = [
        "record",
        ...(deviceId === null ? [] : ["--device", deviceId]),
        ...(channel === null ? [] : ["--channel", String(channel)]),
      ];
      const started = NodeChildProcess.spawn(input.binary, args, { windowsHide: true });
      proc = started;
      const framer = makeFramer(onFrame);
      let odd: Buffer | null = null;
      started.stdout.on("data", (data: Buffer) => {
        const joined = odd === null ? data : Buffer.concat([odd, data]);
        const usable = joined.length - (joined.length % 2);
        odd = usable === joined.length ? null : joined.subarray(usable);
        // Copied: a Buffer's pool offset is not always aligned for Int16Array.
        const samples = new Int16Array(usable / 2);
        Buffer.from(samples.buffer).set(joined.subarray(0, usable));
        framer(samples);
      });
      const startedAt = Date.now();
      let stderr = "";
      started.stderr.on("data", (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-2_000);
      });
      // "exit" does not fire when the spawn itself failed, such as a quarantined exe.
      const lost = () => {
        if (proc !== started) return;
        proc = null;
        input.onLost(lastLine(stderr), Date.now() - startedAt);
      };
      started.on("error", (error) => {
        stderr += `\n${error.message}`;
        lost();
      });
      started.on("exit", lost);
    },
    stop: async () => {
      const running = proc;
      proc = null;
      running?.kill();
    },
  };
};

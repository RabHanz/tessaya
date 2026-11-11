/* oxlint-disable t3code/no-low-value-comments -- Baton file predating the rule (D82) */
/**
 * Optional input bindings, any state to any key or mouse button (his go-to: the middle button to
 * start listening, or left and right together). Voice alone always works; none of this is on by
 * default. The file is `<state dir>/voice/input-bindings.json`.
 *
 * `reduceMouse` is the reference for the Windows hook. The hook must decide inside a low-level
 * mouse callback, so it lives in the dictation sidecar (native/baton-dictation, `windows` crate, no
 * new dependency and no native module in Electron main) and mirrors this reducer; the vectors in
 * inputBindings.test.ts are what that port must satisfy. Events the sidecar injects itself carry a
 * marker in dwExtraInfo and are never fed back in.
 */

export const BINDABLE_ACTIONS = [
  "listen_start",
  "listen_stop",
  "mute",
  "dictate",
  "ask",
  "clear_screen",
  "direct_session",
  "dictate_hold",
  "dictate_toggle",
  "paste_last",
] as const;
export type BindableAction = (typeof BINDABLE_ACTIONS)[number];

export type MouseButton = "left" | "right" | "middle" | "x1" | "x2";

export type Trigger =
  /** An accelerator the keyboard hook understands, such as "Ctrl+Alt+Space". */
  | { readonly kind: "key"; readonly accelerator: string }
  /** One extra button. Left and right alone are refused: they are how every app is used. */
  | { readonly kind: "button"; readonly button: Exclude<MouseButton, "left" | "right"> }
  /** Two or more buttons pressed together, such as left and right. */
  | { readonly kind: "chord"; readonly buttons: ReadonlyArray<MouseButton> };

export interface InputBinding {
  readonly id: string;
  readonly action: BindableAction;
  readonly trigger: Trigger;
}

export interface InputBindingsConfig {
  readonly version: 1;
  readonly bindings: ReadonlyArray<InputBinding>;
  /** A chord's two presses must land within this; otherwise the first was an ordinary click. */
  readonly chordWindowMs: number;
}

export const DEFAULT_CHORD_WINDOW_MS = 50;
export const EMPTY_BINDINGS: InputBindingsConfig = {
  version: 1,
  bindings: [],
  chordWindowMs: DEFAULT_CHORD_WINDOW_MS,
};

const BUTTONS = new Set<string>(["left", "right", "middle", "x1", "x2"]);

/** Tolerant: a bad file is no bindings, a bad binding is skipped, two on one trigger keep the first. */
export const parseInputBindings = (value: unknown): InputBindingsConfig => {
  const raw = value as { bindings?: unknown; chordWindowMs?: unknown } | null;
  const list = Array.isArray(raw?.bindings) ? raw.bindings : [];
  const seen = new Set<string>();
  const bindings: Array<InputBinding> = [];
  for (const item of list as ReadonlyArray<Partial<InputBinding>>) {
    if (typeof item?.id !== "string" || !BINDABLE_ACTIONS.includes(item.action as BindableAction))
      continue;
    const t = item.trigger as
      | { kind?: string; button?: string; buttons?: unknown; accelerator?: string }
      | undefined;
    let trigger: Trigger | null = null;
    if (t?.kind === "key" && typeof t.accelerator === "string" && t.accelerator.length > 0) {
      trigger = { kind: "key", accelerator: t.accelerator };
    } else if (
      t?.kind === "button" &&
      BUTTONS.has(t.button ?? "") &&
      t.button !== "left" &&
      t.button !== "right"
    ) {
      trigger = { kind: "button", button: t.button as Exclude<MouseButton, "left" | "right"> };
    } else if (
      t?.kind === "chord" &&
      Array.isArray(t.buttons) &&
      t.buttons.length >= 2 &&
      t.buttons.every((b) => BUTTONS.has(b as string)) &&
      new Set(t.buttons).size === t.buttons.length
    ) {
      trigger = { kind: "chord", buttons: [...(t.buttons as ReadonlyArray<MouseButton>)].sort() };
    }
    if (trigger === null) continue;
    const key =
      trigger.kind === "key"
        ? `k:${trigger.accelerator.toLowerCase()}`
        : trigger.kind === "button"
          ? `b:${trigger.button}`
          : `c:${trigger.buttons.join("+")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    bindings.push({ id: item.id, action: item.action as BindableAction, trigger });
  }
  const window = raw?.chordWindowMs;
  return {
    version: 1,
    bindings,
    chordWindowMs:
      typeof window === "number" && window >= 20 && window <= 120
        ? window
        : DEFAULT_CHORD_WINDOW_MS,
  };
};

// ── The mouse reducer ───────────────────────────────────────────────────────

export interface MouseEvent {
  readonly type: "down" | "up" | "tick";
  /** Milliseconds, any monotonic clock. */
  readonly t: number;
  readonly button?: MouseButton;
}

export type MouseAction =
  /** Let the event reach the app. */
  | { readonly kind: "pass" }
  /** Swallow the event. */
  | { readonly kind: "consume" }
  /** A binding fired. */
  | { readonly kind: "fire"; readonly id: string }
  /** A single-button binding's button came back up: "hold to dictate" ends when he lets go. */
  | { readonly kind: "release"; readonly id: string }
  /** Send a press the hook had held back, now, because it turned out not to be a chord. */
  | { readonly kind: "replay_down"; readonly button: MouseButton };

export interface MouseState {
  /** A chord button pressed and held back while the second might still come. */
  readonly held: { readonly button: MouseButton; readonly at: number } | null;
  /** Buttons whose release must be swallowed because their press was. */
  readonly swallowUp: ReadonlyArray<MouseButton>;
  /** Buttons the app has seen go down and not up: a press beside one of these is never a chord. */
  readonly down: ReadonlyArray<MouseButton>;
}
export const IDLE_MOUSE: MouseState = { held: null, swallowUp: [], down: [] };

export interface MouseStep {
  readonly state: MouseState;
  /** First the held-back press, if it is released, then what happens to this event. */
  readonly actions: ReadonlyArray<MouseAction>;
}

const chordsOf = (cfg: InputBindingsConfig) =>
  cfg.bindings.flatMap((b) =>
    b.trigger.kind === "chord" ? [{ id: b.id, buttons: b.trigger.buttons }] : [],
  );

export const reduceMouse = (
  state: MouseState,
  event: MouseEvent,
  cfg: InputBindingsConfig,
): MouseStep => {
  const actions: Array<MouseAction> = [];
  let { held, swallowUp, down } = state;
  const next = (): MouseStep => ({ state: { held, swallowUp, down }, actions });
  // A press held longer than the window was an ordinary click or the start of a drag.
  if (held !== null && event.t - held.at >= cfg.chordWindowMs) {
    actions.push({ kind: "replay_down", button: held.button });
    down = [...down, held.button];
    held = null;
  }
  const button = event.button;
  if (event.type === "tick" || button === undefined) return next();

  const chords = chordsOf(cfg);
  if (event.type === "down") {
    const single = cfg.bindings.find(
      (b) => b.trigger.kind === "button" && b.trigger.button === button,
    );
    if (single !== undefined) {
      swallowUp = [...swallowUp, button];
      actions.push({ kind: "fire", id: single.id }, { kind: "consume" });
      return next();
    }
    if (held !== null && held.button !== button) {
      const heldButton = held.button;
      const hit = chords.find((c) => c.buttons.includes(heldButton) && c.buttons.includes(button));
      if (hit !== undefined) {
        swallowUp = [...swallowUp, heldButton, button];
        held = null;
        actions.push({ kind: "fire", id: hit.id }, { kind: "consume" });
        return next();
      }
    }
    const startsChord =
      held === null &&
      chords.some(
        (c) => c.buttons.includes(button) && !c.buttons.some((other) => down.includes(other)),
      );
    if (startsChord) {
      held = { button, at: event.t };
      actions.push({ kind: "consume" });
      return next();
    }
    down = [...down, button];
    actions.push({ kind: "pass" });
    return next();
  }

  // up
  if (swallowUp.includes(button)) {
    swallowUp = swallowUp.filter((b, i) => !(b === button && i === swallowUp.indexOf(button)));
    const single = cfg.bindings.find(
      (b) => b.trigger.kind === "button" && b.trigger.button === button,
    );
    if (single !== undefined) actions.push({ kind: "release", id: single.id });
    actions.push({ kind: "consume" });
    return next();
  }
  if (held?.button === button) {
    // Released inside the window: a plain click, press then release, in order.
    held = null;
    actions.push({ kind: "replay_down", button }, { kind: "pass" });
    return next();
  }
  down = down.filter((b) => b !== button);
  actions.push({ kind: "pass" });
  return next();
};

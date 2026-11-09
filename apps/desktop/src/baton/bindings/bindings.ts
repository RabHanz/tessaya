/* oxlint-disable oxc/no-accumulating-spread -- Baton file predating the rule (D82) */
/**
 * Keyboard and mouse bindings (D141). One row per action; an unset row uses the action's default,
 * a row set to null is switched off on purpose. Saved in the voice settings file as
 * `bindings: [{ action, input }]`. Pure: capture, conflicts and the accelerator forms are testable.
 */
export type MouseButton = "middle" | "back" | "forward" | "left+right";

export type BindingInput =
  | { readonly type: "key"; readonly accelerator: string }
  | { readonly type: "mouse"; readonly button: MouseButton };

export interface Binding {
  readonly action: string;
  /** Up to four ways to do it; empty means he switched it off on purpose. */
  readonly inputs: ReadonlyArray<BindingInput>;
}

/** Most ways to do one action, as in Wispr Flow. */
export const MAX_PER_ACTION = 4;
/** Most keys in one chord, modifiers included. */
export const MAX_KEYS = 3;

export interface ActionDef {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  /** What it does when nothing is set. */
  readonly fallback: BindingInput | null;
}

const key = (accelerator: string): BindingInput => ({ type: "key", accelerator });

/** Ctrl, Alt, Shift, then Meta, then the key: one spelling for every comparison and every file. */
const MODIFIERS = ["Ctrl", "Alt", "Shift", "Meta"] as const;
const ALIASES: Readonly<Record<string, string>> = {
  control: "Ctrl",
  ctrl: "Ctrl",
  alt: "Alt",
  option: "Alt",
  shift: "Shift",
  meta: "Meta",
  win: "Meta",
  windows: "Meta",
  super: "Meta",
  cmd: "Meta",
  command: "Meta",
  commandorcontrol: "Ctrl",
  cmdorctrl: "Ctrl",
};

export const normaliseAccelerator = (accelerator: string): string => {
  const parts = accelerator
    .split("+")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
  const mods = new Set<string>();
  let main = "";
  for (const part of parts) {
    const alias = ALIASES[part.toLowerCase()];
    if (alias !== undefined) mods.add(alias);
    else main = part.length === 1 ? part.toUpperCase() : part[0]!.toUpperCase() + part.slice(1);
  }
  return [...MODIFIERS.filter((m) => mods.has(m)), ...(main === "" ? [] : [main])].join("+");
};

/** Electron's global shortcut wants "Control", not "Ctrl". */
export const toElectronAccelerator = (accelerator: string): string =>
  normaliseAccelerator(accelerator).replace(/^Ctrl\b|\+Ctrl\b/g, (m) =>
    m.replace("Ctrl", "Control"),
  );

export const sameInput = (a: BindingInput | null, b: BindingInput | null): boolean =>
  a === null || b === null
    ? false
    : a.type === "key" && b.type === "key"
      ? normaliseAccelerator(a.accelerator) === normaliseAccelerator(b.accelerator)
      : a.type === "mouse" && b.type === "mouse" && a.button === b.button;

export const ACTIONS: ReadonlyArray<ActionDef> = [
  {
    id: "wake",
    label: "Start listening",
    hint: "Wake Tessaya without saying the wake word.",
    fallback: key("Ctrl+Alt+Shift+F5"),
  },
  { id: "stop", label: "Stop", hint: "End an answer, a lesson or a drive.", fallback: null },
  {
    id: "mute",
    label: "Mute",
    hint: "Turn the microphone off and on.",
    fallback: key("Ctrl+Alt+Shift+F7"),
  },
  {
    id: "direct",
    label: "Send words to the focused session",
    hint: "What you say goes to the session in focus.",
    fallback: key("Ctrl+Alt+Shift+F6"),
  },
  {
    id: "hold",
    label: "Hold to dictate",
    hint: "Dictate while the key is down.",
    fallback: key("Ctrl+Shift+Win"),
  },
  {
    id: "toggle",
    label: "Start and stop dictating",
    hint: "Press once to start, again to stop.",
    fallback: key("Ctrl+Alt+Shift+Space"),
  },
  {
    id: "dictation",
    label: "Dictation on or off",
    hint: "Turn Tessaya's dictation key on or off.",
    fallback: key("Ctrl+Alt+Shift+F8"),
  },
  {
    id: "ask",
    label: "Ask Tessaya",
    hint: "Open the box to type a question.",
    fallback: key("Ctrl+Alt+Shift+B"),
  },
  {
    id: "pasteLast",
    label: "Paste the last transcript",
    hint: "Puts your last dictation in again, for a window that would not take it (a terminal, a remote desktop). Not bound until you choose a key.",
    fallback: null,
  },
  {
    id: "clear",
    label: "Clear the screen",
    hint: "Remove the pointer and any card.",
    fallback: null,
  },
];

const isButton = (v: unknown): v is MouseButton =>
  v === "middle" || v === "back" || v === "forward" || v === "left+right";

const parseInput = (value: unknown): BindingInput | null => {
  if (typeof value !== "object" || value === null) return null;
  const i = value as { type?: unknown; accelerator?: unknown; button?: unknown };
  if (
    i.type === "key" &&
    typeof i.accelerator === "string" &&
    normaliseAccelerator(i.accelerator) !== ""
  ) {
    return { type: "key", accelerator: normaliseAccelerator(i.accelerator) };
  }
  if (i.type === "mouse" && isButton(i.button)) return { type: "mouse", button: i.button };
  return null;
};

/** Without duplicates, and never more than the limit. */
const tidy = (inputs: ReadonlyArray<BindingInput>): ReadonlyArray<BindingInput> =>
  inputs
    .reduce<BindingInput[]>(
      (all, next) => (all.some((x) => sameInput(x, next)) ? all : [...all, next]),
      [],
    )
    .slice(0, MAX_PER_ACTION);

/** The saved list is untrusted: only a known action with well-formed inputs survives. Old files held one `input`. */
export const parseBindings = (raw: unknown): ReadonlyArray<Binding> => {
  if (!Array.isArray(raw)) return [];
  const known = new Set(ACTIONS.map((a) => a.id));
  const out = new Map<string, Binding>();
  for (const item of raw) {
    const { action, input, inputs } = (item ?? {}) as {
      action?: unknown;
      input?: unknown;
      inputs?: unknown;
    };
    if (typeof action !== "string" || !known.has(action)) continue;
    if (Array.isArray(inputs)) {
      out.set(action, { action, inputs: tidy(inputs.flatMap((i) => parseInput(i) ?? [])) });
    } else if (input === null) out.set(action, { action, inputs: [] });
    else {
      const one = parseInput(input);
      if (one !== null) out.set(action, { action, inputs: [one] });
    }
  }
  return [...out.values()];
};

export interface Effective {
  readonly def: ActionDef;
  readonly inputs: ReadonlyArray<BindingInput>;
  readonly isDefault: boolean;
  /** The other actions that use any of the same inputs. */
  readonly conflictsWith: ReadonlyArray<string>;
  /** Per input: who else has it, so the page can say so beside the chip. */
  readonly conflicts: ReadonlyArray<{
    readonly input: BindingInput;
    readonly with: ReadonlyArray<string>;
  }>;
}

export const effective = (
  saved: ReadonlyArray<Binding>,
  /** The dictation keys live in their own settings and win over the table's fallback. */
  fallbacks: Readonly<Record<string, BindingInput | null>> = {},
): ReadonlyArray<Effective> => {
  const rows = ACTIONS.map((def) => {
    const own = saved.find((b) => b.action === def.id);
    const fallback = def.id in fallbacks ? (fallbacks[def.id] ?? null) : def.fallback;
    const inputs = own === undefined ? (fallback === null ? [] : [fallback]) : own.inputs;
    return { def, inputs, isDefault: own === undefined };
  });
  return rows.map((row) => {
    const conflicts = row.inputs
      .map((input) => ({
        input,
        with: rows
          .filter((o) => o.def.id !== row.def.id && o.inputs.some((x) => sameInput(x, input)))
          .map((o) => o.def.label),
      }))
      .filter((c) => c.with.length > 0);
    return { ...row, conflicts, conflictsWith: [...new Set(conflicts.flatMap((c) => c.with))] };
  });
};

/** One action's list set outright, or put back to its default. */
export const withBinding = (
  saved: ReadonlyArray<Binding>,
  action: string,
  inputs: ReadonlyArray<BindingInput> | "reset",
): ReadonlyArray<Binding> => {
  const rest = saved.filter((b) => b.action !== action);
  return inputs === "reset" ? rest : [...rest, { action, inputs: tidy(inputs) }];
};

const RESERVED: Readonly<Record<string, string>> = {
  "Ctrl+Alt+Delete": "Windows keeps Ctrl+Alt+Delete for itself.",
  "Ctrl+Shift+Escape": "Windows opens Task Manager with Ctrl+Shift+Esc.",
  "Alt+F4": "Alt+F4 closes the window you are in.",
  "Alt+Tab": "Alt+Tab switches windows.",
  "Meta+Tab": "Win+Tab shows your open windows.",
  "Meta+L": "Win+L locks the computer.",
  // A mouse's "Show Desktop" button sends Win+D, which Windows' shell keeps: remapped to F13, it can be bound.
  "Meta+D":
    "Win+D belongs to Windows, which will not give it up. Remap that mouse button to F13 in its software, then bind F13.",
  "Ctrl+Escape": "Ctrl+Esc opens the Start menu.",
  "Ctrl+C": "Every app uses Ctrl+C to copy.",
  "Ctrl+V": "Every app uses Ctrl+V to paste.",
  "Ctrl+X": "Every app uses Ctrl+X to cut.",
  "Ctrl+Z": "Every app uses Ctrl+Z to undo.",
  "Ctrl+A": "Every app uses Ctrl+A to select all.",
};
const SAFE_ALONE = /^(?:F(?:[1-9]|1\d|2[0-4])|Pause|ScrollLock)$/;

export type InputCheck = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/** Whether a captured input may be bound, and the plain reason when not. Mouse buttons are always fine. */
export const checkInput = (input: BindingInput): InputCheck => {
  if (input.type === "mouse") return { ok: true };
  const accelerator = normaliseAccelerator(input.accelerator);
  const parts = accelerator.split("+");
  const main = parts.at(-1) ?? "";
  // Modifiers alone hold only with Win and one more, as Wispr Flow's Ctrl+Win: Ctrl+Shift alone is half of every
  // selection shortcut.
  const modifierOnly = main === "" || (MODIFIERS as ReadonlyArray<string>).includes(main);
  if (modifierOnly && !(parts.includes("Meta") && parts.length >= 2)) {
    return {
      ok: false,
      reason: "Press a key as well, or hold Win with Ctrl or Shift.",
    };
  }
  if (parts.length > MAX_KEYS)
    return { ok: false, reason: `Use at most ${MAX_KEYS} keys together.` };
  const reserved = RESERVED[accelerator];
  if (reserved !== undefined) return { ok: false, reason: reserved };
  if (parts.length === 1 && !SAFE_ALONE.test(main)) {
    return {
      ok: false,
      reason: "Add Ctrl, Alt, Shift or Win so it does not get in the way of typing.",
    };
  }
  return { ok: true };
};

export type Change = { readonly saved: ReadonlyArray<Binding> } | { readonly error: string };

/** Adds one more way to do an action. `current` is what the row shows now, defaults included. */
export const addInput = (
  saved: ReadonlyArray<Binding>,
  action: string,
  current: ReadonlyArray<BindingInput>,
  input: BindingInput,
): Change => {
  const check = checkInput(input);
  if (!check.ok) return { error: check.reason };
  if (current.some((x) => sameInput(x, input))) return { error: "That one is already set here." };
  if (current.length >= MAX_PER_ACTION) {
    return { error: `Four is the most for one action. Remove one first.` };
  }
  return { saved: withBinding(saved, action, [...current, input]) };
};

export const removeInput = (
  saved: ReadonlyArray<Binding>,
  action: string,
  current: ReadonlyArray<BindingInput>,
  index: number,
): ReadonlyArray<Binding> =>
  withBinding(
    saved,
    action,
    current.filter((_, i) => i !== index),
  );

import {
  EMPTY_BINDINGS,
  type BindableAction,
  type InputBindingsConfig,
  type Trigger,
} from "@t3tools/baton-shared/inputBindings";

import type { BindingInput } from "./bindings.ts";

const ACTION: Readonly<Record<string, BindableAction>> = {
  wake: "listen_start",
  stop: "listen_stop",
  mute: "mute",
  dictation: "dictate",
  ask: "ask",
  clear: "clear_screen",
  // Every row of the page: a button bound to any of these used to save and then do nothing (0.1.79).
  direct: "direct_session",
  hold: "dictate_hold",
  toggle: "dictate_toggle",
  pasteLast: "paste_last",
};

const trigger = (input: BindingInput): Trigger | null => {
  if (input.type === "key") return { kind: "key", accelerator: input.accelerator };
  switch (input.button) {
    case "middle":
      return { kind: "button", button: "middle" };
    case "back":
      return { kind: "button", button: "x1" };
    case "forward":
      return { kind: "button", button: "x2" };
    case "left+right":
      return { kind: "chord", buttons: ["left", "right"] };
  }
};

/**
 * What the Windows mouse hook is told: only the mouse bindings of the Keyboard and mouse page,
 * under the schema in baton-shared. Keys stay with the keyboard hook; an unbound button is not
 * listed, so the hook lets it through untouched.
 */
export const mouseHookConfig = (
  rows: ReadonlyArray<{
    readonly def: { readonly id: string };
    readonly inputs: ReadonlyArray<BindingInput>;
  }>,
): InputBindingsConfig => ({
  ...EMPTY_BINDINGS,
  bindings: rows.flatMap((row) =>
    row.inputs.flatMap((input) => {
      const action = ACTION[row.def.id];
      const t = input.type === "mouse" ? trigger(input) : null;
      return action !== undefined && t !== null ? [{ id: row.def.id, action, trigger: t }] : [];
    }),
  ),
});

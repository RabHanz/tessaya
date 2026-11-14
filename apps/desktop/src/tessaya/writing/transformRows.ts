/** The Transforms area of the window. */
import {
  formatTransform,
  parseTransform,
  type Transform,
} from "@t3tools/tessaya-shared/transforms";

import type { HomeControl } from "../home/tessayaHome.ts";
import type { TransformSettings } from "./transformStore.ts";

const ON = "Transforms";
const MINE = "My transforms";

/** Control+Alt+Shift+1 for the first, and so on; Z takes the last one back. */
export const HOTKEY_PREFIX = "Control+Alt+Shift+";
export const hotkeyFor = (index: number): string | null =>
  index >= 0 && index < 9 ? `${HOTKEY_PREFIX}${index + 1}` : null;

export const transformControls = (
  s: TransformSettings,
  all: ReadonlyArray<Transform>,
  note: string,
): ReadonlyArray<HomeControl> => [
  {
    id: "tr.enabled",
    section: ON,
    label: "Rewrite selected text with a named prompt",
    hint: `Select text in any app and press its shortcut, or say "polish this". Off until you turn it on; the shortcuts only exist while it is on. ${HOTKEY_PREFIX}Z, or "undo that", takes the last rewrite back.`,
    kind: "toggle",
    on: s.enabled,
    lead: true,
  },
  {
    id: "tr.command",
    section: ON,
    label: "Command mode: edit by voice",
    hint: 'Say "make this more concise", "fix the grammar", "delete the last sentence" or "select the previous paragraph" and Tessaya does it to your selection or the text before the caret. Off until you turn it on. "Undo that" takes the last one back.',
    kind: "toggle",
    on: s.command === true,
  },
  {
    id: "tr.auto",
    section: ON,
    label: "Apply one to every dictation",
    hint: "Runs after the clean-up, before the text lands. Your words go to your own Claude, as in clean-up. Skipped when it fails; the text is inserted as cleaned.",
    kind: "choice",
    value: s.autoApply ?? "none",
    options: [
      { value: "none", label: "None" },
      ...all.map((t) => ({ value: t.id, label: t.name })),
    ],
  },
  ...all.slice(0, 9).map((t, i): HomeControl => ({
    id: `tr.key:${t.id}`,
    section: ON,
    label: `${t.name}: ${hotkeyFor(i)}`,
    kind: "check",
    status: "ok",
    detail: t.prompt,
  })),
  {
    id: "tr.list",
    section: MINE,
    label: "Your own transforms",
    hint: "Add one as Name = what to do with the text. The same name as a built-in replaces it.",
    kind: "list",
    items: s.custom.map(formatTransform),
    placeholder: "Name = what to do with the text",
    addLabel: "Add",
  },
  {
    id: "tr.reset",
    section: MINE,
    label: "Put the built-in set back",
    hint: "Removes your own transforms and the automatic one.",
    kind: "action",
    button: "Reset to defaults",
  },
  ...(note === ""
    ? []
    : [
        {
          id: "tr.note",
          section: MINE,
          label: note,
          kind: "check",
          status: "ok",
          detail: "",
        } as const,
      ]),
];

export const transformAction = (id: string, value: string | boolean | null) => {
  if (id === "tr.enabled") return { kind: "enabled", on: value === true } as const;
  if (id === "tr.command") return { kind: "command", on: value === true } as const;
  if (id === "tr.auto" && typeof value === "string") {
    return { kind: "auto", id: value === "none" ? null : value } as const;
  }
  if (id === "tr.list:add" && typeof value === "string") {
    const t = parseTransform(value);
    return t === null ? ({ kind: "bad" } as const) : ({ kind: "put", transform: t } as const);
  }
  if (id === "tr.list:rm" && typeof value === "string") {
    const t = parseTransform(value);
    return t === null ? null : ({ kind: "remove", id: t.id } as const);
  }
  if (id === "tr.reset") return { kind: "reset" } as const;
  return null;
};

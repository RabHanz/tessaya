// @effect-diagnostics globalDate:off
/** The Scratchpad area of the window: add, search, copy and delete quick notes. */
import { previewOf, searchNotes, type ScratchNote } from "@t3tools/tessaya-shared/scratchpad";

import type { HomeControl } from "../home/tessayaHome.ts";

export const SCRATCH_HOTKEY = "Control+Alt+Shift+N";

export const scratchControls = (
  notes: ReadonlyArray<ScratchNote>,
  query: string,
  hotkey: boolean,
): ReadonlyArray<HomeControl> => {
  const shown = searchNotes(notes, query).slice(0, 100);
  return [
    {
      id: "sc.new",
      section: "Scratchpad",
      label: "A quick note",
      hint: 'Type it here, or say "take a note: buy milk". Notes stay on this computer, apart from History.',
      kind: "list",
      items: [],
      placeholder: "Write a note",
      addLabel: "Save",
      lead: true,
    },
    {
      id: "sc.hotkey",
      section: "Scratchpad",
      label: `Start a note from the keyboard (${SCRATCH_HOTKEY})`,
      hint: "Press it, speak, and the words go to the Scratchpad instead of the field you are in.",
      kind: "toggle",
      on: hotkey,
    },
    {
      id: "sc.search",
      section: "Notes",
      label: "Search your notes",
      kind: "list",
      items: query === "" ? [] : [query],
      placeholder: "Words to find",
      addLabel: "Search",
    },
    {
      id: "tf.pick",
      section: "Transcribe a file",
      label: "Turn a recording into a note",
      hint: "Choose an audio file, or drop one on this window. WAV works as it is; MP3, M4A, OGG and others need ffmpeg installed. The words are saved as a note and copied; nothing leaves this computer.",
      kind: "action",
      button: "Choose a file",
    },
    ...(shown.length === 0
      ? [
          {
            id: "sc.empty",
            section: "Notes",
            label: query === "" ? "No notes yet" : "No note has all of those words",
            kind: "check",
            status: "ok",
            detail: "",
          } as const,
        ]
      : shown.map((n): HomeControl => ({
          id: `sc:${n.id}`,
          section: "Notes",
          label: previewOf(n.text),
          hint: new Date(n.at).toLocaleString([], { dateStyle: "medium", timeStyle: "short" }),
          kind: "action",
          button: "Copy",
          secondary: "Delete",
        }))),
  ];
};

/** `sc.new:add` the text, `sc.search:add` and `:rm`, `sc.hotkey`, `sc:<id>` Copy and `sc:<id>:later` Delete. */
export const scratchAction = (id: string, value: string | boolean | null) => {
  if (id === "sc.new:add" && typeof value === "string")
    return { kind: "add", text: value } as const;
  if (id === "sc.search:add" && typeof value === "string")
    return { kind: "search", query: value } as const;
  if (id === "sc.search:rm") return { kind: "search", query: "" } as const;
  if (id === "sc.hotkey") return { kind: "hotkey", on: value === true } as const;
  const n = /^sc:([A-Za-z0-9-]+)(:later)?$/.exec(id);
  return n === null ? null : ({ kind: n[2] === undefined ? "copy" : "delete", id: n[1]! } as const);
};

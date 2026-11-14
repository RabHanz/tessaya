/** The Memory area of Baton's window (D146): one row per note, with Edit and Delete. */
import type { HomeControl } from "../home/tessayaHome.ts";
import type { MemoryNote } from "./memoryNotes.ts";

export const noteControls = (notes: ReadonlyArray<MemoryNote>): ReadonlyArray<HomeControl> =>
  notes.length === 0
    ? [
        {
          id: "m.empty",
          section: "Notes",
          label: "No notes yet",
          hint: 'Say "remember that..." and it appears here as a plain file.',
          kind: "check",
          status: "ok",
          detail: "Nothing is being kept.",
        },
        {
          id: "m.folder",
          section: "Notes",
          label: "Notes folder",
          hint: "Drop a text file in it and it counts as a note.",
          kind: "action",
          button: "Open folder",
        },
      ]
    : [
        ...notes.map((n): HomeControl => ({
          id: `m:${n.id}`,
          section: "Notes",
          label: n.text,
          kind: "action",
          button: "Edit",
          secondary: "Delete",
        })),
        {
          id: "m.folder",
          section: "Notes",
          label: "Notes folder",
          hint: "Plain files you can read and change.",
          kind: "action",
          button: "Open folder",
        },
      ];

/** `m:<id>` is Edit and `m:<id>:later` is Delete (the secondary button's id); other ids are not notes. */
export const noteAction = (
  id: string,
): { readonly id: string; readonly remove: boolean } | null => {
  const match = /^m:([a-z0-9-]+)(:later)?$/.exec(id);
  return match === null ? null : { id: match[1]!, remove: match[2] !== undefined };
};

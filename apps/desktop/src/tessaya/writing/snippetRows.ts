/** The Snippets area of the window: the list with add and remove, import and export. */
import { formatSnippet, parseSnippet, type Snippet } from "@t3tools/tessaya-shared/snippets";

import type { HomeControl } from "../home/tessayaHome.ts";

const SECTION = "Snippets";

export const snippetControls = (
  list: ReadonlyArray<Snippet>,
  note: string,
): ReadonlyArray<HomeControl> => [
  {
    id: "sn.list",
    section: SECTION,
    label: "Say a short cue and get the whole text",
    hint: 'Add one as cue = text. Say "my email address" while dictating and your email lands in the field. End with @slack,outlook to limit it to those apps; write \\n for a new line. Adding the same cue again replaces it.',
    kind: "list",
    items: list.map(formatSnippet),
    placeholder: "cue = the text it expands to",
    addLabel: "Add",
    lead: true,
  },
  {
    id: "sn.import",
    section: "Import and export",
    label: "Import snippets from a file",
    hint: "A JSON list, a CSV of cue,text, or one cue = text per line. Cues that already exist are replaced.",
    kind: "action",
    button: "Choose a file",
    secondary: "Export",
  },
  ...(note === ""
    ? []
    : [
        {
          id: "sn.note",
          section: "Import and export",
          label: note,
          kind: "check",
          status: "ok",
          detail: "",
        } as const,
      ]),
];

/** `sn.list:add` with text, `sn.list:rm` with the row, `sn.import`, `sn.import:later` for export. */
export const snippetAction = (id: string, value: string | boolean | null) => {
  if (id === "sn.list:add" && typeof value === "string") {
    const s = parseSnippet(value);
    return s === null ? ({ kind: "bad" } as const) : ({ kind: "put", snippet: s } as const);
  }
  if (id === "sn.list:rm" && typeof value === "string") {
    const s = parseSnippet(value);
    return s === null ? null : ({ kind: "remove", cue: s.cue } as const);
  }
  if (id === "sn.import") return { kind: "import" } as const;
  if (id === "sn.import:later") return { kind: "export" } as const;
  return null;
};

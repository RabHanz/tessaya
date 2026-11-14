/** The Backup area of the window: export, and a restore that shows what it would do before it does it. */
import type { HomeControl } from "../home/tessayaHome.ts";
import { text } from "../home/strings.ts";
import type { RestoreRow } from "./backup.ts";

export const backupControls = (
  preview: { readonly file: string; readonly rows: ReadonlyArray<RestoreRow> } | null,
  note: string | null,
): ReadonlyArray<HomeControl> => {
  const section = text("backup.section");
  const previewSection = text("backup.preview");
  return [
    {
      id: "bk.export",
      section,
      label: text("backup.export.label"),
      hint: text("backup.export.hint"),
      kind: "action",
      button: text("backup.export.button"),
    },
    {
      id: "bk.restore",
      section,
      label: text("backup.restore.label"),
      hint: text("backup.restore.hint"),
      kind: "action",
      button: text("backup.restore.button"),
    },
    ...(note === null
      ? []
      : [
          {
            id: "bk.note",
            section,
            label: note,
            kind: "check" as const,
            status: "ok" as const,
            detail: "",
          },
        ]),
    ...(preview === null
      ? []
      : [
          ...preview.rows.map((r, i): HomeControl => ({
            id: `bk.row:${i}`,
            section: previewSection,
            label: r.from === undefined ? r.name : `${r.from} → ${r.name}`,
            kind: "check",
            status: r.action === "refused" ? "warn" : "ok",
            detail: text(`backup.${r.action}`),
          })),
          {
            id: "bk.apply",
            section: previewSection,
            label: text("backup.apply.label", {
              n: preview.rows.filter((r) => r.action === "new" || r.action === "replaces").length,
              file: preview.file,
            }),
            kind: "action" as const,
            button: text("backup.apply.button"),
            secondary: text("backup.apply.cancel"),
          },
        ]),
  ];
};

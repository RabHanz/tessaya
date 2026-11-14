/** Bulk dictionary import and export (Wispr parity): JSON, CSV or one word per line, up to 3 MB and 1,000 words, 60 characters each. Pure. */
export interface DictionaryRow {
  readonly phrase: string;
  /** How it should be written, when that differs from how it is heard. */
  readonly replacement: string | null;
}

export const IMPORT_MAX_BYTES = 3 * 1024 * 1024;
export const IMPORT_MAX_ROWS = 1_000;
export const PHRASE_MAX = 60;

const row = (phrase: unknown, replacement: unknown): DictionaryRow | null => {
  if (typeof phrase !== "string") return null;
  const p = phrase.replace(/\s+/g, " ").trim();
  if (p === "" || p.length > PHRASE_MAX) return null;
  const r = typeof replacement === "string" ? replacement.replace(/\s+/g, " ").trim() : "";
  if (r.length > PHRASE_MAX * 2) return null;
  return { phrase: p, replacement: r === "" || r === p ? null : r };
};

const splitCsv = (line: string): string[] => {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') ((cur += '"'), (i += 1));
      else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") (out.push(cur), (cur = ""));
    else cur += c;
  }
  out.push(cur);
  return out;
};

export interface ImportResult {
  readonly rows: ReadonlyArray<DictionaryRow>;
  readonly skipped: number;
  /** Set when the whole file was refused. */
  readonly refused?: string;
}

/** JSON (a list of words or of {phrase, replacement}), CSV (`heard,written`), or lines (`heard`, `heard -> written`). */
export const importDictionary = (raw: string): ImportResult => {
  if (raw.length > IMPORT_MAX_BYTES) {
    return { rows: [], skipped: 0, refused: "That file is over 3 MB." };
  }
  const text = raw.replace(/^﻿/, "").trim();
  const rows: DictionaryRow[] = [];
  let skipped = 0;
  const take = (r: DictionaryRow | null) => (r === null ? (skipped += 1) : rows.push(r));
  if (text.startsWith("[") || text.startsWith("{")) {
    try {
      const data = JSON.parse(text) as unknown;
      const list = Array.isArray(data)
        ? data
        : ((data as { words?: unknown; entries?: unknown }).words ??
          (data as { entries?: unknown }).entries);
      if (!Array.isArray(list))
        return { rows: [], skipped: 0, refused: "That JSON is not a list of words." };
      for (const item of list as unknown[]) {
        if (typeof item === "string") take(row(item, ""));
        else {
          const o = (item ?? {}) as Record<string, unknown>;
          take(
            row(
              o["phrase"] ?? o["word"] ?? o["heard"],
              o["replacement"] ?? o["written"] ?? o["to"],
            ),
          );
        }
      }
    } catch {
      return { rows: [], skipped: 0, refused: "That file is not valid JSON." };
    }
  } else {
    for (const line of text.split(/\r?\n/)) {
      if (line.trim() === "") continue;
      const arrow = /^(.*?)\s*(?:->|=>|=)\s*(.+)$/.exec(line);
      if (arrow !== null) take(row(arrow[1], arrow[2]));
      else if (line.includes(",")) {
        const [a, b] = splitCsv(line);
        take(row(a, b));
      } else take(row(line, ""));
    }
  }
  if (rows.length > IMPORT_MAX_ROWS) {
    return {
      rows: rows.slice(0, IMPORT_MAX_ROWS),
      skipped: skipped + rows.length - IMPORT_MAX_ROWS,
    };
  }
  return { rows, skipped };
};

export const exportDictionaryCsv = (list: ReadonlyArray<DictionaryRow>): string =>
  `heard,written\n${list
    .map((r) =>
      [r.phrase, r.replacement ?? ""]
        .map((v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v))
        .join(","),
    )
    .join("\n")}\n`;

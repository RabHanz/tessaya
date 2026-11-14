/**
 * Snippets (Wispr parity): a spoken cue expands to saved text, such as an email address, a link or
 * a prompt. Pure: parsing and printing the one-line form, import and export, and the expansion
 * itself. A cue can be limited to some apps. Nothing here reads a file.
 */
export interface Snippet {
  /** What he says, in lower case. */
  readonly cue: string;
  /** What lands in the field. `\n` in the one-line form is a line break. */
  readonly text: string;
  /** App names (exe without .exe, lower case); empty means every app. */
  readonly apps: ReadonlyArray<string>;
}

export const SNIPPET_CUE_MAX = 60;
export const SNIPPET_TEXT_MAX = 4_000;
export const SNIPPETS_MAX = 500;

const clean = (s: string): string => s.replace(/\s+/g, " ").trim();
const appName = (a: string): string =>
  a
    .trim()
    .toLowerCase()
    .replace(/\.(exe|app)$/, "");

/** `cue = text`, or `cue = text @slack,outlook` to limit it to those apps. Null when it is not one. */
export const parseSnippet = (line: string): Snippet | null => {
  const eq = line.indexOf("=");
  if (eq < 0) return null;
  let body = line.slice(eq + 1).trim();
  let apps: string[] = [];
  const at = /\s@([A-Za-z0-9_.,\- ]+)$/.exec(body);
  if (at !== null) {
    apps = at[1]!
      .split(",")
      .map(appName)
      .filter((a) => a !== "");
    body = body.slice(0, at.index).trim();
  }
  const cue = clean(line.slice(0, eq)).toLowerCase();
  const text = body.replace(/\\n/g, "\n");
  if (cue === "" || cue.length > SNIPPET_CUE_MAX || !/[a-z0-9]/i.test(cue)) return null;
  if (text.trim() === "" || text.length > SNIPPET_TEXT_MAX) return null;
  return { cue, text, apps };
};

/** The one-line form, which is also the list row. */
export const formatSnippet = (s: Snippet): string =>
  `${s.cue} = ${s.text.replace(/\n/g, "\\n")}${s.apps.length > 0 ? ` @${s.apps.join(",")}` : ""}`;

/** Adds or replaces by cue. Null when the list is full. */
export const putSnippet = (
  list: ReadonlyArray<Snippet>,
  s: Snippet,
): ReadonlyArray<Snippet> | null => {
  const rest = list.filter((x) => x.cue !== s.cue);
  return rest.length >= SNIPPETS_MAX
    ? null
    : [...rest, s].toSorted((a, b) => a.cue.localeCompare(b.cue));
};

/** From a file: JSON (a list, or `{snippets}`), CSV (`cue,text`), or one `cue = text` per line. */
export const importSnippets = (
  raw: string,
): { readonly snippets: ReadonlyArray<Snippet>; readonly skipped: number } => {
  const out: Snippet[] = [];
  let skipped = 0;
  const take = (cue: unknown, text: unknown, apps: unknown) => {
    const s = parseSnippet(
      `${String(cue ?? "")} = ${String(text ?? "").replace(/\n/g, "\\n")}${
        Array.isArray(apps) && apps.length > 0 ? ` @${apps.join(",")}` : ""
      }`,
    );
    if (s === null) skipped += 1;
    else out.push(s);
  };
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") || trimmed.startsWith("{")) {
    try {
      const data = JSON.parse(trimmed) as unknown;
      const list = Array.isArray(data) ? data : (data as { snippets?: unknown }).snippets;
      if (Array.isArray(list)) {
        for (const o of list as Array<Record<string, unknown>>) {
          take(o?.["cue"] ?? o?.["trigger"], o?.["text"] ?? o?.["expansion"], o?.["apps"]);
        }
        return { snippets: dedupe(out), skipped };
      }
    } catch {
      return { snippets: [], skipped: 1 };
    }
  }
  for (const line of trimmed.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    if (line.includes("=")) {
      const s = parseSnippet(line);
      if (s === null) skipped += 1;
      else out.push(s);
      continue;
    }
    const comma = line.indexOf(",");
    if (comma > 0)
      take(
        line.slice(0, comma).replace(/^"|"$/g, ""),
        line.slice(comma + 1).replace(/^"|"$/g, ""),
        [],
      );
    else skipped += 1;
  }
  return { snippets: dedupe(out), skipped };
};

const dedupe = (list: ReadonlyArray<Snippet>): ReadonlyArray<Snippet> =>
  [...new Map(list.map((s) => [s.cue, s])).values()].slice(0, SNIPPETS_MAX);

export const exportSnippets = (list: ReadonlyArray<Snippet>): string =>
  JSON.stringify(
    list.map((s) => ({ cue: s.cue, text: s.text, ...(s.apps.length > 0 ? { apps: s.apps } : {}) })),
    null,
    2,
  );

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Replaces each cue with its text. A cue that is the whole utterance (a closing full stop aside)
 * gives the text exactly; inside a sentence it is replaced in place. Longest cues go first, and a
 * replaced text is never searched again.
 */
export const expandSnippets = (
  text: string,
  snippets: ReadonlyArray<Snippet>,
  exe: string,
): string => {
  const app = appName(exe);
  const usable = snippets
    .filter((s) => s.apps.length === 0 || s.apps.includes(app))
    .toSorted((a, b) => b.cue.length - a.cue.length);
  if (usable.length === 0) return text;
  const whole = clean(text)
    .replace(/[.!?,;:]+$/, "")
    .toLowerCase();
  const exact = usable.find((s) => s.cue === whole);
  if (exact !== undefined) return exact.text;
  const parts: Array<{ literal: boolean; value: string }> = [{ literal: false, value: text }];
  for (const s of usable) {
    const re = new RegExp(
      `(?<![A-Za-z0-9])${escapeRe(s.cue).replace(/ /g, "\\s+")}(?![A-Za-z0-9])`,
      "gi",
    );
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]!;
      if (part.literal || !re.test(part.value)) continue;
      re.lastIndex = 0;
      const pieces: typeof parts = [];
      let last = 0;
      for (const m of part.value.matchAll(re)) {
        pieces.push({ literal: false, value: part.value.slice(last, m.index) });
        pieces.push({ literal: true, value: s.text });
        last = m.index! + m[0].length;
      }
      pieces.push({ literal: false, value: part.value.slice(last) });
      parts.splice(i, 1, ...pieces);
      i += pieces.length - 1;
    }
  }
  return parts.map((p) => p.value).join("");
};

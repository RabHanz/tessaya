/**
 * Tessaya's Help: the features and lessons written in docs/user (tessaya-features.md, tessaya-lessons.md), parsed for
 * every surface and for her own answers (`tessaya_help`). docsBundle.data.ts carries the markdown into each build.
 */
import { DOCS_FEATURES_MD, DOCS_LESSONS_MD } from "./docsBundle.data.ts";

export type DocStatus = "live" | "beta" | "coming";
export type DocArea = "start" | "talk" | "know" | "today" | "agents" | "devices";
export type DocSurface = "desktop" | "web" | "phone" | "tessel" | "voice";
export type DocAudience = "new" | "maker" | "home" | "builder";

export interface DocFeature {
  readonly id: string;
  readonly title: string;
  /** What he wants to do, in his words: "insert text I type often". */
  readonly task: string;
  readonly status: DocStatus;
  readonly area: DocArea;
  /** The page or Settings place "Show me in Tessaya" opens (tessayaTargetOf). */
  readonly place: string;
  readonly on: ReadonlyArray<DocSurface>;
  readonly audience: DocAudience;
  /** The longer guide in docs/user, as `file.md#anchor`. */
  readonly guide: string | null;
  readonly lead: string;
  readonly say: ReadonlyArray<string>;
  readonly steps: ReadonlyArray<string>;
  readonly good: string | null;
}

export interface DocLessonStep {
  readonly title: string;
  readonly text: string;
  readonly say: string;
  readonly feature: string;
}

export interface DocLesson {
  readonly id: string;
  readonly title: string;
  readonly audience: DocAudience;
  readonly minutes: number;
  readonly blurb: string;
  readonly steps: ReadonlyArray<DocLessonStep>;
}

export const DOC_AREAS: ReadonlyArray<{ readonly id: DocArea; readonly label: string }> = [
  { id: "start", label: "Getting started" },
  { id: "talk", label: "Talking and dictating" },
  { id: "know", label: "What she knows" },
  { id: "today", label: "Today and jobs" },
  { id: "agents", label: "Working for you" },
  { id: "devices", label: "Devices and home" },
];

export const DOC_SURFACES: ReadonlyArray<{ readonly id: DocSurface; readonly label: string }> = [
  { id: "desktop", label: "Desktop" },
  { id: "web", label: "Web" },
  { id: "phone", label: "Phone" },
  { id: "tessel", label: "Tessel" },
  { id: "voice", label: "By voice" },
];

export const DOC_AUDIENCES: ReadonlyArray<{ readonly id: DocAudience; readonly label: string }> = [
  { id: "new", label: "New to Tessaya" },
  { id: "maker", label: "Making her yours" },
  { id: "home", label: "At home with others" },
  { id: "builder", label: "Working with agents" },
];

const meta = (line: string): Record<string, string> | null => {
  const m = /^<!--(.*)-->$/.exec(line.trim());
  if (m === null) return null;
  const out: Record<string, string> = {};
  for (const part of (m[1] ?? "").split("|")) {
    const at = part.indexOf(":");
    if (at > 0) out[part.slice(0, at).trim()] = part.slice(at + 1).trim();
  }
  return out;
};

const sections = (md: string) =>
  md
    .split(/^## /m)
    .slice(1)
    .map((chunk) => {
      const lines = chunk.split("\n");
      return { title: (lines[0] ?? "").trim(), lines: lines.slice(1) };
    });

const quoted = (text: string): ReadonlyArray<string> =>
  [...text.matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "").filter((s) => s.length > 0);

const oneOf = <T extends string>(value: string | undefined, all: ReadonlyArray<{ id: T }>): T => {
  const hit = all.find((a) => a.id === value);
  if (hit === undefined) throw new Error(`Help docs: unknown value "${value ?? ""}"`);
  return hit.id;
};

/** Sections without the metadata comment (the page's own intro, "Use Help") are not features. */
export function parseFeatures(md: string): ReadonlyArray<DocFeature> {
  return sections(md).flatMap((s): ReadonlyArray<DocFeature> => {
    const at = s.lines.findIndex((l) => meta(l) !== null);
    const m = at < 0 ? null : meta(s.lines[at] ?? "");
    if (m === null || m["id"] === undefined) return [];
    const body = s.lines.slice(at + 1).map((l) => l.trim());
    const status = m["status"];
    if (status !== "live" && status !== "beta" && status !== "coming")
      throw new Error(`Help docs: ${m["id"]} has no status`);
    const sayLine = body.find((l) => l.startsWith("Try saying:"));
    const goodLine = body.find((l) => l.startsWith("Good to know:"));
    return [
      {
        id: m["id"],
        title: s.title,
        task: m["task"] ?? "",
        status,
        area: oneOf(m["area"], DOC_AREAS),
        place: m["place"] ?? "help",
        on: (m["on"] ?? "").split(",").map((x) => oneOf(x.trim(), DOC_SURFACES)),
        audience: oneOf(m["for"], DOC_AUDIENCES),
        guide: m["guide"] ?? null,
        lead: body.find((l) => l.length > 0) ?? "",
        say: sayLine === undefined ? [] : quoted(sayLine),
        steps: body.filter((l) => /^\d+\. /.test(l)).map((l) => l.replace(/^\d+\. /, "")),
        good: goodLine === undefined ? null : goodLine.replace(/^Good to know:\s*/, ""),
      },
    ];
  });
}

export function parseLessons(md: string): ReadonlyArray<DocLesson> {
  return sections(md).flatMap((s): ReadonlyArray<DocLesson> => {
    const m = s.lines.map(meta).find((x) => x !== null);
    if (m === undefined || m === null || m["id"] === undefined) return [];
    const body = s.lines.map((l) => l.trim()).filter((l) => l.length > 0 && meta(l) === null);
    const steps = body
      .filter((l) => /^\d+\. /.test(l))
      .map((l): DocLessonStep => {
        const step = /^\d+\. \*\*(.+?)\*\*\s*(.*?)\s*Say "(.+)"\s*<!--\s*([\w-]+)\s*-->$/.exec(l);
        if (step === null)
          throw new Error(`Help docs: lesson ${m["id"]} has a step it cannot read`);
        return {
          title: (step[1] ?? "").replace(/\.$/, ""),
          text: step[2] ?? "",
          say: step[3] ?? "",
          feature: step[4] ?? "",
        };
      });
    return [
      {
        id: m["id"],
        title: s.title,
        audience: oneOf(m["for"], DOC_AUDIENCES),
        minutes: Number(m["minutes"] ?? 5),
        blurb: body.find((l) => !/^\d+\. /.test(l)) ?? "",
        steps,
      },
    ];
  });
}

export const DOC_FEATURES: ReadonlyArray<DocFeature> = parseFeatures(DOCS_FEATURES_MD);
export const DOC_LESSONS: ReadonlyArray<DocLesson> = parseLessons(DOCS_LESSONS_MD);

const STOP = new Set(
  "a an and are can do does for from get have her how i in is it me my of on or she should the to what when where which who why will with you your tessaya".split(
    " ",
  ),
);
const words = (text: string): ReadonlyArray<string> =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP.has(w))
    .map((w) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w));

/** Features for his words, best first; a title or phrase match outranks one in the steps. */
export function searchDocs(
  features: ReadonlyArray<DocFeature>,
  query: string,
): ReadonlyArray<DocFeature> {
  const asked = words(query);
  if (asked.length === 0) return [];
  const score = (f: DocFeature) => {
    const field = (text: string, weight: number) => {
      const have = new Set(words(text));
      return asked.filter((w) => have.has(w)).length * weight;
    };
    return (
      field(`${f.title} ${f.task}`, 4) +
      field(f.say.join(" "), 3) +
      field(f.lead, 2) +
      field(`${f.steps.join(" ")} ${f.good ?? ""}`, 1)
    );
  };
  return features
    .map((f) => ({ f, s: score(f) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s)
    .map((x) => x.f);
}

const STATUS_WORD: Record<DocStatus, string> = {
  live: "Live",
  beta: "Beta, still changing",
  coming: "Coming, not here yet",
};

/** What `tessaya_help` gives her brain: the few sections that match, in the docs' own words. */
export function helpAnswer(query: string, limit = 3): string {
  const found = searchDocs(DOC_FEATURES, query).slice(0, limit);
  if (found.length === 0)
    return "Nothing in Tessaya's help covers that. Say so plainly; do not guess how she works.";
  return found
    .map((f) =>
      [
        `## ${f.title} (${STATUS_WORD[f.status]}; page: ${f.place})`,
        f.lead,
        f.say.length === 0 ? "" : `Try saying: ${f.say.map((s) => `"${s}"`).join(", ")}`,
        ...f.steps.map((s, n) => `${n + 1}. ${s}`),
        f.good === null ? "" : `Good to know: ${f.good}`,
      ]
        .filter((l) => l.length > 0)
        .join("\n"),
    )
    .join("\n\n");
}

/**
 * Which steps of a lesson are done: a step is done once its feature's page has been used (LearnProgress.used, shared
 * by every device). shortcut: opening the page counts, not the step working; upgrade when steps name a proving event.
 */
export function lessonDone(lesson: DocLesson, used: ReadonlyArray<string>): ReadonlyArray<boolean> {
  return lesson.steps.map((step) => {
    const place = DOC_FEATURES.find((f) => f.id === step.feature)?.place;
    return place !== undefined && used.includes(place);
  });
}

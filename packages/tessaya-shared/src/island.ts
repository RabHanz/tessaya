/**
 * The island (M-126): one status for every phone and the desk, the most urgent thing first. Her own state while she
 * listens, thinks or speaks; then a job that needs him; then a running timer; then the next thing coming up within
 * the hour; then jobs still working. Closed, only the first shows; opened, all of them, in this order. Each item says
 * where a tap takes him (an app path), so every surface opens the same screen.
 */

export type HerPhase = "idle" | "listening" | "thinking" | "speaking";

export interface IslandFeed {
  readonly her: HerPhase;
  /** Her agents' jobs: how many wait on him and how many work, and the first that waits. */
  readonly jobs: {
    readonly needYou: number;
    readonly working: number;
    readonly first: { readonly title: string; readonly href: string } | null;
  };
  /** House timers and the rest of Coming up (the commitment service behind it). */
  readonly timers: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly endsAt: number;
  }>;
  readonly upcoming: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly at: number;
  }>;
}

export type IslandItem = {
  readonly key: string;
  readonly kind: "her" | "needsYou" | "timer" | "upcoming" | "working";
  readonly label: string;
  readonly detail: string;
  /** The app path a tap opens, or null where there is nothing more to see (her state). */
  readonly href: string | null;
  /** A timer's end, so a surface can count down in its own clock. */
  readonly endsAt?: number;
};

/** Coming up shows on the island only within this long of its time. */
export const ISLAND_UPCOMING_MS = 60 * 60_000;
export const UPCOMING_HREF = "/settings/upcoming";
export const WORK_HREF = "/";

const clock = (at: number) => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export const islandItems = (feed: IslandFeed, now: number): ReadonlyArray<IslandItem> => {
  const items: Array<IslandItem> = [];
  if (feed.her !== "idle")
    items.push({ key: "her", kind: "her", label: feed.her, detail: "", href: null });
  if (feed.jobs.needYou > 0)
    items.push({
      key: "needsYou",
      kind: "needsYou",
      label:
        feed.jobs.needYou === 1 && feed.jobs.first !== null
          ? `${feed.jobs.first.title} needs you`
          : `${feed.jobs.needYou} need you`,
      detail: feed.jobs.working > 0 ? `${feed.jobs.working} more working` : "",
      href: feed.jobs.first?.href ?? WORK_HREF,
    });
  for (const t of [...feed.timers].sort((a, b) => a.endsAt - b.endsAt))
    if (t.endsAt > now)
      items.push({
        key: `timer:${t.id}`,
        kind: "timer",
        label: t.title,
        detail: `until ${clock(t.endsAt)}`,
        href: UPCOMING_HREF,
        endsAt: t.endsAt,
      });
  const next = [...feed.upcoming]
    .filter((u) => u.at > now && u.at - now <= ISLAND_UPCOMING_MS)
    .sort((a, b) => a.at - b.at)[0];
  if (next !== undefined)
    items.push({
      key: `upcoming:${next.id}`,
      kind: "upcoming",
      label: `${next.title} ${clock(next.at)}`,
      detail: "Coming up",
      href: UPCOMING_HREF,
    });
  if (feed.jobs.needYou === 0 && feed.jobs.working > 0)
    items.push({
      key: "working",
      kind: "working",
      label: `${feed.jobs.working} working`,
      detail: "",
      href: WORK_HREF,
    });
  return items;
};

/** What the lock screen and the notification shade carry: everything but her own moment-to-moment state. */
export const systemIslandItems = (items: ReadonlyArray<IslandItem>) =>
  items.filter((i) => i.kind !== "her");

/** Coming up's items as the island's timers (a house timer, once) and the rest with a time. */
export const fromUpcoming = (
  items: ReadonlyArray<{
    readonly id: string;
    readonly source: string;
    readonly title: string;
    readonly line: string;
    readonly at: number | null;
    readonly repeats: string | null;
    readonly paused: boolean;
  }>,
): Pick<IslandFeed, "timers" | "upcoming"> => {
  const timed = items.filter((i) => i.at !== null && !i.paused);
  const isTimer = (i: (typeof timed)[number]) =>
    i.source === "house" && i.repeats === null && /\btimer\b/i.test(`${i.title} ${i.line}`);
  return {
    timers: timed.filter(isTimer).map((i) => ({ id: i.id, title: i.title, endsAt: i.at! })),
    upcoming: timed
      .filter((i) => !isTimer(i))
      .map((i) => ({ id: i.id, title: i.title, at: i.at! })),
  };
};

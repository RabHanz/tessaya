/**
 * Learning Tessaya: every tip she can show, and the one rule that picks the next. Shared by every surface (`@t3tools/baton-shared/learn`); each keeps
 * its own `LearnProgress` (the desktop window keeps it on this computer) and asks `pickTip` what to show.
 */
export interface LearnItem {
  readonly id: string;
  /** The sidebar area it belongs to, for the checklist and for "this is the area you are in". */
  readonly area: "today" | "talk" | "know" | "devices" | "agents";
  /** The page or Settings place it teaches; opening it counts as having used it. */
  readonly place: string;
  readonly title: string;
  readonly body: string;
  readonly action: string;
  /** Days of use before it may show; 0 shows from the first day. */
  readonly afterDays: number;
}

export const LEARN_ITEMS: ReadonlyArray<LearnItem> = [
  {
    id: "stop",
    area: "today",
    place: "help",
    title: "Escape stops her",
    body: "Press Escape, or say “stop”, and she goes quiet. The tray icon quits her.",
    action: "See what you can say",
    afterDays: 0,
  },
  {
    id: "privacy",
    area: "know",
    place: "privacy",
    title: "What she keeps, and for how long",
    body: "Recordings, what she notices on screen, and how long each is kept. All on this computer.",
    action: "Review privacy",
    afterDays: 1,
  },
  {
    id: "wake",
    area: "talk",
    place: "voice",
    title: "Call her by name, hands-free",
    body: "Pick a wake word and the voice she answers in.",
    action: "Choose",
    afterDays: 1,
  },
  {
    id: "style",
    area: "talk",
    place: "style",
    title: "Make dictation sound like you",
    body: "How formal she writes in each kind of app, and how much she tidies.",
    action: "Set your style",
    afterDays: 1,
  },
  {
    id: "snippets",
    area: "talk",
    place: "snippets",
    title: "Say “my address” and the whole thing lands",
    body: "Short cues for text you type often: an email, a link, a prompt.",
    action: "Make one",
    afterDays: 2,
  },
  {
    id: "approvals",
    area: "today",
    place: "approvals",
    title: "Nothing runs without your yes",
    body: "Everything waiting for you is here, with what it would do.",
    action: "Open Approvals",
    afterDays: 2,
  },
  {
    id: "memory",
    area: "know",
    place: "memory",
    title: "She remembers what matters to you",
    body: "Say “remember that…”, then search, correct or forget it here.",
    action: "Open Memory",
    afterDays: 3,
  },
  {
    id: "hands",
    area: "agents",
    place: "assistant",
    title: "Let her look at your screen",
    body: "She can answer about what you see, show you each step, or do it while you watch.",
    action: "Choose what she may do",
    afterDays: 3,
  },
  {
    id: "transforms",
    area: "talk",
    place: "transforms",
    title: "Rewrite any selected text",
    body: "Polish, shorten or translate what you have selected, by shortcut or by voice.",
    action: "Try a transform",
    afterDays: 4,
  },
  {
    id: "hardware",
    area: "devices",
    place: "hardware",
    title: "Your R1 can be her body in the room",
    body: "Set it up and she answers on it with her own voice and memory.",
    action: "Set up an R1",
    afterDays: 4,
  },
  {
    id: "scratchpad",
    area: "talk",
    place: "scratchpad",
    title: "Speak a note, find it later",
    body: "Quick notes you speak or type, searchable, kept on this computer.",
    action: "Open Scratchpad",
    afterDays: 5,
  },
  {
    id: "vault",
    area: "know",
    place: "vault",
    title: "Passwords she can use without seeing",
    body: "Keys and private notes, encrypted here; every use is logged.",
    action: "Open Vault",
    afterDays: 5,
  },
  {
    id: "homeassistant",
    area: "devices",
    place: "homeassistant",
    title: "Lights and rooms by voice",
    body: "Connect Home Assistant and ask her to turn things on in a room.",
    action: "Connect",
    afterDays: 6,
  },
  {
    id: "phone",
    area: "devices",
    place: "phone",
    title: "Take her with you",
    body: "The phone app reaches this computer: dictation and live sessions away from the desk.",
    action: "Pair a phone",
    afterDays: 7,
  },
  {
    id: "cloud",
    area: "agents",
    place: "cloud",
    title: "Hand big jobs to a cloud computer",
    body: "Keep working here while a cloud machine does the heavy lifting.",
    action: "Open Cloud",
    afterDays: 8,
  },
  {
    id: "insights",
    area: "talk",
    place: "insights",
    title: "See how much you dictate",
    body: "Speed, words and what she fixed, compared only with your own past.",
    action: "Open Insights",
    afterDays: 10,
  },
];

/** Shown once in Learn Tessaya after the update that brings them; `since` orders them. */
export const WHATS_NEW: ReadonlyArray<{
  readonly since: string;
  readonly title: string;
  readonly place: string;
}> = [
  {
    since: "2026-11-12",
    title: "Settings has a new home: five areas in the sidebar, one Settings for everything",
    place: "general",
  },
  {
    since: "2026-11-12",
    title: "Hardware and Home Assistant are under Devices",
    place: "hardware",
  },
];

export type TipMode = "daily" | "all" | "off";

export interface LearnProgress {
  /** Places opened: a tip about one is done. */
  readonly used: ReadonlyArray<string>;
  /** Times each tip was shown. */
  readonly seen: Readonly<Record<string, number>>;
  readonly dismissed: ReadonlyArray<string>;
  /** Days with any use, as YYYY-MM-DD. */
  readonly days: ReadonlyArray<string>;
  readonly lastTipAt: number | null;
  readonly mode: TipMode;
  /** The newest What's new he has seen. */
  readonly whatsNewSeen: string | null;
}

export const EMPTY_PROGRESS: LearnProgress = {
  used: [],
  seen: {},
  dismissed: [],
  days: [],
  lastTipAt: null,
  mode: "daily",
  whatsNewSeen: null,
};

/**
 * The tip to show now, or null. At most one a day ("daily"); never one he has used, dismissed or seen twice; only
 * one about the page or area he is in. Self-contained (no imports, no helpers): the desktop window runs its source.
 */
export function pickTip(
  items: ReadonlyArray<LearnItem>,
  progress: LearnProgress,
  where: { readonly page: string; readonly area: string | null },
  now: number,
): LearnItem | null {
  if (progress.mode === "off") return null;
  if (
    progress.mode === "daily" &&
    progress.lastTipAt !== null &&
    now - progress.lastTipAt < 20 * 3600 * 1000
  )
    return null;
  const open = items.filter(
    (item) =>
      !progress.used.includes(item.place) &&
      !progress.dismissed.includes(item.id) &&
      (progress.seen[item.id] ?? 0) < 2 &&
      (progress.mode === "all" || item.afterDays <= Math.max(0, progress.days.length - 1)),
  );
  return (
    open.find((item) => item.place === where.page) ??
    open.find((item) => item.area === where.area) ??
    null
  );
}

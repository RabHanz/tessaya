/**
 * Her estate on a phone Sleeve (M-158, REQ-25-166): where her character may stand on the screen and how big she may
 * be. Pure, so the stage page and its tests agree: she stays whole on screen and above the app's bottom panel.
 */
export interface Spot {
  /** Her centre, in CSS px. */
  readonly x: number;
  readonly y: number;
  readonly scale: number;
}
export interface StageBox {
  readonly w: number;
  readonly h: number;
  /** The app's panel over the bottom of the screen, in CSS px. */
  readonly bottom: number;
  /** Turned on its side (the dock), the panel is on the right instead, in CSS px. */
  readonly right?: number;
}

export const STAGE_SCALE = { min: 0.55, max: 1.7 } as const;

const within = (v: number, lo: number, hi: number) =>
  lo > hi ? (lo + hi) / 2 : Math.min(hi, Math.max(lo, v));

/** The nearest spot where all of her shows: her drawing is `size` square before her scale. */
export const clampSpot = (s: Spot, size: number, box: StageBox): Spot => {
  const scale = within(s.scale, STAGE_SCALE.min, STAGE_SCALE.max);
  const half = (size * scale) / 2;
  return {
    scale,
    x: within(s.x, half, box.w - (box.right ?? 0) - half),
    y: within(s.y, half, box.h - box.bottom - half),
  };
};

/** Two fingers apart on her: her size follows the change in their distance. */
export const pinchScale = (from: number, fromApart: number, apart: number): number =>
  fromApart <= 0 ? from : within((from * apart) / fromApart, STAGE_SCALE.min, STAGE_SCALE.max);

/** Somewhere else on her screen for a quiet walk: a short stroll, not across the whole screen. */
export const wanderSpot = (s: Spot, size: number, box: StageBox, random: () => number): Spot => {
  const reach = Math.min(box.w, box.h) * 0.35;
  const angle = random() * Math.PI * 2;
  return clampSpot(
    { ...s, x: s.x + Math.cos(angle) * reach, y: s.y + Math.sin(angle) * reach * 0.5 },
    size,
    box,
  );
};

/** CSS px in a centimetre on a phone (about 160 points to the inch). */
export const PX_PER_CM = 63;
/** A fingertip's contact, for a screen that reports no contact size. */
const FINGERTIP_CM2 = 1.2;

/**
 * What a touchscreen tells of his finger on her skin: the contact area (its reported ellipse, in cm²) and its force
 * where the screen measures one (null: no force sensor, as on most phones, and her nerves take their default).
 */
export const fingerSkin = (
  widthPx: number,
  heightPx: number,
  pressure: number,
): { readonly areaCm2: number; readonly pressure: number | null } => {
  const area =
    widthPx > 1 && heightPx > 1
      ? (Math.PI / 4) * (widthPx / PX_PER_CM) * (heightPx / PX_PER_CM)
      : 0;
  return {
    areaCm2: Math.round(Math.min(400, Math.max(area, FINGERTIP_CM2)) * 100) / 100,
    // browsers report 0.5 for a touch with no force sensor, and 0 once it lifts
    pressure: pressure > 0 && pressure !== 0.5 ? Math.min(1, pressure) : null,
  };
};

/**
 * What she can call up on her estate and hold (REQ-25-167): each from the service that owns it. A timer and today come
 * live from Coming up; a note, the weather, music or a call are what her tools just read, in her words.
 */
export const STAGE_KINDS = ["timer", "today", "note", "weather", "music", "call"] as const;
export type StageKind = (typeof STAGE_KINDS)[number];
export interface StageAsk {
  readonly kind: StageKind | "clear";
  readonly text: string;
}
/** A card beside her, and what she holds or does with it (props.js ids, rig.js clips). */
export interface StageCard {
  readonly kind: StageKind;
  readonly title: string;
  readonly lines: ReadonlyArray<string>;
  /** A timer counts down to this (epoch ms) on the card itself. */
  readonly endsAt: number | null;
  readonly prop: string | null;
  readonly gesture: string | null;
}
/** What Coming up says now (island fromUpcoming): his timers, and the rest of his timed items. */
export interface StageFeed {
  readonly timers: ReadonlyArray<{ readonly title: string; readonly endsAt: number }>;
  readonly upcoming: ReadonlyArray<{ readonly title: string; readonly at: number }>;
}

/** Her brain's ask, as the `phone.stage` item takes it: "timer", "today", "note: buy milk", "clear". */
export const readStageAsk = (value: string): StageAsk | null => {
  const at = value.indexOf(":");
  const kind = (at < 0 ? value : value.slice(0, at)).trim().toLowerCase();
  const text =
    at < 0
      ? ""
      : value
          .slice(at + 1)
          .trim()
          .slice(0, 240);
  if (/^(clear|off|none|away|put away)$/.test(kind)) return { kind: "clear", text: "" };
  return (STAGE_KINDS as ReadonlyArray<string>).includes(kind)
    ? { kind: kind as StageKind, text }
    : null;
};

const PROPS: Record<Exclude<StageKind, "weather">, string> = {
  timer: "stopwatch",
  today: "clipboard",
  note: "pencil",
  music: "headphones",
  call: "phone",
};
const weatherProp = (text: string) =>
  /\b(rain|shower|drizzl|storm|snow|sleet|wet)/i.test(text)
    ? "umbrella"
    : /\b(sun|clear|bright|hot)/i.test(text)
      ? "sunglasses"
      : null;

/** Where and when the phone is: now, the end of his today (epoch ms), today's name and a time read in his own zone. */
export interface StageHere {
  readonly now: number;
  readonly dayEnd: number;
  readonly day: string;
  readonly clock: (at: number) => string;
}

/** The card for an ask, or why it cannot show (for her brain to word). */
export const stageCard = (
  ask: StageAsk & { readonly kind: StageKind },
  feed: StageFeed,
  { now, dayEnd, day, clock }: StageHere,
): StageCard | string => {
  const base = { kind: ask.kind, endsAt: null, gesture: null };
  switch (ask.kind) {
    case "timer": {
      const running = feed.timers
        .filter((t) => t.endsAt > now)
        .toSorted((a, b) => a.endsAt - b.endsAt);
      const named = running.find(
        (t) => ask.text !== "" && t.title.toLowerCase().includes(ask.text.toLowerCase()),
      );
      const timer = named ?? running[0];
      if (timer === undefined) return "No timer is running: set one first.";
      return { ...base, title: timer.title, lines: [], endsAt: timer.endsAt, prop: PROPS.timer };
    }
    case "today": {
      const items = feed.upcoming.filter((i) => i.at >= now && i.at < dayEnd).slice(0, 5);
      return {
        ...base,
        title: day,
        lines: items.map((i) => `${clock(i.at)}  ${i.title}`),
        prop: PROPS.today,
      };
    }
    case "weather":
      if (ask.text === "") return "Say what the weather is, from your search.";
      return {
        ...base,
        title: "",
        lines: [ask.text],
        prop: weatherProp(ask.text),
        gesture: "pointAt",
      };
    default:
      if (ask.text === "") return `Say what the ${ask.kind} is.`;
      return { ...base, title: "", lines: [ask.text], prop: PROPS[ask.kind] };
  }
};

/** A timer's time left as the card reads it: "4:05", or "1:02:00" past an hour. */
export const timerLeft = (endsAt: number, now: number): string => {
  const s = Math.max(0, Math.ceil((endsAt - now) / 1000));
  const two = (n: number) => String(n).padStart(2, "0");
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h > 0 ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
};

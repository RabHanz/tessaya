/**
 * Comms rules every side shares (tessaya-ops research/COMMS-DESIGN.md): addresses, a note's fallback forms, what a
 * vessel can do for comms (its manifest's §3.2 items, with defaults by kind), and how one note renders on one vessel.
 * Pure: the server decides who gets what; each vessel's adapter only carries out the plan.
 */
import type {
  CommsAddress,
  CommsForms,
  CommsNote,
  RegisteredDevice,
} from "@t3tools/baton-contracts";

export type CommsTarget =
  | { readonly kind: "all" }
  | { readonly kind: "person" | "room" | "group" | "vessel"; readonly id: string };

/** An address's parts; null for one that is not an address. */
export const parseAddress = (address: string): CommsTarget | null => {
  if (address === "all") return { kind: "all" };
  const m = /^(person|room|group|vessel):([^\s:]{1,128})$/.exec(address);
  return m === null
    ? null
    : { kind: m[1] as "person" | "room" | "group" | "vessel", id: m[2]!.toLowerCase() };
};
export const personAddress = (member: string): CommsAddress => `person:${member}`;
export const vesselAddress = (deviceId: string): CommsAddress => `vessel:${deviceId}`;

/** Group names that mean a role (`group:kids` is every child). */
export const GROUP_ROLES: Readonly<Record<string, ReadonlyArray<string>>> = {
  kids: ["child"],
  children: ["child"],
  adults: ["owner", "admin", "adult"],
  parents: ["owner", "admin", "adult"],
  family: ["owner", "admin", "adult", "child"],
  everyone: ["owner", "admin", "adult", "child"],
};

const EMOJI = /\p{Extended_Pictographic}(?:️|‍\p{Extended_Pictographic})*/u;

/**
 * The forms when no model made them (a typed send with no brain, or no model reachable): the first emoji in the text,
 * otherwise 💬, its first four words, and "From <sender>: <text>".
 */
export const fallbackForms = (text: string, fromLabel: string): CommsForms => {
  const clean = text.replace(/\s+/g, " ").trim();
  const words = clean
    .replace(new RegExp(EMOJI.source, "gu"), "")
    .split(" ")
    .filter((w) => w !== "")
    .slice(0, 4)
    .join(" ");
  return {
    glance: { emoji: EMOJI.exec(clean)?.[0] ?? "💬", words: words.slice(0, 48) },
    spoken: `From ${fromLabel}: ${clean}`.slice(0, 600),
    mood: "neutral",
  };
};

/** The forms a sender's turn made, kept to their caps: a glance of four words at most. */
export const trimForms = (forms: CommsForms): CommsForms => ({
  ...forms,
  glance: {
    emoji: EMOJI.exec(forms.glance.emoji)?.[0] ?? "💬",
    words: forms.glance.words
      .split(/\s+/)
      .filter((w) => w !== "")
      .slice(0, 4)
      .join(" "),
  },
});

/** What a vessel can do for comms (COMMS-DESIGN §3.2). */
export interface CommsCaps {
  readonly display: "none" | "eyes-round" | "screen" | "led";
  readonly push: boolean;
  readonly audioOut: boolean;
  readonly audioIn: boolean;
  readonly aec: "none" | "half" | "full";
  readonly duplex: "half" | "full";
  readonly codecs: ReadonlyArray<"pcm16" | "opus">;
  readonly video: "none" | "send" | "recv" | "both";
  /** How it shows it is live; null: it has no indicator that firmware or code holds, so its mic never opens to a person. */
  readonly live: "led" | "eyes" | "screen" | "os" | null;
  /** The server can wake it (a charger-held R1, a phone by push); an asleep battery R1 cannot. */
  readonly wakeable: boolean;
}

/** The comms items a manifest may carry, by id. */
export const COMMS_ITEMS = [
  "display.kind",
  "notify.push",
  "audio.out",
  "audio.in",
  "audio.aec",
  "call.duplex",
  "call.codecs",
  "call.video",
  "live.indicator",
  "power.wakeable",
] as const;

/**
 * What each kind can do until its manifest says otherwise. The R1's live light is not firmware-locked yet (§6), so it
 * has no live indicator: no mic opens to a person on it until its manifest declares one.
 */
const KIND_CAPS: Readonly<Record<string, CommsCaps>> = {
  r1: {
    display: "eyes-round",
    push: false,
    audioOut: true,
    audioIn: true,
    aec: "half",
    duplex: "half",
    codecs: ["pcm16"],
    video: "none",
    live: null,
    wakeable: false,
  },
  phone: {
    display: "screen",
    push: true,
    audioOut: true,
    audioIn: true,
    aec: "full",
    duplex: "full",
    codecs: ["pcm16"],
    video: "none",
    live: "os",
    wakeable: true,
  },
  desktop: {
    display: "screen",
    push: false,
    audioOut: true,
    audioIn: true,
    aec: "full",
    duplex: "full",
    codecs: ["pcm16"],
    video: "none",
    live: "screen",
    wakeable: false,
  },
};
const UNKNOWN_CAPS: CommsCaps = {
  display: "none",
  push: false,
  audioOut: false,
  audioIn: false,
  aec: "none",
  duplex: "half",
  codecs: [],
  video: "none",
  live: null,
  wakeable: false,
};

const oneOf = <T extends string>(value: unknown, allowed: ReadonlyArray<T>, fallback: T): T =>
  typeof value === "string" && (allowed as ReadonlyArray<string>).includes(value)
    ? (value as T)
    : fallback;
const bool = (value: unknown, fallback: boolean) => (typeof value === "boolean" ? value : fallback);

/** A vessel's comms caps: its manifest's values over its kind's defaults; an unknown kind can do nothing. */
export const commsCaps = (device: Pick<RegisteredDevice, "kind" | "values">): CommsCaps => {
  const base = KIND_CAPS[device.kind] ?? UNKNOWN_CAPS;
  const v = new Map(device.values.map((x) => [x.itemId, x.value]));
  const codecs = v.get("call.codecs");
  return {
    display: oneOf(v.get("display.kind"), ["none", "eyes-round", "screen", "led"], base.display),
    push: bool(v.get("notify.push"), base.push),
    audioOut: bool(v.get("audio.out"), base.audioOut),
    audioIn: bool(v.get("audio.in"), base.audioIn),
    aec: oneOf(v.get("audio.aec"), ["none", "half", "full"], base.aec),
    duplex: oneOf(v.get("call.duplex"), ["half", "full"], base.duplex),
    codecs: Array.isArray(codecs)
      ? codecs.filter((c): c is "pcm16" | "opus" => c === "pcm16" || c === "opus")
      : base.codecs,
    video: oneOf(v.get("call.video"), ["none", "send", "recv", "both"], base.video),
    // A manifest that names no indicator we know has none: the mic stays closed to people.
    live: v.has("live.indicator")
      ? oneOf<NonNullable<CommsCaps["live"]> | "none">(
          v.get("live.indicator"),
          ["led", "eyes", "screen", "os"],
          "none",
        ) === "none"
        ? null
        : (v.get("live.indicator") as CommsCaps["live"])
      : base.live,
    wakeable: bool(v.get("power.wakeable"), base.wakeable),
  };
};

/**
 * Comms sound events, by the sound system's ids (SOUND-SYSTEM-DESIGN §2, COMMS-DESIGN §7b). Which tone each plays is
 * the sound settings' ringtone choice; until he picks, each is a placeholder from the existing cues.
 */
export const COMMS_SOUNDS = [
  "message",
  "announce",
  "ring_intercom",
  "ring_call",
  "ring_group",
  "ring_urgent",
  "live_start",
  "live_end",
  "live_tick",
  "call_waiting",
] as const;
export type CommsSound = (typeof COMMS_SOUNDS)[number];

/** Initial colours for a sender on the R1's eyes: one per member, the same on every vessel. */
const SENDER_COLOURS = ["#e8a87c", "#85cdca", "#d4a5e8", "#f6d55c", "#7fb3e8", "#e88a8a"];
export const senderColour = (member: string | null): string => {
  if (member === null) return "#9aa0a6";
  let h = 0;
  for (const ch of member) h = (h * 31 + ch.codePointAt(0)!) >>> 0;
  return SENDER_COLOURS[h % SENDER_COLOURS.length]!;
};

/** About 20 seconds of speech: a longer note plays its first sentence on a shared vessel and offers the rest. */
const LONG_WORDS = 50;

/** How one note shows and sounds on one vessel. Each field a vessel cannot do is null. */
export interface NotePlan {
  readonly sound: CommsSound | null;
  /** The R1's two eyes: the sender's initial and colour, and the glance. */
  readonly eyes: {
    readonly initial: string;
    readonly colour: string;
    readonly emoji: string;
    readonly words: string;
  } | null;
  readonly mood: CommsForms["mood"];
  /** What plays aloud: the sender's own recording, or her voice saying the words. */
  readonly voice: { readonly clip: string } | { readonly say: string } | null;
  /** A phone notification. */
  readonly push: { readonly title: string; readonly body: string } | null;
  /** A screen's card or toast. */
  readonly card: { readonly emoji: string; readonly title: string; readonly body: string } | null;
  /** The body waits for "play it" from the recipient's verified voice. */
  readonly held: boolean;
}

export interface RenderContext {
  /** The recipient's own device (their phone, their desktop), not a shared room vessel. */
  readonly personal: boolean;
  /** Who it is for, as she says it ("Sara"); null for a room or everyone. */
  readonly forName: string | null;
  /** The recipient's voice is verified at this vessel now. */
  readonly verified?: boolean;
}

/**
 * One note on one vessel (COMMS-DESIGN §3.3). The eyes show who and the glance; a screen shows a card; a phone gets a
 * push; a vessel with only a speaker gets the chime and voice. A private note on a shared vessel shows only its glance
 * and "a message for <name>" until that person's voice is verified there.
 */
export const renderNote = (
  note: Pick<
    CommsNote,
    "kind" | "from" | "fromLabel" | "text" | "forms" | "urgency" | "private" | "audio"
  >,
  caps: CommsCaps,
  context: RenderContext,
): NotePlan => {
  const held = note.private && !context.personal && context.verified !== true;
  const sound: CommsSound | null =
    note.kind === "reaction"
      ? null
      : note.urgency === "urgent"
        ? "ring_urgent"
        : note.kind === "announce"
          ? "announce"
          : "message";
  const glance = note.forms.glance;
  const forWhom = context.forName === null ? "A message" : `A message for ${context.forName}`;
  const spokenFull =
    note.kind === "voice" && note.audio !== null
      ? { clip: note.audio }
      : { say: note.forms.spoken };
  const shared = !context.personal;
  const spoken =
    "say" in spokenFull &&
    shared &&
    note.forms.spoken.split(/\s+/).length > LONG_WORDS &&
    note.kind !== "announce"
      ? {
          say: `${(/^.*?[.!?](\s|$)/.exec(note.forms.spoken)?.[0] ?? note.forms.spoken.split(/\s+/).slice(0, 20).join(" ")).trim()} Want the rest?`,
        }
      : spokenFull;
  const voice = !caps.audioOut
    ? null
    : held
      ? { say: `${forWhom} from ${note.fromLabel}.` }
      : note.kind === "reaction"
        ? null
        : spoken;
  const body = held ? `${glance.emoji} ${forWhom}` : note.text;
  const initial = (note.fromLabel.trim()[0] ?? "?").toUpperCase();
  switch (caps.display) {
    case "eyes-round":
      return {
        sound,
        eyes: {
          initial,
          colour: senderColour(note.from),
          emoji: glance.emoji,
          words: glance.words,
        },
        mood: note.forms.mood,
        voice,
        push: null,
        card: null,
        held,
      };
    case "screen":
      return {
        sound,
        eyes: null,
        mood: note.forms.mood,
        // A screen plays on a tap, except a broadcast, which is played aloud at once where it can be.
        voice: note.kind === "announce" && !caps.push ? voice : null,
        push: caps.push
          ? { title: note.fromLabel, body: `${glance.emoji} ${body}`.slice(0, 240) }
          : null,
        card: { emoji: glance.emoji, title: note.fromLabel, body },
        held,
      };
    case "led":
    case "none":
      return { sound, eyes: null, mood: note.forms.mood, voice, push: null, card: null, held };
  }
};

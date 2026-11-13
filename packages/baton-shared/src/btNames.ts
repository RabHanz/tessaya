/**
 * His Bluetooth speakers and headphones by the names he uses ("my speakers", "the office speaker", "the Miniso"),
 * matched to an address. A paired speaker does not advertise, so connecting by name over the air fails: the known
 * list (the vessel's bonds and the devices it connected to, and the paired list of his desktop) is where a name
 * becomes a MAC. Pure.
 */

export interface BtKnown {
  readonly mac: string;
  /** The device's own name, or "" when nothing ever said it. */
  readonly name: string;
  /** When a vessel last connected to it (epoch ms), or null. */
  readonly lastAt: number | null;
  /** Its Bluetooth Class of Device, when the vessel heard it. */
  readonly cod?: number | undefined;
  /** What it is: from `cod`, else guessed from its name (btKindOf). */
  readonly kind?: BtKind | undefined;
}

export const BT_KINDS = ["headphones", "headset", "speaker", "car", "receiver", "other"] as const;
export type BtKind = (typeof BT_KINDS)[number];

/**
 * The Class of Device's audio/video minor class (Bluetooth Assigned Numbers, major class 0x04), or null when the
 * class says nothing an audio route can use.
 */
export const btKindOfCod = (cod: number): BtKind | null => {
  if (((cod >> 8) & 0x1f) !== 0x04) return null;
  switch ((cod >> 2) & 0x3f) {
    case 0x01: // wearable headset
    case 0x02: // hands-free
      return "headset";
    case 0x06:
      return "headphones";
    case 0x05: // loudspeaker
    case 0x07: // portable audio
      return "speaker";
    case 0x08:
      return "car";
    case 0x09: // set-top box
    case 0x0a: // HiFi audio device
      return "receiver";
    default:
      return null;
  }
};

/** Its kind: the vessel's word, its class of device, else its name. */
export const kindOf = (k: Pick<BtKnown, "name" | "cod" | "kind">): BtKind =>
  k.kind ?? (k.cod === undefined ? null : btKindOfCod(k.cod)) ?? btKindOf(k.name);

const HEADPHONES =
  /head ?(phone|set)s?|ear ?(bud|phone)s?|buds|airpods|wh-|wf-|qc ?\d|in-?ear|over-?ear/i;
const SPEAKERS =
  /speaker|sound ?(bar|link|core)|boom|jbl|flip|charge|sonos|soundlink|bose|anker|tribit|taotronics|miniso|marshall|ue /i;

export const btKindOf = (name: string): BtKind =>
  /headset|hands-?free/i.test(name)
    ? "headset"
    : HEADPHONES.test(name)
      ? "headphones"
      : SPEAKERS.test(name)
        ? "speaker"
        : /\bcar\b|carplay|android auto/i.test(name)
          ? "car"
          : /receiver|\bavr\b|amplifier|amp\b/i.test(name)
            ? "receiver"
            : "other";

const words = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((w) => w.length > 1 && !FILLER.has(w));
const FILLER = new Set([
  "my",
  "the",
  "a",
  "an",
  "to",
  "on",
  "bluetooth",
  "bt",
  "device",
  "new",
  "one",
  "please",
]);
const singular = (w: string) => (w.length > 3 && w.endsWith("s") ? w.slice(0, -1) : w);
const KIND_WORDS: Readonly<Record<string, BtKind>> = {
  speaker: "speaker",
  soundbar: "speaker",
  headphone: "headphones",
  headset: "headset",
  earbud: "headphones",
  bud: "headphones",
  earphone: "headphones",
  car: "car",
  receiver: "receiver",
  amp: "receiver",
  amplifier: "receiver",
};
/** "My headphones" also means a headset, and the other way round: both are worn. */
const kindMatches = (asked: BtKind, theirs: BtKind) =>
  asked === theirs ||
  (asked === "headphones" && theirs === "headset") ||
  (asked === "headset" && theirs === "headphones");

/** Two names for one thing: "minisio" for "MINISO", one wrong letter in five. */
const close = (a: string, b: string) => {
  if (a === b || (a.length >= 4 && (b.startsWith(a) || a.startsWith(b)))) return true;
  if (Math.abs(a.length - b.length) > 1 || a.length < 4) return false;
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
};

export type BtResolved =
  | { readonly kind: "one"; readonly device: BtKnown }
  | { readonly kind: "several"; readonly devices: ReadonlyArray<BtKnown> }
  | { readonly kind: "none" };

/**
 * His words to one known device. Name words must match; a kind word ("speakers", "headphones") narrows to that kind.
 * With nothing but a kind word, the one he used last wins when there are several of that kind he used before; a tie
 * is asked about, never guessed.
 */
export const resolveBluetooth = (query: string, known: ReadonlyArray<BtKnown>): BtResolved => {
  const mac = /([0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i
    .exec(query)?.[0]
    ?.toUpperCase()
    .replaceAll("-", ":");
  if (mac !== undefined) {
    const found = known.find((k) => k.mac.toUpperCase() === mac);
    return { kind: "one", device: found ?? { mac, name: "", lastAt: null } };
  }
  const said = words(query).map(singular);
  const kind = said.map((w) => KIND_WORDS[w]).find((k) => k !== undefined);
  const nameWords = said.filter((w) => KIND_WORDS[w] === undefined);
  const scored = known
    .filter(
      (k) =>
        kind === undefined ||
        kindMatches(kind, kindOf(k)) ||
        (k.name === "" && k.cod === undefined),
    )
    .map((k) => {
      const theirs = words(k.name).map(singular);
      const hits = nameWords.filter((w) => theirs.some((t) => close(w, t))).length;
      return { k, hits };
    });
  const named = nameWords.length > 0 ? scored.filter((s) => s.hits > 0) : scored;
  // "The office speaker" when no name says office: the kind alone decides, or it is asked about.
  if (named.length === 0)
    return kind !== undefined && nameWords.length > 0
      ? resolveBluetooth(kind, known)
      : { kind: "none" };
  const best = Math.max(...named.map((s) => s.hits));
  let top = named.filter((s) => s.hits === best).map((s) => s.k);
  // A name-less device only answers a bare kind word, and only when nothing named does.
  if (top.some((k) => k.name !== "")) top = top.filter((k) => k.name !== "");
  if (top.length === 1) return { kind: "one", device: top[0]! };
  if (nameWords.length === 0) {
    const used = top.filter((k) => k.lastAt !== null).toSorted((a, b) => b.lastAt! - a.lastAt!);
    if (used.length > 0 && (used.length === 1 || used[0]!.lastAt !== used[1]!.lastAt))
      return { kind: "one", device: used[0]! };
  }
  return { kind: "several", devices: top };
};

/** One list from several sources: by MAC, keeping a name when any source has one and the latest use. */
export const mergeKnown = (
  ...lists: ReadonlyArray<ReadonlyArray<BtKnown>>
): ReadonlyArray<BtKnown> => {
  const out = new Map<string, BtKnown>();
  for (const list of lists)
    for (const k of list) {
      const mac = k.mac.toUpperCase();
      const was = out.get(mac);
      const cod = k.cod ?? was?.cod;
      const kind = k.kind ?? was?.kind;
      out.set(mac, {
        mac,
        ...(cod === undefined ? {} : { cod }),
        ...(kind === undefined ? {} : { kind }),
        name: k.name !== "" ? k.name : (was?.name ?? ""),
        lastAt:
          Math.max(k.lastAt ?? -1, was?.lastAt ?? -1) < 0
            ? null
            : Math.max(k.lastAt ?? -1, was?.lastAt ?? -1),
      });
    }
  return [...out.values()];
};

/** A known list as a vessel reported it (an item value): only well-formed rows. */
export const knownFrom = (value: unknown): ReadonlyArray<BtKnown> =>
  Array.isArray(value)
    ? value.flatMap((v) => {
        const r = typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
        return typeof r["mac"] === "string" && /^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(r["mac"])
          ? [
              {
                mac: r["mac"].toUpperCase(),
                name: typeof r["name"] === "string" ? r["name"].slice(0, 60) : "",
                lastAt: typeof r["lastAt"] === "number" ? r["lastAt"] : null,
                ...(typeof r["cod"] === "number" && Number.isInteger(r["cod"])
                  ? { cod: r["cod"] }
                  : {}),
                ...(typeof r["kind"] === "string" &&
                (BT_KINDS as ReadonlyArray<string>).includes(r["kind"])
                  ? { kind: r["kind"] as BtKind }
                  : {}),
              },
            ]
          : [];
      })
    : [];

export const btLabel = (k: BtKnown): string => (k.name === "" ? "the Bluetooth device" : k.name);

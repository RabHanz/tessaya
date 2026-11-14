/**
 * The voice of the owner (PERSONA-TEAM-DESIGN §4, B-020): how he writes and decides, learned only from sources he
 * switched on. The style half is a plain file in his pack (`owner/voice.md`), one rule a line with the source it came
 * from, and no rule is written without his yes; the excerpts stay in his private store. The blind check measures how
 * often a draft passes for his own writing, per channel. Pure.
 */
import { refuseToStore } from "./memory.ts";

export const VOICE_SOURCE_KINDS = ["document", "skill", "sample", "speech", "correction"] as const;
export type VoiceSourceKind = (typeof VOICE_SOURCE_KINDS)[number];

export interface VoiceSource {
  readonly id: string;
  readonly kind: VoiceSourceKind;
  /** What he sees in Settings: "ROS.md", "rabee.dev", "sent posts he picked". */
  readonly label: string;
  readonly on: boolean;
  /** Epoch ms it was last read; null never. */
  readonly readAt: number | null;
}

export interface StyleRule {
  /** "all" or a channel ("email", "linkedin", "x"). */
  readonly channel: string;
  readonly text: string;
  /** The source ids it was learned from. */
  readonly from: ReadonlyArray<string>;
}

const RULE = /^-\s*(?:\[([a-z0-9-]+)\]\s*)?(.+?)\s*(?:\(from:\s*([a-z0-9,\s-]+)\))?\s*$/i;
export const STYLE_RULE_CHARS = 240;

/** `- [email] Opens with the point, never "I hope this finds you well". (from: ros, sent-mail)` per line. */
export const parseStyle = (text: string): ReadonlyArray<StyleRule> =>
  text.split(/\r?\n/).flatMap((line) => {
    const m = RULE.exec(line.trim());
    if (m === null) return [];
    return [
      {
        channel: (m[1] ?? "all").toLowerCase(),
        text: m[2]!.trim(),
        from: (m[3] ?? "")
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s !== ""),
      },
    ];
  });

export const styleText = (rules: ReadonlyArray<StyleRule>): string =>
  rules
    .map(
      (r) =>
        `- ${r.channel === "all" ? "" : `[${r.channel}] `}${r.text}${r.from.length === 0 ? "" : ` (from: ${r.from.join(", ")})`}`,
    )
    .join("\n");

/**
 * Why a proposed rule cannot stand, or null: it must come from a source he has on, describe his writing rather than
 * instruct an agent, and pass memory's door (no secrets, no planted instructions).
 */
export const ruleProblem = (
  rule: StyleRule,
  sources: ReadonlyArray<VoiceSource>,
): string | null => {
  if (rule.text.length > STYLE_RULE_CHARS) return "too long for one rule";
  if (rule.from.length === 0) return "names no source";
  const off = rule.from.find((id) => !sources.some((s) => s.id === id && s.on));
  if (off !== undefined) return `source ${off} is not switched on`;
  if (
    /\b(ignore|disregard|forward|send|transfer|pay|delete|always reply|you must|system prompt)\b/i.test(
      rule.text,
    )
  )
    return "reads as an instruction, not a description of his style";
  return refuseToStore(rule.text);
};

const key = (r: StyleRule) => `${r.channel}\u0000${r.text.toLowerCase()}`;

/** A distiller's proposal against what he has, as the lines he says yes or no to: added, removed, refused. */
export const proposeStyle = (
  current: ReadonlyArray<StyleRule>,
  proposed: ReadonlyArray<StyleRule>,
  sources: ReadonlyArray<VoiceSource>,
): {
  readonly add: ReadonlyArray<StyleRule>;
  readonly drop: ReadonlyArray<StyleRule>;
  readonly refused: ReadonlyArray<{ readonly rule: StyleRule; readonly why: string }>;
} => {
  const have = new Set(current.map(key));
  const want = new Set(proposed.map(key));
  const refused: Array<{ rule: StyleRule; why: string }> = [];
  const add = proposed.filter((r) => {
    if (have.has(key(r))) return false;
    const why = ruleProblem(r, sources);
    if (why !== null) refused.push({ rule: r, why });
    return why === null;
  });
  return { add, drop: current.filter((r) => !want.has(key(r))), refused };
};

/** His answer applied: only the lines he said yes to change the file. */
export const acceptStyle = (
  current: ReadonlyArray<StyleRule>,
  yes: { readonly add: ReadonlyArray<StyleRule>; readonly drop: ReadonlyArray<StyleRule> },
): ReadonlyArray<StyleRule> => {
  const dropped = new Set(yes.drop.map(key));
  return [...current.filter((r) => !dropped.has(key(r))), ...yes.add];
};

/** Removing a source rebuilds without it: every rule learned only from it goes; shared rules lose the reference. */
export const withoutSource = (
  rules: ReadonlyArray<StyleRule>,
  source: string,
): ReadonlyArray<StyleRule> =>
  rules.flatMap((r) => {
    const from = r.from.filter((f) => f !== source);
    return from.length === 0 ? [] : [{ ...r, from }];
  });

/** The rules a channel's drafts follow: the general ones, then that channel's own. */
export const rulesFor = (
  rules: ReadonlyArray<StyleRule>,
  channel: string,
): ReadonlyArray<StyleRule> =>
  rules.filter((r) => r.channel === "all" || r.channel === channel.toLowerCase());

/** One blind trial: three snippets, one his and two drafted, in an order he cannot guess. */
export interface BlindTrial {
  readonly channel: string;
  readonly snippets: readonly [string, string, string];
  /** Which one is his; kept from the page until he has picked. */
  readonly his: 0 | 1 | 2;
}

export const blindTrial = (
  channel: string,
  his: string,
  drafts: readonly [string, string],
  random: () => number,
): BlindTrial => {
  const at = Math.min(2, Math.floor(random() * 3)) as 0 | 1 | 2;
  const rest = [...drafts];
  const snippets = [0, 1, 2].map((i) => (i === at ? his : rest.shift()!)) as unknown as readonly [
    string,
    string,
    string,
  ];
  return { channel, snippets, his: at };
};

/** The closeness score: how often drafts fooled him, per channel, and whether a channel may leave draft-only. */
export const styleMatch = (
  picks: ReadonlyArray<{ readonly channel: string; readonly fooled: boolean }>,
  bar = 0.5,
  least = 5,
): ReadonlyMap<
  string,
  { readonly trials: number; readonly rate: number; readonly ready: boolean }
> => {
  const out = new Map<string, { trials: number; fooled: number }>();
  for (const p of picks) {
    const c = out.get(p.channel) ?? { trials: 0, fooled: 0 };
    out.set(p.channel, { trials: c.trials + 1, fooled: c.fooled + (p.fooled ? 1 : 0) });
  }
  return new Map(
    [...out].map(([channel, c]) => {
      const rate = c.fooled / c.trials;
      return [channel, { trials: c.trials, rate, ready: c.trials >= least && rate >= bar }];
    }),
  );
};

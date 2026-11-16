/**
 * What a Tessel and its room loop report over the hub, as actions (B-046): firmware events (wake, buttons, motion,
 * NFC, haptics done), the loop's per-turn verdict (who spoke, how sure, how fast) and coming online. Only numbers,
 * flags and short enums are kept: what he said never enters the log.
 */
import type { ActionInput } from "@t3tools/tessaya-shared/provenance";

/** Several a second while he reads an enrolment card: the card, not the log. */
const SKIP: ReadonlySet<string> = new Set(["event/enrol"]);

const SPEAKER_ACTOR = {
  owner: "owner",
  saved: "member",
  guest: "guest",
  unverified: "guest",
} as const;

const facts = (body: unknown): Record<string, number | boolean | string> => {
  const out: Record<string, number | boolean | string> = {};
  if (body === null || typeof body !== "object") return out;
  for (const [k, v] of Object.entries(body)) {
    if (k === "text" || k === "words") continue;
    if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    // A short enum (a reason, a mood, a button), never a sentence.
    else if (typeof v === "string" && v.length <= 24 && !v.includes(" ")) out[k] = v;
  }
  return out;
};

const parse = (payload: string): unknown => {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
};

/** `tail` is the topic after `freya/r1/<id>/`. Null: not an action worth a row. */
export const roomActionOf = (id: string, tail: string, payload: string): ActionInput | null => {
  if (tail === "state/online") {
    return {
      kind: "device.online",
      actor: { kind: "device", id, certainty: 1 },
      subject: id,
      outcome: payload.trim() === "1" ? "online" : "offline",
      data: { vessel: id },
    };
  }
  if (!tail.startsWith("event/") || SKIP.has(tail)) return null;
  const body = parse(payload);
  if (tail === "event/voice/metrics") {
    const m = body as { speaker?: string; speakerScore?: number | null } | null;
    const speaker = (m?.speaker ?? "unverified") as keyof typeof SPEAKER_ACTOR;
    return {
      kind: "room.voice_id",
      actor: {
        kind: SPEAKER_ACTOR[speaker] ?? "guest",
        ...(speaker === "owner" ? { id: "owner" } : {}),
        certainty: typeof m?.speakerScore === "number" ? m.speakerScore : 0,
      },
      subject: `turn on ${id}`,
      outcome: speaker,
      evidence: [{ kind: "device", ref: id }],
      data: { ...facts(body), vessel: id },
    };
  }
  return {
    kind: `room.${tail.slice("event/".length).replaceAll("/", ".")}`,
    actor: { kind: "device", id, certainty: 1 },
    subject: id,
    evidence: [{ kind: "device", ref: id }],
    data: { ...facts(body), vessel: id },
  };
};

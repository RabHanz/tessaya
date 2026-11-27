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

type Fact = number | boolean | string;

const flat = (body: object): Record<string, Fact> => {
  const out: Record<string, Fact> = {};
  for (const [k, v] of Object.entries(body)) {
    if (k === "text" || k === "words") continue;
    if (typeof v === "number" || typeof v === "boolean") out[k] = v;
    // A short enum (a reason, a mood, a button), never a sentence.
    else if (typeof v === "string" && v.length <= 24 && !v.includes(" ")) out[k] = v;
  }
  return out;
};

/** Numbers, flags and short enums, and one level of objects of them (a boot's `prev` power, the stats' heap `low`). */
const facts = (body: unknown): Record<string, Fact | Record<string, Fact>> => {
  if (body === null || typeof body !== "object") return {};
  const out: Record<string, Fact | Record<string, Fact>> = flat(body);
  for (const [k, v] of Object.entries(body))
    if (k !== "text" && k !== "words" && v !== null && typeof v === "object" && !Array.isArray(v))
      out[k] = flat(v);
  return out;
};

const parse = (payload: string): unknown => {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
};

/**
 * A fault the Tessel already reported: firmware before 0.3.177 kept it retained, so every reconnect replayed it (21 Nov:
 * one 18 Nov fault became 15 rows). The same payload again from the same device is not a new fault.
 */
export const repeatedFault = (
  seen: Map<string, string>,
  id: string,
  tail: string,
  payload: string,
): boolean => {
  if (tail !== "event/wake/fault") return false;
  if (seen.get(id) === payload) return true;
  seen.set(id, payload);
  return false;
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
  // A test run playing audio into the room (our speaker, his clone): the window wake training drops.
  if (tail === "event/test/playback") {
    const b = body as { open?: unknown; run?: unknown } | null;
    return {
      kind: "room.test.playback",
      actor: { kind: "system", id: "test-run", certainty: 1 },
      subject: id,
      outcome: b?.open === true ? "open" : "closed",
      evidence: [{ kind: "device", ref: id }],
      data: { run: String(b?.run ?? "").slice(0, 60), vessel: id },
    };
  }
  // Her room loop, not the Tessel: silent on the hub but still answering ARP, so it sent the remote reset (27 Nov).
  if (tail === "event/link/dead") {
    return {
      kind: "room.link.dead",
      actor: { kind: "system", id: "room-loop", certainty: 1 },
      subject: id,
      outcome: "reset sent",
      evidence: [{ kind: "device", ref: id }],
      data: { ...facts(body), vessel: id },
    };
  }
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
  // The firmware's own reboot reason ("a voice start or stop") is a phrase it wrote, never his words.
  const why = (body as { why?: unknown } | null)?.why;
  return {
    kind: `room.${tail.slice("event/".length).replaceAll("/", ".")}`,
    actor: { kind: "device", id, certainty: 1 },
    subject: id,
    evidence: [{ kind: "device", ref: id }],
    data: {
      ...facts(body),
      ...(tail === "event/wake/boot" && typeof why === "string" ? { why: why.slice(0, 40) } : {}),
      vessel: id,
    },
  };
};

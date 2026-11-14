/**
 * Her own words for the room loop's moments (acknowledgements, step-ups, enrolment): wordings the server's brain picked
 * for this persona and person, held a few ahead so a line never waits. Offline after her own words were on, the shipped
 * pool rotates without repeats; with them off, or never heard from the server, the loop says its plain line.
 * @module baton-voice/room/lines
 */
import type { ExpressionMood } from "@t3tools/tessaya-contracts";
import {
  fillLine,
  lineId,
  pickLine,
  poolLines,
  remember,
  timeSlot,
  type Line,
  type LineEvent,
} from "@t3tools/tessaya-shared/expression";

export interface LinesAsk {
  readonly events: ReadonlyArray<LineEvent>;
  readonly persona?: string;
  readonly person?: string;
  readonly count: number;
}
export interface LinesGot {
  readonly on: boolean;
  readonly lines: Readonly<Partial<Record<LineEvent, ReadonlyArray<Line>>>>;
}

export interface SaidLine {
  readonly text: string;
  readonly mood: ExpressionMood | null;
}

/** The moments the loop words itself. */
export const ROOM_EVENTS: ReadonlyArray<LineEvent> = [
  "ack.name",
  "ack.named",
  "ack.again",
  "err.overlap",
  "err.brain",
  "persona.switch",
  "id.unsure",
  "id.phrase",
  "id.confirm",
  "id.phone",
  "id.ok",
  "id.failed",
  "enrol.start",
];
const AHEAD = 3;

export const createLines = (deps: {
  readonly fetch: (ask: LinesAsk) => Promise<LinesGot>;
  readonly random: () => number;
  readonly hour: () => number;
  readonly log: (line: string) => void;
}) => {
  /** Whether her own words were on when the server last answered: offline keeps to that. */
  let on = false;
  const held = new Map<string, Array<Line>>();
  const recent = new Map<string, ReadonlyArray<string>>();
  const asking = new Set<string>();
  const key = (persona: string, person: string | undefined) => `${persona}|${person ?? ""}`;

  const refill = (
    persona: string,
    person: string | undefined,
    events: ReadonlyArray<LineEvent>,
  ): Promise<void> => {
    const k = key(persona, person);
    const asked = `${k}|${events.join(",")}`;
    if (asking.has(asked)) return Promise.resolve();
    asking.add(asked);
    return deps
      .fetch({
        events,
        persona,
        ...(person === undefined ? {} : { person }),
        count: AHEAD,
      })
      .then((got) => {
        on = got.on;
        for (const [event, lines] of Object.entries(got.lines)) {
          const q = held.get(`${k}|${event}`) ?? [];
          held.set(`${k}|${event}`, [...q, ...(lines ?? [])].slice(-AHEAD * 2));
        }
      })
      .catch((error: unknown) => deps.log(`lines: not fetched (${String(error)})`))
      .finally(() => asking.delete(asked));
  };

  return {
    /** Fetch ahead for a persona and person, at a session's start: the first line is then already here. */
    prime: (persona: string, person?: string) => refill(persona, person, ROOM_EVENTS),
    /** The wordings held now for a moment (filled), so the loop can render them before they are needed. */
    upcoming: (
      persona: string,
      person: string | undefined,
      event: LineEvent,
    ): ReadonlyArray<string> =>
      (held.get(`${key(persona, person)}|${event}`) ?? []).map((l) => l.text),
    /**
     * Her words for a moment. `plain` is the loop's own line, said while her own words are off; `facts` fill the slots
     * exactly, and a wording that cannot be filled gives way to `plain`.
     */
    take: (
      event: LineEvent,
      persona: string,
      person: string | undefined,
      plain: string,
      facts: Readonly<Record<string, string>> = {},
    ): SaidLine => {
      if (!on) return { text: plain, mood: null };
      const k = key(persona, person);
      const q = held.get(`${k}|${event}`) ?? [];
      const said = recent.get(k) ?? [];
      const next =
        q.shift() ??
        pickLine(event, poolLines(persona, event), said, timeSlot(deps.hour()), deps.random());
      held.set(`${k}|${event}`, q);
      if (q.length < 2) void refill(persona, person, [event]);
      const text = next === null ? null : fillLine(next.text, facts);
      if (next === null || text === null) return { text: plain, mood: null };
      recent.set(k, remember(said, lineId(event, next.text)));
      return { text, mood: next.mood };
    },
  };
};
export type RoomLines = ReturnType<typeof createLines>;

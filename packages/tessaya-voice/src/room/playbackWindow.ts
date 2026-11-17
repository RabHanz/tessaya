/**
 * Our test audio (speaker replays, his clone, `cmd/voice/wakeinject`) is not his speech. A run declares its window
 * retained on the hub's `event/test/playback` (`{"open":true,"run":"osp-0412","until":<ms>}`, then `"open":false`),
 * which the action log keeps; wake segments saved inside one are marked playback, and wake training reads only live.
 */

export const PLAYBACK_TOPIC =
  /^freya\/r1\/([^/]+)\/(event\/test\/playback|cmd\/voice\/wakeinject)$/;
/** A segment is saved when it ends, up to its full 7 s after the played audio that opened it. */
const CLOSE_GRACE_MS = 10_000;
// shortcut: a run that dies without closing marks the room as playback for 4 h at most; add a heartbeat if runs grow longer.
const MAX_OPEN_MS = 4 * 3_600_000;

const parse = (payload: string): Record<string, unknown> => {
  try {
    const v = JSON.parse(payload) as unknown;
    return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
};

export const createPlaybackWindows = (now: () => number) => {
  /** Per topic: the run playing and when its window lapses. */
  const open = new Map<string, { run: string; until: number }>();
  let closed = { run: "", at: Number.NEGATIVE_INFINITY };
  const close = (topic: string, at: number) => {
    const w = open.get(topic);
    if (w === undefined) return null;
    open.delete(topic);
    closed = { run: w.run, at };
    return w.run;
  };
  return {
    /** A message on `PLAYBACK_TOPIC`: a log line when a window opened or closed, else null. */
    message: (topic: string, payload: string): string | null => {
      const m = PLAYBACK_TOPIC.exec(topic);
      if (m === null) return null;
      const body = parse(payload);
      const t = now();
      const inject = m[2] === "cmd/voice/wakeinject";
      const isOpen = inject ? Number(body["on"]) === 1 : body["open"] === true;
      if (!isOpen) {
        const run = close(topic, t);
        return run === null ? null : `[${m[1]}] test playback closed (${run})`;
      }
      const run = inject
        ? "wakeinject"
        : String(body["run"] ?? "")
            .replace(/[^\w.:-]/g, "_")
            .slice(0, 60) || "test";
      const asked = Number(body["until"]);
      const until = Math.min(
        t + MAX_OPEN_MS,
        Number.isFinite(asked) && asked > t ? asked : Infinity,
      );
      const again = open.get(topic)?.run === run;
      open.set(topic, { run, until });
      return again ? null : `[${m[1]}] test playback open (${run})`;
    },
    /** The run whose audio may be in a segment ending now, or null when the room is live. */
    run: (): string | null => {
      const t = now();
      for (const [topic, w] of open) {
        if (t <= w.until) return w.run;
        close(topic, w.until);
      }
      return t - closed.at <= CLOSE_GRACE_MS ? closed.run : null;
    },
  };
};

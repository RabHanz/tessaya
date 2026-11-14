/**
 * The dictation pill's timeline maths, ported from the approved prototype (tessaya-ops drafts/pill/v2, Version 4):
 * the raw → clean word alignment, the easing curves, a seekable spring and the cleanup's marks. It is one
 * self-contained function so the pill's page can carry it as source (`pillEngine.toString()`), and every frame is a
 * function of the time alone.
 */
export const pillEngine = () => {
  const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
  const prog = (t: number, a: number, d: number) => clamp((t - a) / d);
  /** A cubic Bézier easing, solved by bisection. */
  const bez = (x1: number, y1: number, x2: number, y2: number) => (p: number) => {
    p = clamp(p);
    if (p === 0 || p === 1) return p;
    let lo = 0;
    let hi = 1;
    let t = p;
    for (let i = 0; i < 24; i++) {
      t = (lo + hi) / 2;
      const x = 3 * x1 * t * (1 - t) * (1 - t) + 3 * x2 * t * t * (1 - t) + t * t * t;
      if (x < p) lo = t;
      else hi = t;
    }
    return 3 * y1 * t * (1 - t) * (1 - t) + 3 * y2 * t * t * (1 - t) + t * t * t;
  };
  const EMPH = bez(0.2, 0, 0, 1);
  const DECEL = bez(0.05, 0.7, 0.1, 1);
  const ACCEL = bez(0.3, 0, 0.8, 0.15);
  const MD = { short4: 200, medium2: 300, medium4: 400, long2: 500 };
  /** Every transform's spring (damping 0.85, response 0.3 s, like SwiftUI's .snappy). */
  const SPRING = { zeta: 0.85, response: 0.3 };
  /** The cleanup's one motion: the same curve at half speed, settled in about 1.4 s. */
  const FLOW = { zeta: 0.85, response: 0.84 };
  /** The opening at ✓: 0.75 s, still at both ends, no overshoot. */
  const EXPAND_MS = 750;
  const SMOOTH = (x: number) => {
    x = clamp(x);
    return x * x * x * (x * (6 * x - 15) + 10);
  };
  type Spring = { readonly zeta: number; readonly response: number };
  type Target = { readonly at: number; readonly to: number };
  /** Closed form, folded over each change of target, so a retarget keeps its velocity; `snap` jumps instead. */
  const springAt = (
    events: ReadonlyArray<Target>,
    t: number,
    snap: boolean,
    sp: Spring = SPRING,
  ) => {
    if (snap) {
      let v = events[0]!.to;
      for (const e of events) if (e.at <= t) v = e.to;
      return v;
    }
    const w = (2 * Math.PI) / sp.response;
    const z = sp.zeta;
    const wd = w * Math.sqrt(1 - z * z);
    let x = events[0]!.to;
    let v = 0;
    let t0 = events[0]!.at;
    let target = events[0]!.to;
    const step = (ms: number) => {
      const dt = ms / 1000;
      const e = x - target;
      const b = (v + z * w * e) / wd;
      const k = Math.exp(-z * w * dt);
      const c = Math.cos(wd * dt);
      const s = Math.sin(wd * dt);
      return [
        target + k * (e * c + b * s),
        k * (-z * w * (e * c + b * s) + (-e * wd * s + b * wd * c)),
      ] as const;
    };
    for (let n = 1; n < events.length && events[n]!.at <= t; n++) {
      [x, v] = step(events[n]!.at - t0);
      t0 = events[n]!.at;
      target = events[n]!.to;
    }
    return step(Math.max(0, t - t0))[0];
  };
  const bareOf = (w: string) => w.toLowerCase().replace(/[^\p{L}\p{N}']+/gu, "");
  type Op =
    | { readonly op: "keep"; readonly i: number; readonly j: number }
    | { readonly op: "sub"; readonly i: number; readonly j: number }
    | { readonly op: "ins"; readonly j: number }
    | { readonly op: "drop"; readonly i: number };
  /**
   * Raw → clean, word by word: a kept word knows its clean index, a clean word with no raw source is an insert, and
   * one drop beside one insert is a changed word. Case and punctuation are not edits.
   */
  const align = (rawWords: ReadonlyArray<string>, cleanWords: ReadonlyArray<string>): Op[] => {
    const a = rawWords.map(bareOf);
    const b = cleanWords.map(bareOf);
    const T = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i--)
      for (let j = b.length - 1; j >= 0; j--)
        T[i]![j] =
          a[i] === b[j] && a[i] !== ""
            ? T[i + 1]![j + 1]! + 1
            : Math.max(T[i + 1]![j]!, T[i]![j + 1]!);
    const ops: Op[] = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
      if (
        i < a.length &&
        j < b.length &&
        a[i] === b[j] &&
        a[i] !== "" &&
        T[i + 1]![j]! < T[i]![j]!
      ) {
        ops.push({ op: "keep", i, j });
        i++;
        j++;
      } else if (j < b.length && (i >= a.length || T[i]![j + 1]! > T[i + 1]![j]!)) {
        ops.push({ op: "ins", j });
        j++;
      } else {
        ops.push({ op: "drop", i });
        i++;
      }
    }
    const alone = (n: number) => {
      const o = ops[n];
      return o === undefined || (o.op !== "drop" && o.op !== "ins");
    };
    for (let k = 0; k < ops.length - 1; k++) {
      const x = ops[k]!;
      const y = ops[k + 1]!;
      if (
        ((x.op === "drop" && y.op === "ins") || (x.op === "ins" && y.op === "drop")) &&
        alone(k - 1) &&
        alone(k + 2)
      ) {
        const d = x.op === "drop" ? x : (y as { readonly i: number });
        const n = x.op === "ins" ? x : (y as { readonly j: number });
        ops.splice(k, 2, { op: "sub", i: d.i, j: n.j });
      }
    }
    return ops;
  };
  /**
   * The cleanup's marks, in ms from ✓. `opening` is how long the cleanup waits for the pill to open (0.75 s when the
   * live view was scrolled) or for the clean text to arrive, whichever is longer; everything after it moves with it.
   */
  const cleanupTimes = (opening: number) => {
    const C = {
      X: Math.max(0, opening),
      LIT: 230,
      TXT: MD.medium2,
      SWAP: 320,
      HOLD_END: 1450,
      CUT: 1210,
      CUT_D: 2 * (MD.short4 + 80),
      MOVE_T: 1450,
      MOVE_D: 1400,
      STRIKE: 250,
      GREY: 350,
      P02: 0,
      SETTLED: 0,
      PASTE: 0,
      OUT_D: MD.medium2,
    };
    for (const key of ["LIT", "SWAP", "HOLD_END", "CUT", "MOVE_T"] as const) C[key] += C.X;
    // When the motion's progress reaches 0.2, for the spelling morphs.
    for (let ms = 0; ms < C.MOVE_D; ms += 5)
      if (
        springAt(
          [
            { at: 0, to: 0 },
            { at: 0, to: 1 },
          ],
          ms,
          false,
          FLOW,
        ) >= 0.2
      ) {
        C.P02 = ms;
        break;
      }
    C.SETTLED = C.MOVE_T + C.MOVE_D;
    C.PASTE = C.SETTLED + 120;
    return C;
  };
  /** While he talks the text width steps up in 56 px steps to what the words need, never down, up to `max`. */
  const stepWidth = (was: number, need: number, max: number) =>
    Math.max(was, Math.min(max, Math.ceil(need / 56) * 56));
  return {
    clamp,
    prog,
    EMPH,
    DECEL,
    ACCEL,
    MD,
    SPRING,
    FLOW,
    EXPAND_MS,
    SMOOTH,
    springAt,
    align,
    cleanupTimes,
    stepWidth,
  };
};

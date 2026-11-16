/**
 * The logo kit's start sting (motion/colour/sting-alpha-dark/motion.js `frame(t, 0.5, "fuse")`), as the desktop plays
 * it, in the mark's 256 coordinates. At t = 0 and from STING_REST_S on it is the resting mark: the native splash.
 * Worklets, so Reanimated draws it on the UI thread while the JS thread starts the app.
 */

/** The film's own length at the kit's pace; the strips are home at 1.5 s and the beat ends at 1.68 s. */
export const STING_END_S = 1.7;
export const STING_REST_S = 1.5;
/** The kit's stage around the mark, so the T can turn and grow past the mark's edges. */
export const STING_VIEWBOX = [-52.317, -52.317, 360.633, 360.633] as const;
/** The mark's width inside its 256 box (kit LOGO.bbox 19.81..236.19). */
export const MARK_SPAN = 216.38;

const K = 0.5;
const PI = Math.PI;
const R2 = Math.SQRT1_2;
// [a0, b0, a1, b1, direction a, direction b] for the seven paper strips, in the kit's order.
const OTHERS = [
  [-75, -78, -53, -52, 0, -1],
  [53, -78, 75, -52, 0, -1],
  [-11, 52, 11, 78, 0, 1],
  [-11, -78, 11, 12, 0, -1],
  [53, -12, 75, 78, 0, 1],
  [20, -43, 88, -21, 1, 0],
  [-88, -43, -20, -21, -1, 0],
] as const;

const cl = (x: number) => {
  "worklet";
  return Math.min(1, Math.max(0, x));
};
const lerp = (a: number, b: number, p: number) => {
  "worklet";
  return a + (b - a) * p;
};
const seg = (t: number, a: number, b: number) => {
  "worklet";
  return cl((t - a) / (b - a));
};
const io = (x: number) => {
  "worklet";
  return x < 0.5 ? 8 * x * x * x * x : 1 - Math.pow(-2 * x + 2, 4) / 2;
};
const eo = (x: number) => {
  "worklet";
  return x >= 1 ? 1 : 1 - Math.pow(2, -10 * x);
};
const ei = (x: number) => {
  "worklet";
  return x * x * x * x;
};
const beat = (x: number) => {
  "worklet";
  return x <= 0 || x >= 1 ? 0 : Math.sin(PI * x) ** 2;
};

interface Stage {
  readonly cos: number;
  readonly sin: number;
  readonly s: number;
  readonly dx: number;
  readonly dy: number;
}

/** A weave point (a along the rows, b along the columns) placed on the turned and grown stage, as "x y". */
const at = (a: number, b: number, st: Stage) => {
  "worklet";
  const x = (a - b) * R2;
  const y = (a + b) * R2;
  return `${(128 + st.dx + st.s * (x * st.cos - y * st.sin)).toFixed(2)} ${(
    128 +
    st.dy +
    st.s * (x * st.sin + y * st.cos)
  ).toFixed(2)}`;
};

interface Strip {
  readonly bar: boolean;
  readonly a: number;
  readonly b: number;
  readonly c: number;
  readonly d: number;
  readonly e: number;
}

/** The bar (stem: false) or the stem's centreline at u in 0..1. */
const centre = (s: Strip, u: number): [number, number] => {
  "worklet";
  return s.bar
    ? [-64 + s.a * 4 * u * (1 - u), 33 + s.b * (2 * u - 1)]
    : [s.a + s.b * u, 32 + s.c * Math.sin(2 * PI * u) * (1 - 0.3 * u)];
};
const width = (s: Strip, u: number) => {
  "worklet";
  return s.bar ? s.c : s.d + s.e * Math.pow(Math.max(0, 1 - u / 0.17), 2);
};

/** One flat band along the centreline, its ends square to the line (the kit's `band`). */
const band = (s: Strip, st: Stage) => {
  "worklet";
  const n = 28;
  const left: string[] = [];
  const right: string[] = [];
  for (let i = 0; i <= n; i++) {
    const u = i / n;
    const p = centre(s, u);
    const q = centre(s, Math.min(1, u + 0.01));
    const o = centre(s, Math.max(0, u - 0.01));
    const dx = q[0] - o[0];
    const dy = q[1] - o[1];
    const l = Math.hypot(dx, dy) || 1;
    const w = width(s, u) / 2;
    left.push(at(p[0] - (dy / l) * w, p[1] + (dx / l) * w, st));
    right.push(at(p[0] + (dy / l) * w, p[1] - (dx / l) * w, st));
  }
  return `M${left.concat(right.reverse()).join("L")}Z`;
};

export interface StingFrame {
  /** The seven paper strips, one path. */
  readonly paper: string;
  /** The two strips that make the T, one path. */
  readonly dye: string;
  /** 0 at rest, 1 while the T stands: how far the two strips take the dye. */
  readonly tee: number;
}

export const stingFrame = (seconds: number): StingFrame => {
  "worklet";
  const t = Math.max(0, seconds);
  const T = (x: number) => x * K;
  const m = io(seg(t, T(0.72), T(1.32))) * (1 - io(seg(t, T(2.0), T(2.62))));
  const live = seg(t, T(1.32), T(2.0));
  const sw = Math.sin(PI * seg(t, T(0.72), T(1.32))) + Math.sin(PI * seg(t, T(2.0), T(2.62)));
  const wb = lerp(22, 17, m);
  const ws = lerp(22, 15, m);
  const head = -64 + wb / 2 + lerp(9, 0, m);
  const len = 88 + m * lerp(14, 30, live);
  const S = lerp(1, 1.3, m);
  const cx = (-64 - wb / 2 + head + len) / 2;
  const r = (45 * m * PI) / 180;
  const st: Stage = { cos: Math.cos(r), sin: Math.sin(r), s: S, dx: 33 * S * m, dy: -cx * S * m };
  const bar = band({ bar: true, a: -20 * sw, b: 45 + m * 19, c: wb, d: 0, e: 0 }, st);
  const stem = band(
    { bar: false, a: head, b: len, c: 15 * sw, d: ws, e: m * lerp(30, 16, live) },
    st,
  );
  const pb = beat((t - T(3.02)) / T(0.34));
  let paper = "";
  for (let n = 0; n < OTHERS.length; n++) {
    const [a0, b0, a1, b1, ua, ub] = OTHERS[n]!;
    const f = ei(seg(t, T(0.25 + n * 0.07), T(0.68 + n * 0.07)));
    const back = eo(seg(t, T(1.95 + n * 0.06), T(2.78 + n * 0.03)));
    // Each strip runs out along its own length (in weave units, before the stage).
    const go = 400 * f * (1 - back) + 5 * pb;
    const oa = ua * go;
    const ob = ub * go;
    paper += `M${at(a0 + oa, b0 + ob, st)}L${at(a1 + oa, b0 + ob, st)}L${at(a1 + oa, b1 + ob, st)}L${at(a0 + oa, b1 + ob, st)}Z`;
  }
  return { paper, dye: bar + stem, tee: m };
};

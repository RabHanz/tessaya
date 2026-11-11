/**
 * The pill's waveform, ported from the approved pill-styles drafts (tessaya-ops drafts/pill-styles wave.js, styles.js):
 * the level pipeline every style shares, and the three renderers. One self-contained function, so the pill's page
 * carries it as source (`waveEngine.toString()`). Nothing here is random: a frame is a function of the levels heard.
 */

/** The canvas calls the renderers make; a real 2D context, or a recorder in tests. */
export interface WaveCanvas {
  fillStyle: unknown;
  globalCompositeOperation: string;
  beginPath(): void;
  arc(x: number, y: number, r: number, a0: number, a1: number): void;
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number): void;
  roundRect(x: number, y: number, w: number, h: number, r: number): void;
  fill(): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  createLinearGradient(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
  ): { addColorStop(at: number, color: string): void };
}

/** The level at `age` history steps ago (fractional ages interpolate; 0 is now). */
export type LevelAt = (age: number) => number;
export type Rgb = readonly [number, number, number];
/** `dict`: his voice, one colour; `assist`: Tessaya's own, the colour runs across it. */
export type WaveKind = "dict" | "assist";
export interface WaveColours {
  readonly c1: Rgb;
  readonly c2: Rgb;
  readonly c3: Rgb;
  readonly dark: boolean;
}

export const waveEngine = () => {
  const HZ = 30;
  const N = 128;
  const k = (dt: number, tau: number) => 1 - Math.exp(-dt / tau);

  /**
   * Raw dBFS in, a smoothed 0..1 level out. The noise floor drops fast into quiet and creeps up slowly, so room noise
   * never reads as speech; the peak jumps to loud syllables and relaxes, keeping at least 18 dB of range; the envelope
   * rises in about 45 ms and falls in about 220 ms. A 30 Hz history of it is what the renderers read.
   */
  const createLevel = () => {
    const hist = new Float32Array(N);
    let head = 0;
    let acc = 0;
    let frac = 0;
    let floor = -62;
    let peak = -30;
    let env = 0;
    /** One step: `db` is the latest frame's level, `dt` the seconds since the last step. */
    const tick = (db: number, dtIn: number): number => {
      const dt = Math.min(0.05, Math.max(0.001, dtIn));
      floor += (db - floor) * k(dt, db < floor ? 0.25 : 5);
      peak += ((db > peak ? db : floor + 22) - peak) * k(dt, db > peak ? 0.06 : 3);
      peak = Math.max(peak, floor + 18);
      const gate = floor + 5;
      const norm = Math.min(1, Math.max(0, (db - gate) / (peak - gate)));
      // Ordinary speech lands at 60-80% of the height.
      const target = 0.78 * Math.pow(norm, 0.85);
      env += (target - env) * k(dt, target > env ? 0.045 : 0.22);
      acc += dt;
      while (acc >= 1 / HZ) {
        acc -= 1 / HZ;
        head = (head + 1) % N;
        hist[head] = env;
      }
      frac = acc * HZ;
      return env;
    };
    const at: LevelAt = (age) => {
      if (age <= 0) return env;
      const a = age - frac;
      // Younger than the newest sample: between it and the live envelope.
      if (a < 0) return env + (hist[head]! - env) * (age / Math.max(frac, 1e-3));
      const i = Math.floor(a);
      const f = a - i;
      const p = hist[(head - i + N * 4) % N]!;
      const q = hist[(head - i - 1 + N * 4) % N]!;
      return p + (q - p) * f;
    };
    /** A fixed, believable moment of speech, for still renders. */
    const freeze = () => {
      head = 0;
      frac = 0;
      env = 0.7;
      for (let a = 0; a < N; a++) hist[(N - a) % N] = 0.62 + 0.1 * Math.cos(a * 0.55);
    };
    /** Back to silence, as a new recording starts. */
    const reset = () => {
      hist.fill(0);
      head = 0;
      acc = 0;
      frac = 0;
      floor = -62;
      peak = -30;
      env = 0;
    };
    return {
      tick,
      at,
      freeze,
      reset,
      state: () => ({ floor, peak, env }),
    };
  };

  /** A level of 0..1 (a voice's RMS) as dBFS; silence is -100. */
  const dbOf = (rms: number) => 20 * Math.log10(Math.max(rms, 1e-5));
  /** RMS dBFS of a 16-bit frame. */
  const frameDb = (frame: ArrayLike<number>) => {
    let s = 0;
    for (let i = 0; i < frame.length; i++) s += (frame[i]! / 32768) ** 2;
    return dbOf(Math.sqrt(s / Math.max(1, frame.length)));
  };

  const mix = (a: Rgb, b: Rgb, t: number): Rgb => [
    a[0] + (b[0] - a[0]) * t,
    a[1] + (b[1] - a[1]) * t,
    a[2] + (b[2] - a[2]) * t,
  ];
  const across = (o: WaveColours, u: number): Rgb =>
    u < 0.5 ? mix(o.c1, o.c2, u * 2) : mix(o.c2, o.c3, (u - 0.5) * 2);
  const rgba = (c: Rgb, a: number) =>
    `rgba(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])},${Math.min(1, Math.max(0, a)).toFixed(3)})`;

  /**
   * Mound: a lattice of dots lit from the foot up to a surface that swells with the voice. The freshest level sits in
   * the middle and spreads outward, so the surface swells rather than scrolls. `t` is the time in ms (the slow swell).
   */
  const mound = (
    g: WaveCanvas,
    w: number,
    h: number,
    L: LevelAt,
    kind: WaveKind,
    o: WaveColours,
    t: number,
  ) => {
    const sp = 3.4;
    const r = 0.95;
    const floorLit = 0.12;
    const colAt = (u: number) => (kind === "assist" ? across(o, u) : o.c1);
    const cols = Math.floor(w / sp);
    const rows = Math.floor(h / sp);
    const x0 = (w - cols * sp) / 2;
    const now = L(0);
    const ts = t / 1000;
    const pool = g.createLinearGradient(0, h, 0, 0);
    const pc = colAt(0.5);
    pool.addColorStop(0, rgba(pc, 0.1 + now * 0.45));
    pool.addColorStop(0.7, rgba(pc, 0));
    g.fillStyle = pool;
    g.fillRect(0, 0, w, h);
    for (let i = 0; i <= cols; i++) {
      const x = x0 + i * sp;
      const u = i / cols;
      const d = Math.abs(u - 0.5) * 2;
      const bell = Math.pow(Math.cos((d * Math.PI) / 2), 1.6);
      const lv = L(d * 9) * bell;
      const swell = 0.07 * now * bell * Math.sin(u * 6.5 + ts * 2.2);
      const surf = h * Math.max(floorLit, Math.min(0.96, floorLit + lv * (1 - floorLit) + swell));
      const c = colAt(u);
      for (let j = 0; j <= rows; j++) {
        const y = h - 1.5 - j * sp;
        const depth = h - y;
        if (depth > surf + sp) break;
        const a =
          Math.max(0, Math.min(1, (surf + sp - depth) / sp)) *
          (0.35 + 0.65 * (1 - depth / h)) *
          (o.dark ? 1 : 1.15);
        g.fillStyle = rgba(c, a);
        g.beginPath();
        g.arc(x, y, r, 0, 7);
        g.fill();
      }
    }
    // The ends fade over 12% of the width, the pool under the dots too.
    const f = g.createLinearGradient(0, 0, w, 0);
    f.addColorStop(0, "rgba(0,0,0,0)");
    f.addColorStop(0.12, "#000");
    f.addColorStop(0.88, "#000");
    f.addColorStop(1, "rgba(0,0,0,0)");
    g.globalCompositeOperation = "destination-in";
    g.fillStyle = f;
    g.fillRect(0, 0, w, h);
    g.globalCompositeOperation = "source-over";
  };

  /** Bars: thin, mirrored about the middle, the centre freshest; silence rests as a row of dots. */
  const bars = (
    g: WaveCanvas,
    w: number,
    h: number,
    L: LevelAt,
    _kind: WaveKind,
    o: WaveColours,
  ) => {
    const bw = 2;
    const gap = 2.6;
    const n = Math.floor((w + gap) / (bw + gap));
    const off = (w - (n * (bw + gap) - gap)) / 2;
    for (let i = 0; i < n; i++) {
      const d = Math.abs(i - (n - 1) / 2) / ((n - 1) / 2);
      const v = L(d * 8) * (1 - 0.5 * d * d);
      const bh = Math.max(bw, v * h);
      g.fillStyle = rgba(o.c1, 0.45 + 0.55 * Math.min(1, v * 2.2));
      g.beginPath();
      g.roundRect(off + i * (bw + gap), (h - bh) / 2, bw, bh, bw / 2);
      g.fill();
    }
  };

  /** Beads: round beads that lift and swell with the voice, newest on the right; silence lines them up, still. */
  const beads = (
    g: WaveCanvas,
    w: number,
    h: number,
    L: LevelAt,
    kind: WaveKind,
    o: WaveColours,
  ) => {
    const n = Math.max(5, Math.min(9, Math.round(w / 11)));
    const step = w / n;
    const r0 = Math.min(3.2, h * 0.15);
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      const v = L((n - 1 - i) * 1.5);
      const mid = 1 - 0.35 * Math.abs(u - 0.5) * 2;
      const lift = v * mid * (h / 2 - r0 * 1.6);
      const r = r0 * (1 + 0.55 * v);
      const c = kind === "assist" ? across(o, u) : i % 2 ? mix(o.c1, o.c2, 0.35) : o.c1;
      g.fillStyle = rgba(c, 0.55 + 0.45 * Math.min(1, v * 2));
      g.beginPath();
      g.arc(step * (i + 0.5), h / 2 - lift, r, 0, 7);
      g.fill();
      // A faint bead under each lifted one keeps the row's baseline readable.
      if (lift > 1) {
        g.fillStyle = rgba(c, 0.18);
        g.beginPath();
        g.ellipse(step * (i + 0.5), h / 2 + r0 * 0.9, r * 0.9, r0 * 0.45, 0, 0, 7);
        g.fill();
      }
    }
  };

  return { createLevel, dbOf, frameDb, mound, bars, beads, HZ, N };
};

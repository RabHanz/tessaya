/**
 * Where the desktop mascot stands, as plain geometry: the edges she can sit on (the top of the window he is in, and each
 * screen's floor above the taskbar), where she lands when dropped, where a short walk goes, and whether a window she
 * sits on moved or closed. All in DIP screen coordinates.
 */
export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface Edge {
  readonly kind: "window" | "floor";
  readonly x1: number;
  readonly x2: number;
  /** The line her feet stand on. */
  readonly y: number;
  readonly display: number;
}

export interface DisplayArea {
  readonly id: number;
  readonly bounds: Rect;
  readonly workArea: Rect;
  /** Windows lays mixed-scale screens out physically: there a screen's DIP rect times this is where it really sits. */
  readonly scaleFactor?: number;
}

export type Side = "left" | "right" | "top" | "bottom";
const OPPOSITE: Readonly<Record<Side, Side>> = {
  left: "right",
  right: "left",
  top: "bottom",
  bottom: "top",
};
/** How far apart two screens' sides may be and still touch. */
const SEAM_PX = 2;

/** The work area reaches the screen's own side there: no taskbar stands in the way. */
const openSide = (d: DisplayArea, side: Side): boolean => {
  const b = d.bounds;
  const w = d.workArea;
  if (side === "left") return Math.abs(w.x - b.x) <= 1;
  if (side === "top") return Math.abs(w.y - b.y) <= 1;
  if (side === "right") return Math.abs(w.x + w.width - (b.x + b.width)) <= 1;
  return Math.abs(w.y + w.height - (b.y + b.height)) <= 1;
};

export interface Seam {
  readonly to: DisplayArea;
  /** The stretch of the side, in the first screen's DIP, that opens onto `to`. */
  readonly from: number;
  readonly until: number;
  /** Multiplies a DIP point or speed on the first screen into `to`'s DIP (1 when DIP already touch). */
  readonly k: number;
}

/**
 * The screens touching one side of a screen, where nothing blocks the way. Checked in DIP first (macOS, Linux, and
 * Windows at one scale), then in Windows' physical layout, where screens at mixed scales touch although their DIP
 * rects leave a gap or overlap.
 */
export const seamsOf = (
  displays: ReadonlyArray<DisplayArea>,
  d: DisplayArea,
  side: Side,
): ReadonlyArray<Seam> => {
  if (!openSide(d, side)) return [];
  const along = side === "left" || side === "right";
  const out: Seam[] = [];
  for (const other of displays) {
    if (other === d || !openSide(other, OPPOSITE[side])) continue;
    for (const physical of [false, true]) {
      const s1 = physical ? (d.scaleFactor ?? 1) : 1;
      const s2 = physical ? (other.scaleFactor ?? 1) : 1;
      if (physical && s1 === s2) continue;
      const a = d.bounds;
      const b = other.bounds;
      const line =
        side === "right"
          ? (a.x + a.width) * s1
          : side === "left"
            ? a.x * s1
            : side === "bottom"
              ? (a.y + a.height) * s1
              : a.y * s1;
      const facing =
        side === "right"
          ? b.x * s2
          : side === "left"
            ? (b.x + b.width) * s2
            : side === "bottom"
              ? b.y * s2
              : (b.y + b.height) * s2;
      if (Math.abs(line - facing) > SEAM_PX * Math.max(s1, s2)) continue;
      // The shared stretch, back in the first screen's DIP.
      const lo = Math.max(along ? a.y * s1 : a.x * s1, along ? b.y * s2 : b.x * s2) / s1;
      const hi =
        Math.min(
          along ? (a.y + a.height) * s1 : (a.x + a.width) * s1,
          along ? (b.y + b.height) * s2 : (b.x + b.width) * s2,
        ) / s1;
      if (hi - lo < 1) continue;
      out.push({ to: other, from: lo, until: hi, k: s1 / s2 });
      break;
    }
  }
  return out;
};

/** The screen across a side of `d` at a point along that side (its y for left or right, its x for top or bottom). */
export const seamAt = (
  displays: ReadonlyArray<DisplayArea>,
  d: DisplayArea,
  side: Side,
  along: number,
): Seam | undefined => seamsOf(displays, d, side).find((s) => along >= s.from && along < s.until);

/** The ground line inside her window, as a share of its height: the rig's ground (112) in its 320-unit view from -168. */
export const FOOT_SHARE = (112 + 168) / 320;
/** A window narrower than this has no room for her on top. */
const MIN_WINDOW_EDGE = 200;
/** How far into a floor she sinks when snoozed: only the top of her head shows over the taskbar. */
const PEEK_SHARE = 0.3;
/** A walk goes at least this far, or it is not worth the frames. */
const MIN_WALK = 80;

const inside = (x: number, y: number, r: Rect) =>
  x >= r.x && x < r.x + r.width && y >= r.y && y < r.y + r.height;

export const displayAt = (
  displays: ReadonlyArray<DisplayArea>,
  x: number,
  y: number,
): DisplayArea | undefined =>
  displays.find((d) => inside(x, y, d.bounds)) ??
  displays.find((d) => x >= d.bounds.x && x < d.bounds.x + d.bounds.width);

/**
 * The edges she can stand on. The top of his window counts when it leaves room for her above it on its screen (a
 * maximised or full-screen window does not), clipped to that screen.
 */
export const edgesFor = (input: {
  readonly displays: ReadonlyArray<DisplayArea>;
  readonly window: Rect | null;
  /** Her window's height, for the room above. */
  readonly size: number;
}): ReadonlyArray<Edge> => {
  // A floor stops only where no screen continues below it: over a screen beneath, she falls on through.
  const floors: Edge[] = input.displays.flatMap((d) => {
    let parts: Array<readonly [number, number]> = [[d.workArea.x, d.workArea.x + d.workArea.width]];
    for (const gap of seamsOf(input.displays, d, "bottom"))
      parts = parts.flatMap(([a, b]) =>
        (
          [
            [a, Math.min(b, gap.from)],
            [Math.max(a, gap.until), b],
          ] as const
        ).filter(([p, q]) => q - p >= 1),
      );
    return parts.map(([x1, x2]) => ({
      kind: "floor" as const,
      x1,
      x2,
      y: d.workArea.y + d.workArea.height,
      display: d.id,
    }));
  });
  const w = input.window;
  if (w === null) return floors;
  const screen = displayAt(input.displays, w.x + w.width / 2, w.y + 1);
  if (screen === undefined) return floors;
  const x1 = Math.max(w.x, screen.workArea.x);
  const x2 = Math.min(w.x + w.width, screen.workArea.x + screen.workArea.width);
  const room = w.y - screen.workArea.y >= input.size * FOOT_SHARE;
  if (!room || x2 - x1 < MIN_WINDOW_EDGE) return floors;
  return [{ kind: "window", x1, x2, y: w.y, display: screen.id }, ...floors];
};

/** Gravity: the highest edge at or below her feet under x, else the floor of the screen x is on, else the first floor. */
export const landing = (edges: ReadonlyArray<Edge>, x: number, footY: number): Edge => {
  const below = edges
    .filter((e) => x >= e.x1 && x <= e.x2 && e.y >= footY - 4)
    .sort((a, b) => a.y - b.y);
  if (below[0] !== undefined) return below[0];
  const floors = edges.filter((e) => e.kind === "floor");
  return (
    floors.find((e) => x >= e.x1 && x <= e.x2) ??
    floors.toSorted(
      (a, b) => Math.abs((a.x1 + a.x2) / 2 - x) - Math.abs((b.x1 + b.x2) / 2 - x),
    )[0] ??
    edges[0]!
  );
};

/** Her window's top-left for standing at x on an edge, kept inside its ends. */
export const standAt = (
  edge: Edge,
  x: number,
  size: number,
  sunk = false,
): { readonly x: number; readonly y: number } => {
  const half = size / 2;
  const cx = Math.min(Math.max(x, edge.x1 + half * 0.5), edge.x2 - half * 0.5);
  return {
    x: Math.round(cx - half),
    y: Math.round(edge.y - size * FOOT_SHARE + (sunk ? size * PEEK_SHARE : 0)),
  };
};

/**
 * Where she lands when he lets go, read from the window's top-left and her own size, never the window's reported size:
 * Windows can hand back a window grown by a screen's scale factor, and her feet must still land on the edge.
 */
export const dropAt = (
  edges: ReadonlyArray<Edge>,
  at: { readonly x: number; readonly y: number },
  size: number,
): { readonly edge: Edge; readonly x: number; readonly spot: Rect } => {
  const x = at.x + size / 2;
  const edge = landing(edges, x, at.y + size * FOOT_SHARE);
  return { edge, x, spot: { ...standAt(edge, x, size), width: size, height: size } };
};

/** A short walk along her edge: somewhere at least MIN_WALK away, or null when the edge is too short for one. */
export const wanderTo = (edge: Edge, x: number, random: number): number | null => {
  const lo = edge.x1 + 40;
  const hi = edge.x2 - 40;
  const options = [
    [lo, x - MIN_WALK],
    [x + MIN_WALK, hi],
  ].filter(([a, b]) => b! >= a!) as Array<[number, number]>;
  if (options.length === 0) return null;
  const total = options.reduce((s, [a, b]) => s + (b - a), 0);
  let at = random * total;
  for (const [a, b] of options) {
    if (at <= b - a) return Math.round(a + at);
    at -= b - a;
  }
  return Math.round(options.at(-1)![1]);
};

/**
 * After his window moved, closed or another took its place: the window edge she should be on now (riding along by the
 * same offset), or null when she should drop to the edge below.
 */
export const followWindow = (
  current: Edge,
  x: number,
  edges: ReadonlyArray<Edge>,
): { readonly edge: Edge; readonly x: number } | null => {
  if (current.kind !== "window") return { edge: current, x };
  const now = edges.find((e) => e.kind === "window");
  if (now === undefined) return null;
  if (now.x1 === current.x1 && now.x2 === current.x2 && now.y === current.y)
    return { edge: now, x };
  // The same window moved when its width held; another window is a fresh edge, so she drops.
  if (Math.abs(now.x2 - now.x1 - (current.x2 - current.x1)) > 2) return null;
  return { edge: now, x: x + (now.x1 - current.x1) };
};

/**
 * Where she goes when the window he is in changes. She rides along with her window, drops when it goes, and, unless he
 * put her somewhere himself, hops up onto the window he moves to (never in Important only, where she keeps still).
 */
export const followFocus = (input: {
  readonly current: Edge;
  readonly x: number;
  readonly edges: ReadonlyArray<Edge>;
  /** He dragged her or chose a place from her menu. */
  readonly placed: boolean;
  readonly still: boolean;
}): { readonly edge: Edge; readonly x: number; readonly how: "stay" | "ride" | "hop" | "drop" } => {
  const top = input.edges.find((e) => e.kind === "window");
  const hop = !input.placed && !input.still && top !== undefined;
  const ride = followWindow(input.current, input.x, input.edges);
  if (input.current.kind === "window" && ride !== null) {
    const same = ride.edge.x1 === input.current.x1 && ride.edge.y === input.current.y;
    return { ...ride, how: same ? "stay" : "ride" };
  }
  if (hop)
    return { edge: top, x: Math.min(Math.max(input.x, top.x1 + 60), top.x2 - 60), how: "hop" };
  if (input.current.kind === "floor") return { edge: input.current, x: input.x, how: "stay" };
  return { edge: landing(input.edges, input.x, input.current.y + 1), x: input.x, how: "drop" };
};

/** How far a critically damped spring has gone by the end of a move (ωt), scaled so the last frame lands exactly. */
const SPRING_W = 7;
const springAt = (t: number) => 1 - (1 + SPRING_W * t) * Math.exp(-SPRING_W * t);

/**
 * Positions from one point to another, one per frame, along a critically damped spring: it leaves without a jolt and
 * settles in a long ease-out, the way the motion bar's references move (tessaya-ops/research/motion-bar-b3-2026-11-13).
 */
export const pathBetween = (
  from: { readonly x: number; readonly y: number },
  to: { readonly x: number; readonly y: number },
  frames: number,
): ReadonlyArray<{ readonly x: number; readonly y: number }> =>
  Array.from({ length: frames }, (_, i) => {
    const e = springAt((i + 1) / frames) / springAt(1);
    return {
      x: Math.round(from.x + (to.x - from.x) * e),
      y: Math.round(from.y + (to.y - from.y) * e),
    };
  });

/**
 * Room around her body's box on every side for her reach and effects: the halo and mood light, sparkles, a hand or a
 * lean past her outline. Her window is that much bigger and the room clicks through (bodyRect), so it costs nothing.
 */
export const ROOM_SHARE = 0.4;
const roomOf = (size: number) => Math.round(size * ROOM_SHARE);
/** Her window around her body's box (size × size at `at`). */
export const windowAround = (
  at: { readonly x: number; readonly y: number },
  size: number,
): Rect => ({
  x: Math.round(at.x) - roomOf(size),
  y: Math.round(at.y) - roomOf(size),
  width: size + 2 * roomOf(size),
  height: size + 2 * roomOf(size),
});
/**
 * Her drawing's place in the bigger window, as the stage's svg style: exactly her size, at the room's offset. The svg's
 * own sheet stretches it to the whole window (inset 0, 100%), so moving its inset alone scaled her up by the room.
 */
export const stageBodyCss = (size: number): string =>
  `left:${roomOf(size)}px;top:${roomOf(size)}px;right:auto;bottom:auto;width:${size}px;height:${size}px`;
/** Her body's box inside her window: what every placement, throw and hit test works in. */
export const bodyWithin = (window: Rect, size: number): Rect => ({
  x: window.x + roomOf(size),
  y: window.y + roomOf(size),
  width: size,
  height: size,
});

/** The silhouette inside her window that takes the mouse; everything else clicks through. */
export const bodyRect = (size: number): Rect => ({
  x: Math.round(size * 0.24),
  y: Math.round(size * 0.42),
  width: Math.round(size * 0.52),
  height: Math.round(size * (FOOT_SHARE - 0.42)),
});

/** A press let go within this long, having moved less than this far, was a poke, not a carry. */
const POKE_MS = 350;
const POKE_PX = 6;
/** His hand has not moved since he pressed: a poke, or held longer, a squish. */
export const isStill = (
  samples: ReadonlyArray<{ readonly x: number; readonly y: number }>,
): boolean => samples.every((s) => Math.hypot(s.x - samples[0]!.x, s.y - samples[0]!.y) < POKE_PX);
export const isPoke = (
  samples: ReadonlyArray<{ readonly x: number; readonly y: number; readonly t: number }>,
  pressedAt: number,
  now: number,
): boolean => now - pressedAt <= POKE_MS && isStill(samples);
/** Held still this long, she is pressed down (a squish) until he lets go or carries her. */
export const SQUISH_MS = 450;

/**
 * Petting: the cursor stroking back and forth over her body. Its sideways travel over the last 1.5 s, with at least
 * two changes of direction, adds up to a pet once it covers her body's width twice and a half.
 */
export interface Strokes {
  readonly points: ReadonlyArray<{ readonly x: number; readonly t: number }>;
}
export const stroke = (
  state: Strokes,
  x: number,
  t: number,
  bodyWidth: number,
): { readonly state: Strokes; readonly petted: boolean } => {
  const points = [...state.points.filter((p) => t - p.t <= 1500), { x, t }];
  let travel = 0;
  let turns = 0;
  for (let i = 1; i < points.length; i++) {
    const d = points[i]!.x - points[i - 1]!.x;
    travel += Math.abs(d);
    const before = i > 1 ? points[i - 1]!.x - points[i - 2]!.x : 0;
    if (d !== 0 && before !== 0 && Math.sign(d) !== Math.sign(before)) turns++;
  }
  const petted = travel >= bodyWidth * 2.5 && turns >= 2;
  return { state: { points: petted ? [] : points }, petted };
};

/**
 * His mouse over her desk body with nothing pressed (M-062): in a private moment the private body over her feels it in
 * full; otherwise only when he turned "Feels your mouse" on (off by default, so working near her never sets her off),
 * and then only as light awareness.
 */
export const deskHover = (setting: boolean, privateMoment: boolean): "full" | "light" | "off" =>
  privateMoment ? "full" : setting ? "light" : "off";

/** One spoken answer to what he does to her at a time, never over her own words or while she thinks, none within the gap. */
export const answersNow = (
  phase: string,
  asking: boolean,
  sinceLastMs: number,
  gapMs: number,
): boolean => !asking && phase !== "speaking" && phase !== "thinking" && sinceLastMs >= gapMs;

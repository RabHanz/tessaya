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
}

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
  const floors: Edge[] = input.displays.map((d) => ({
    kind: "floor",
    x1: d.workArea.x,
    x2: d.workArea.x + d.workArea.width,
    y: d.workArea.y + d.workArea.height,
    display: d.id,
  }));
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

/** The silhouette inside her window that takes the mouse; everything else clicks through. */
export const bodyRect = (size: number): Rect => ({
  x: Math.round(size * 0.24),
  y: Math.round(size * 0.42),
  width: Math.round(size * 0.52),
  height: Math.round(size * (FOOT_SHARE - 0.42)),
});

/**
 * The pill's design and colours (Settings → Appearance → Pill design, Waveform), from the approved pill-styles
 * drafts (tessaya-ops drafts/pill-styles). The pill, its cards and prompts have no colours of their own: they wear
 * the app's theme, the light or dark half on show, as `--t-<role>` on their page's root, and each design mixes its
 * look from those roles. Pure: `pillTheme.ts` reads the theme and pushes it to the windows.
 */
import type { Palette } from "../home/palette.ts";

export const PILL_DESIGNS = ["tessaya", "quiet", "lively"] as const;
export type PillDesign = (typeof PILL_DESIGNS)[number];
export const PILL_WAVES = ["match", "mound", "bars", "beads"] as const;
export type PillWave = (typeof PILL_WAVES)[number];
export type WaveName = Exclude<PillWave, "match">;

export const parsePillDesign = (v: unknown): PillDesign =>
  PILL_DESIGNS.find((d) => d === v) ?? "tessaya";
export const parsePillWave = (v: unknown): PillWave => PILL_WAVES.find((w) => w === v) ?? "match";

/** "Match the design": each design's own waveform. */
export const waveFor = (design: PillDesign, wave: PillWave): WaveName =>
  wave !== "match" ? wave : design === "quiet" ? "bars" : design === "lively" ? "beads" : "mound";

/** The app theme's roles the pill reads (packages/shared themePalettes.ts names). */
export const PILL_ROLES = [
  "canvas",
  "surfaceOverlay",
  "text",
  "textMuted",
  "accent",
  "accentForeground",
  "accentSurface",
  "accentSurfaceForeground",
  "error",
  "errorSurface",
  "warning",
  "warningSurface",
] as const;
export type PillRole = (typeof PILL_ROLES)[number];
export type PillColors = Readonly<Record<PillRole, string>>;

const half = (
  canvas: string,
  surfaceOverlay: string,
  text: string,
  textMuted: string,
  accent: string,
  accentForeground: string,
  accentSurface: string,
  error: string,
  errorSurface: string,
  warning: string,
  warningSurface: string,
): PillColors => ({
  canvas,
  surfaceOverlay,
  text,
  textMuted,
  accent,
  accentForeground,
  accentSurface,
  accentSurfaceForeground: accent,
  error,
  errorSurface,
  warning,
  warningSurface,
});

const DARK_ALERTS = ["#E0707A", "#322124", "#E8A75A", "#2f271e"] as const;
const LIGHT_ALERTS = ["#8E1F2F", "#f4e9ea", "#9a5a00", "#f5eee6"] as const;

/**
 * Tessaya's palettes as the T3 window resolves them (its environment themes, palette.ts): what the pill wears when no
 * T3 window is open to read the theme from.
 */
export const PALETTE_COLORS: Readonly<Record<Palette, { dark: PillColors; light: PillColors }>> = {
  woad: {
    dark: half(
      "#0F1B1E",
      "#1a2628",
      "#EEEDE4",
      "#a2a6a1",
      "#5FB3B3",
      "#0F1B1E",
      "#1d2c2d",
      ...DARK_ALERTS,
    ),
    light: half(
      "#EEEDE4",
      "#f7f7f3",
      "#0F1B1E",
      "#525a59",
      "#14505A",
      "#ffffff",
      "#e5eced",
      ...LIGHT_ALERTS,
    ),
  },
  damson: {
    dark: half(
      "#151019",
      "#201b24",
      "#F3EFEB",
      "#a8a3a4",
      "#BC96CE",
      "#151019",
      "#2c2732",
      ...DARK_ALERTS,
    ),
    light: half(
      "#F3EFEB",
      "#faf8f6",
      "#151019",
      "#585358",
      "#4A205E",
      "#ffffff",
      "#ebe6ed",
      ...LIGHT_ALERTS,
    ),
  },
  madder: {
    dark: half(
      "#1C1517",
      "#272021",
      "#F4EEE3",
      "#aba49e",
      "#E0707A",
      "#1C1517",
      "#322124",
      ...DARK_ALERTS,
    ),
    light: half(
      "#F4EEE3",
      "#faf7f2",
      "#1C1517",
      "#5d5654",
      "#8E1F2F",
      "#ffffff",
      "#f3e6e8",
      ...LIGHT_ALERTS,
    ),
  },
};

/** The T3 window's CSS variable for a role (apps/web themePalette.ts APP_THEME_VARIABLES). */
export const t3Variable = (role: PillRole): string =>
  `--app-theme-${role.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;

/** A theme colour from a custom theme is his data: only a plain CSS colour goes into a style. */
export const safeColour = (v: unknown): v is string =>
  typeof v === "string" && /^[#a-zA-Z0-9(). ,%/+-]{3,80}$/.test(v.trim());

/** What the T3 window showed: its dark or light half, and the roles it resolved. */
export interface T3Theme {
  readonly dark: boolean;
  readonly colors: Readonly<Record<string, unknown>>;
}

/** A read T3 theme's roles, each one that is not a plain colour taken from the fallback. */
export const colorsFrom = (read: Readonly<Record<string, unknown>>, fallback: PillColors) =>
  Object.fromEntries(
    PILL_ROLES.map((role) => {
      const v = read[role];
      return [role, safeColour(v) ? v.trim() : fallback[role]];
    }),
  ) as PillColors;

export interface PillLook {
  readonly design: PillDesign;
  readonly wave: WaveName;
  readonly dark: boolean;
  readonly colors: PillColors;
}

/**
 * The look on show: the T3 window's theme when one was read for the half on show, else Tessaya's palette.
 * `t3` holds the last read of each half, so the pill keeps the T3 theme while its window is closed.
 */
export const resolveLook = (input: {
  readonly design: PillDesign;
  readonly wave: PillWave;
  readonly palette: Palette;
  readonly systemDark: boolean;
  readonly t3: T3Theme | null;
  readonly t3Halves: Readonly<{ dark?: PillColors; light?: PillColors }>;
}): PillLook => {
  const dark = input.t3?.dark ?? input.systemDark;
  const fallback = PALETTE_COLORS[input.palette][dark ? "dark" : "light"];
  const colors =
    input.t3 !== null
      ? colorsFrom(input.t3.colors, fallback)
      : (input.t3Halves[dark ? "dark" : "light"] ?? fallback);
  return { design: input.design, wave: waveFor(input.design, input.wave), dark, colors };
};

/** Before the theme is read: Tessaya on Woad's dark half. */
export const DEFAULT_LOOK: PillLook = {
  design: "tessaya",
  wave: "mound",
  dark: true,
  colors: PALETTE_COLORS.woad.dark,
};

/** The page's root variables: every role, and `--t-pill` (the canvas on dark, the overlay on light). */
export const lookVars = (look: PillLook): string =>
  [
    ...PILL_ROLES.map((role) => `--t-${role}:${look.colors[role]}`),
    `--t-pill:${look.dark ? look.colors.canvas : look.colors.surfaceOverlay}`,
  ].join(";");

/** Puts a look on the page's root now; `window.onLook` (if the page has one) redraws what depends on it. */
export const applyLookScript = (look: PillLook): string =>
  `(()=>{const r=document.documentElement;r.dataset.design=${JSON.stringify(look.design)};r.dataset.theme=${JSON.stringify(look.dark ? "dark" : "light")};r.dataset.wave=${JSON.stringify(look.wave)};r.style.cssText=${JSON.stringify(lookVars(look))};if(window.onLook)window.onLook();})()`;

/** The root's attributes for a page built with a look. */
export const lookAttributes = (look: PillLook): string =>
  `data-design="${look.design}" data-theme="${look.dark ? "dark" : "light"}" data-wave="${look.wave}" style="${lookVars(look)}"`;

/**
 * Each design's tokens, mixed from the theme's roles (the build spec's table). `html.frost`: Quiet over Windows 11's
 * acrylic, a thinner tint; without it Quiet is a near-solid tint, and Tessaya and Lively never use acrylic.
 */
export const LOOK_TOKENS_CSS = `
:root{--sys:"Segoe UI Variable Text","Segoe UI",-apple-system,BlinkMacSystemFont,"SF Pro Text",system-ui,sans-serif;--pop:cubic-bezier(.2,.8,.2,1);--pop-ms:300ms;--morph:cubic-bezier(.2,.8,.2,1);--morph-ms:300ms}
:root[data-design=tessaya]{--surf:color-mix(in srgb,var(--t-pill) 94%,transparent);--raised:color-mix(in srgb,var(--t-text) 9%,transparent);--raised-hi:color-mix(in srgb,var(--t-text) 15%,transparent);
 --fg:var(--t-text);--fg2:var(--t-textMuted);--pri:var(--t-accent);--on-pri:var(--t-accentForeground);--rim:color-mix(in srgb,var(--t-text) 12%,transparent);--sheen:rgba(255,255,255,.07);
 --mic:var(--t-error);--fail:var(--t-error);--fail-bg:transparent;--wave:var(--t-accent);--wave2:color-mix(in srgb,var(--t-accent) 50%,var(--t-error));--wave3:var(--t-error);
 --font:"Schibsted Grotesk",var(--sys);--said:"Newsreader",Georgia,serif;--w-cap:600;--w-ttl:700;--card-r:20px}
:root[data-design=tessaya][data-theme=light]{--sheen:rgba(255,255,255,.6)}
:root[data-design=quiet]{--surf:color-mix(in srgb,var(--t-canvas) 92%,transparent);--raised:color-mix(in srgb,var(--t-text) 12%,transparent);--raised-hi:color-mix(in srgb,var(--t-text) 18%,transparent);
 --fg:var(--t-text);--fg2:var(--t-textMuted);--pri:var(--t-text);--on-pri:var(--t-canvas);--rim:color-mix(in srgb,var(--t-text) 16%,transparent);--sheen:transparent;
 --mic:var(--t-warning);--fail:var(--t-warning);--fail-bg:transparent;--wave:var(--t-text);--wave2:var(--t-accent);--wave3:var(--t-accent);
 --font:var(--sys);--said:var(--sys);--w-cap:590;--w-ttl:700;--card-r:22px}
html.frost:root[data-design=quiet]{--surf:color-mix(in srgb,var(--t-canvas) 64%,transparent)}
html.frost:root[data-design=quiet][data-theme=light]{--surf:color-mix(in srgb,var(--t-canvas) 72%,transparent)}
:root[data-design=lively]{--surf:color-mix(in srgb,var(--t-accent) 16%,var(--t-canvas));--raised:color-mix(in srgb,var(--t-accent) 28%,var(--t-canvas));--raised-hi:var(--raised);
 --fg:var(--t-text);--fg2:var(--t-textMuted);--pri:var(--t-accent);--on-pri:var(--t-accentForeground);--rim:transparent;--sheen:transparent;
 --pc:color-mix(in srgb,var(--t-accent) 40%,var(--t-canvas));--sc:var(--t-accentSurface);--on-sc:var(--t-accentSurfaceForeground);--tc:var(--t-warningSurface);--on-tc:var(--t-warning);
 --mic:var(--t-accent);--fail:var(--t-error);--fail-bg:var(--t-errorSurface);--wave:var(--t-accent);--wave2:var(--t-warning);--wave3:var(--t-error);
 --font:"Bricolage Grotesque",var(--sys);--said:var(--font);--w-cap:700;--w-ttl:800;--card-r:24px;
 --pb-shadow:0 6px 16px -4px rgba(0,0,0,.35),0 1px 2px rgba(0,0,0,.2)}
:root[data-design=lively][data-theme=light]{--surf:color-mix(in srgb,var(--t-accent) 9%,var(--t-surfaceOverlay));--raised:color-mix(in srgb,var(--t-accent) 18%,var(--t-surfaceOverlay));
 --pc:color-mix(in srgb,var(--t-accent) 22%,var(--t-surfaceOverlay));--pb-shadow:0 6px 16px -6px rgba(0,0,0,.22),0 0 0 1px color-mix(in srgb,var(--t-accent) 14%,transparent)}
`;

/** Glyphs the drafts draw, 16 px boxes in currentColor. */
export const ICON = {
  x: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>',
  check:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3.2 8.6l3.1 3.1 6.5-7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
  copy: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="5" y="5" width="8" height="8" rx="2" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M3 10.5V4.5A1.5 1.5 0 0 1 4.5 3h6" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>',
  book: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 3.5h4a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 0 7 11.5H3zM13 3.5H9.5A1 1 0 0 0 8.5 4.5" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linejoin="round"/><path d="M11 6.2l.6 1.2 1.3.2-1 .9.3 1.3-1.2-.7-1.2.7.3-1.3-1-.9 1.3-.2z" fill="currentColor"/></svg>',
  alert:
    '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.5" fill="none"/><path d="M8 4.8v3.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/><circle cx="8" cy="11" r="1" fill="currentColor"/></svg>',
  stop: '<svg viewBox="0 0 16 16" aria-hidden="true"><rect x="4.5" y="4.5" width="7" height="7" rx="1.6" fill="currentColor"/></svg>',
} as const;

/** Lively's stickers: a wavy closed shape as a clip-path polygon, `r(t)` the radius round the circle. */
const sticker = (r: (t: number) => number): string => {
  const points: string[] = [];
  for (let i = 0; i < 72; i++) {
    const t = (i / 72) * Math.PI * 2;
    points.push(
      `${(50 + 50 * r(t) * Math.cos(t)).toFixed(2)}% ${(50 + 50 * r(t) * Math.sin(t)).toFixed(2)}%`,
    );
  }
  return `polygon(${points.join(",")})`;
};
export const STICKERS = {
  petal: sticker((t) => 0.84 + 0.16 * Math.cos(5 * t)),
  bloom: sticker((t) => 0.9 + 0.1 * Math.cos(7 * t)),
  knot: sticker((t) => 0.78 + 0.22 * Math.abs(Math.cos(2 * t)) ** 1.5),
  drop: sticker((t) => 0.86 + 0.14 * Math.cos(3 * t + Math.PI / 2)),
} as const;

/**
 * Cards and prompts beside the pill, in each design: `.card` is the surface (Tessaya 20 px corners, a hairline and a
 * sheen; Quiet 22 px and a hairline; Lively 24 px with a sticker breaking its top edge). Type is 12 / 16 / 20 only.
 * Every button hits 32 px at least, by an invisible ::before where it is drawn smaller.
 */
export const CARD_CSS = `${LOOK_TOKENS_CSS}
html,body{margin:0;background:transparent;-webkit-font-smoothing:antialiased;-webkit-user-select:none;user-select:none;cursor:default}
body{font-family:var(--font);color:var(--fg)}
:root[data-design=lively] body{font-variation-settings:"opsz" 14}
#wrap{display:inline-block;padding:6px;box-sizing:border-box}
.card{position:relative;box-sizing:border-box;border-radius:var(--card-r);background:linear-gradient(180deg,var(--sheen),transparent 42%),var(--surf);box-shadow:inset 0 0 0 .5px var(--rim),0 2px 6px rgba(0,0,0,.18);padding:14px 12px 14px 16px;color:var(--fg)}
:root[data-design=lively] .card{background:var(--surf);box-shadow:var(--pb-shadow);padding:16px}
:root[data-design=lively] .card.stk{padding:26px 16px 16px!important;margin-top:14px}
.w-copy{width:330px}.w-short{width:290px}.w-err{width:330px}
:root[data-design=quiet] .w-copy{width:310px}:root[data-design=quiet] .w-short{width:270px}:root[data-design=quiet] .w-err{width:300px}
:root[data-design=lively] .w-err{width:320px}
.hd{display:flex;align-items:center;gap:10px}
.grow{flex:1;min-width:0}
.gl{flex:none;display:grid;place-items:center;width:18px;height:18px;color:var(--pri)}.gl svg{width:16px;height:16px}
.gl.fail{color:var(--fail)}.gl.alt{color:var(--pri)}
:root[data-design=quiet] .gl,:root[data-design=lively] .gl{display:none}
.lbl{font-size:12px;font-weight:var(--w-cap);color:var(--fg2);letter-spacing:.02em}
:root[data-design=quiet] .lbl{letter-spacing:0}
.lbl.fail{color:var(--fail)}
:root[data-design=tessaya] .lbl.fail{color:var(--fg2)}
.ttl{font-size:20px;font-weight:var(--w-ttl);letter-spacing:-.015em;line-height:25px}
.sec{font-size:16px;font-weight:400;line-height:21px;color:var(--fg2)}
.said{font-family:var(--said);font-size:16px;line-height:22px;font-weight:400}
:root[data-design=tessaya] .said{font-size:20px;line-height:26px;font-weight:420;letter-spacing:-.005em}
:root[data-design=lively] .said{line-height:23px}
.clip{display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
.one{display:block;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
:root[data-design=tessaya] .one.said{font-size:16px;line-height:21px}
:root[data-design=lively] .one{color:var(--fg)}
.body{margin:8px 4px 12px 0}
:root[data-design=quiet] .body{margin:4px 6px 12px 0}
:root[data-design=lively] .body{margin:4px 2px 14px}
.acts{display:flex;gap:6px;justify-content:flex-end;align-items:center}
:root[data-design=quiet] .acts{gap:4px}
.b{position:relative;display:inline-flex;align-items:center;justify-content:center;gap:6px;box-sizing:border-box;min-height:32px;padding:0 14px;border:0;border-radius:16px;font:var(--w-cap) 16px/1 var(--font);color:var(--fg);background:var(--raised);white-space:nowrap;cursor:pointer;transition:border-radius .2s var(--pop),transform .2s var(--pop)}
.b svg{width:15px;height:15px;display:none}
.b:hover{background:var(--raised-hi)}.b:active{border-radius:8px;transform:scale(.97)}
.b.pri{background:var(--pri);color:var(--on-pri)}
.b.txt{background:none;color:var(--fg2)}
.b:focus{outline:none}.b:focus-visible{outline:2px solid var(--pri);outline-offset:2px}
.b:disabled{opacity:.45}
:root[data-design=quiet] .b{min-height:30px;border-radius:999px}:root[data-design=quiet] .b::before{content:"";position:absolute;inset:-1px -2px}
:root[data-design=quiet] .b:active{border-radius:999px;transform:scale(.95)}:root[data-design=quiet] .b.txt{padding:0 8px}
:root[data-design=lively] .b{height:34px;padding:0 16px;border-radius:11px;font-weight:750;background:var(--pri);color:var(--on-pri)}
:root[data-design=lively] .b svg{display:block}
:root[data-design=lively] .b:active{border-radius:17px;transform:scale(.95)}
:root[data-design=lively] .b.ton{background:var(--sc);color:var(--on-sc)}
:root[data-design=lively] .b.txt{background:none;color:var(--pri);padding:0 10px}
:root[data-design=quiet] .b.undo{background:none;color:var(--fg2);padding:0 8px}
:root[data-design=lively] .b.undo{background:none;color:var(--pri);padding:0 10px}
.ic{position:relative;flex:none;display:grid;place-items:center;width:26px;height:26px;border:0;border-radius:13px;background:none;color:var(--fg2);padding:0;cursor:pointer;transition:border-radius .2s var(--pop),transform .2s var(--pop)}
.ic::before{content:"";position:absolute;inset:-4px}
.ic svg{width:13px;height:13px}
.ic:hover{background:var(--raised);color:var(--fg)}.ic:active{border-radius:7px;transform:scale(.92)}
.ic:focus{outline:none}.ic:focus-visible{outline:2px solid var(--pri)}
:root[data-design=quiet] .ic{width:24px;height:24px;border-radius:50%}:root[data-design=quiet] .ic::before{inset:-5px;border-radius:50%}
:root[data-design=quiet] .ic svg{width:12px;height:12px}:root[data-design=quiet] .ic:hover{background:none}
:root[data-design=lively] .ic{width:32px;height:32px;color:var(--fg2)}:root[data-design=lively] .ic::before{inset:0}:root[data-design=lively] .ic svg{width:15px;height:15px}
:root[data-design=lively] .ic:hover{background:none}
.ok{display:grid;place-items:center;width:28px;height:26px;border-radius:9px;background:var(--pri);color:var(--on-pri)}.ok svg{width:13px;height:13px}
:root[data-design=quiet] .ok{width:24px;height:24px;border-radius:50%}:root[data-design=quiet] .ok svg{width:12px;height:12px}
:root[data-design=lively] .ok{width:34px;height:34px;border-radius:12px;box-shadow:var(--pb-shadow)}:root[data-design=lively] .ok svg{width:15px;height:15px}
.copied{display:inline-flex;align-items:center;gap:8px;height:30px;padding:0 14px 0 4px;border-radius:15px;background:linear-gradient(180deg,var(--sheen),transparent 42%),var(--surf);box-shadow:inset 0 0 0 .5px var(--rim);font-size:12px;font-weight:var(--w-cap)}
:root[data-design=quiet] .copied{height:28px;border-radius:14px;padding:0 14px 0 2px}
:root[data-design=lively] .copied{height:auto;padding:0;gap:6px;background:none;box-shadow:none}
:root[data-design=lively] .copied>span:not(.ok){display:flex;align-items:center;height:34px;padding:0 12px;border-radius:12px;background:var(--surf);box-shadow:var(--pb-shadow)}
.sticker{display:none}
:root[data-design=lively] .sticker{position:absolute;left:14px;top:-16px;display:grid;place-items:center;width:40px;height:40px;background:var(--pc);color:var(--fg);transform:rotate(-8deg);filter:drop-shadow(0 3px 4px rgba(0,0,0,.25))}
.sticker svg{width:18px;height:18px;transform:rotate(8deg)}
.sticker.s2{background:var(--tc);color:var(--on-tc)}.sticker.s3{background:var(--fail-bg);color:var(--fail)}.sticker.s4{background:var(--sc);color:var(--on-sc)}
/* Entrances, once per card. Reduced motion keeps the colours and drops the movement. */
:root[data-design=tessaya] .card,:root[data-design=tessaya] .copied{animation:inT .32s var(--pop) both}
@keyframes inT{from{opacity:0;transform:translateY(6px)}}
:root[data-design=quiet] .card,:root[data-design=quiet] .copied{animation:inQ .3s ease-out both;transform-origin:50% 100%}
@keyframes inQ{from{opacity:0;transform:scale(.94);filter:blur(4px)}}
:root[data-design=lively] .card{animation:tilt .56s cubic-bezier(.3,.7,.4,1) both;transform-origin:50% 100%}
:root[data-design=lively] .sticker{animation:stick .6s cubic-bezier(.3,.7,.4,1) .12s both}
:root[data-design=lively] .copied>*{animation:squash .52s cubic-bezier(.3,.7,.4,1) both}:root[data-design=lively] .copied>span{animation-delay:80ms}
@keyframes tilt{0%{opacity:0;transform:translateY(18px) rotate(-3deg) scale(.9)}60%{opacity:1;transform:translateY(-3px) rotate(.8deg) scale(1.015)}100%{transform:none}}
@keyframes stick{0%{opacity:0;transform:rotate(-40deg) scale(.4)}65%{opacity:1;transform:rotate(-4deg) scale(1.12)}100%{transform:rotate(-8deg)}}
@keyframes squash{0%{opacity:0;transform:scale(.3)}55%{opacity:1;transform:scale(1.14,.86)}78%{transform:scale(.96,1.05)}100%{transform:none}}
@media (prefers-reduced-motion:reduce){.card,.copied,.copied>*,.sticker{animation:none!important}.b,.ic{transition:none}}
`;

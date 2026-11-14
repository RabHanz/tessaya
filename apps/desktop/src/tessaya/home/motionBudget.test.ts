import { describe, expect, it } from "vite-plus/test";

import { APP_CSS, STAGGER_BLOCKS, STAGGER_ROWS } from "./appStyle.ts";

const css = APP_CSS.replace(/url\([^)]*\)/g, "url()");
const rules = [...css.matchAll(/([^{}@]+)\{([^{}]*)\}/g)].map((m) => ({
  selector: m[1]!.trim(),
  body: m[2]!,
}));

describe("the window's motion is cheap and bounded", () => {
  it("animates only transform and opacity in every keyframe", () => {
    const frames = [...css.matchAll(/@keyframes ([\w-]+)\{((?:[^{}]*\{[^{}]*\})+)\}/g)];
    expect(frames.length).toBeGreaterThan(6);
    for (const [, name, body] of frames) {
      const props = [...body!.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1]);
      expect(
        props.filter((p) => !["transform", "opacity"].includes(p!)),
        `@keyframes ${name}`,
      ).toEqual([]);
    }
  });

  it("transitions only transform and opacity, apart from the two known one-shot grid transitions", () => {
    for (const { selector, body } of rules) {
      for (const t of body.matchAll(/transition:([^;]*)/g)) {
        for (const part of t[1]!.split(/,(?![^(]*\))/)) {
          const property = part.trim().split(/\s+/)[0]!.replace("!important", "");
          expect(
            ["transform", "opacity", "grid-template-columns", "grid-template-rows", "none"],
            `${selector}: ${property}`,
          ).toContain(property);
        }
      }
    }
  });

  it("starts every animation behind html.live, except the reduced-motion fallbacks", () => {
    const ungated = rules.filter(
      (r) =>
        /(?:^|;)animation:/.test(r.body) &&
        !r.selector.startsWith("html.live") &&
        !/^html\.motion-|^\*$/.test(r.selector),
    );
    expect(ungated.map((r) => r.selector)).toEqual([]);
  });

  it("repeats one animation only: the mark's breathing, and its closer breath only while the pointer is on it", () => {
    const endless = rules.filter((r) => /animation:[^;]*infinite/.test(r.body));
    expect(endless.map((r) => r.selector)).toEqual([
      "html.live .brand #mark",
      "html.live .brand #mark:hover,html.live .aboutmark:hover",
    ]);
    expect(css.match(/will-change:/g)?.length ?? 0).toBeLessThanOrEqual(2);
  });

  it("caps what starts together: ten blocks and eight rows on a page, twelve sidebar rows at first run", () => {
    expect(STAGGER_BLOCKS + STAGGER_ROWS).toBeLessThanOrEqual(20);
    const caps = [...css.matchAll(/:nth-child\(-n\+(\d+)\)/g)].map((m) => Number(m[1]));
    expect(Math.max(...caps)).toBeLessThanOrEqual(12);
    // Anything past the cap does not animate: delays are written only up to it.
    const delays = [...css.matchAll(/#page\.enter>\*:nth-child\((\d+)\)\{animation-delay/g)].map(
      (m) => Number(m[1]),
    );
    expect(Math.max(...delays)).toBe(STAGGER_BLOCKS);
  });

  it("puts backdrop blur on a few large static surfaces and never on a list or a scroller", () => {
    const blurred = rules.filter((r) => /backdrop-filter:/.test(r.body)).map((r) => r.selector);
    expect(blurred.length).toBeLessThanOrEqual(8);
    for (const s of blurred)
      expect(s, s).not.toMatch(
        /#panel|#page|\.group|\.log|\.row|\.pallist|#mbody|#navlist|\.stats/,
      );
  });

  it("falls back to solid surfaces when glass is reduced, off, or the system asks for less transparency", () => {
    expect(css).toMatch(/html\.glass-reduced,html\.glass-off\{[^}]*--blur:none/);
    expect(css).toMatch(/prefers-reduced-transparency:reduce\)\{:root\{[^}]*--blur:none/);
    expect(css).toMatch(/html\.motion-reduced \*,html\.motion-off \*\{animation:none!important/);
  });
});

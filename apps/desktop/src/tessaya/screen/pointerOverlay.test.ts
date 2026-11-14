// @effect-diagnostics nodeBuiltinImport:off
import * as NodeVM from "node:vm";

import { describe, expect, it } from "vite-plus/test";

import { OVERLAY_DOCUMENT } from "./pointerOverlay.ts";

describe("the overlay page", () => {
  it("has a script that parses, since a stray escape only shows at run time", () => {
    const script = /<script>([\s\S]*)<\/script>/.exec(OVERLAY_DOCUMENT)?.[1] ?? "";
    expect(script.length).toBeGreaterThan(500);
    expect(() => new NodeVM.Script(script)).not.toThrow();
  });

  it("never repaints on its own: nothing loops, and reduced motion stills the rest", () => {
    expect(OVERLAY_DOCUMENT).not.toMatch(/infinite/);
    const calm = OVERLAY_DOCUMENT.slice(
      OVERLAY_DOCUMENT.indexOf("@media (prefers-reduced-motion:reduce)"),
    );
    expect(calm).toContain("#trail{display:none}");
  });

  it("keeps the Woad tokens as variables, and draws nothing round the control: a pointer and words only", () => {
    expect(OVERLAY_DOCUMENT).toContain("--tz-dye:#14505A");
    expect(OVERLAY_DOCUMENT).toContain("--tz-glow:#5FB3B3");
    expect(OVERLAY_DOCUMENT).not.toMatch(/#ring|#bd|dashed|\.mk\b/);
  });
});

describe("the step card", () => {
  it("has buttons that report by id, a waiting state, an error state and a finished state, and a bubble", () => {
    expect(OVERLAY_DOCUMENT).toContain("baton:card:act:");
    for (const state of ["waiting", "error", "done"])
      expect(OVERLAY_DOCUMENT).toContain(`#card.${state}`);
    expect(OVERLAY_DOCUMENT).toContain("window.bubble=");
    expect(OVERLAY_DOCUMENT).toContain("<kbd>Esc</kbd> stops");
  });
});

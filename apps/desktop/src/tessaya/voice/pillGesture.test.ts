import { describe, expect, it } from "vite-plus/test";

import { CLICK_MS, CLICK_PX, isPillClick } from "./pillGesture.ts";
import { PILL_DOCUMENT } from "./voicePill.ts";

describe("a click on the pill", () => {
  it("is a quick press that barely moved, as his log's nine 0 to 1 px drags were", () => {
    expect(isPillClick(0, 1, 120)).toBe(true);
    expect(isPillClick(1, 1, 399)).toBe(true);
  });
  it("is not a drag past 4 px or a long hold", () => {
    expect(isPillClick(CLICK_PX, 0, 100)).toBe(false);
    expect(isPillClick(0, 0, CLICK_MS)).toBe(false);
    expect(isPillClick(6, 6, 100)).toBe(false);
  });
  it("is what the page runs, and the page script parses", () => {
    const script = PILL_DOCUMENT.split("<script>")[1]!.split("</script>")[0]!;
    expect(script.replace(/\s+/g, "")).toContain("Math.hypot(dx,dy)<4&&ms<400");
    expect(() => new Function(script)).not.toThrow();
  });
});

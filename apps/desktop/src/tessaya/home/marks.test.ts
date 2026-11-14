import { describe, expect, it } from "vite-plus/test";

import { openState } from "./pageStates.ts";

/** Writes what the page holds where the test can read it. */
const probe = (page: Awaited<ReturnType<typeof openState>>, expr: string) => {
  page.exec(
    `{ const e = document.getElementById('probe') || document.createElement('div'); e.id = 'probe'; e.textContent = String(${expr}); document.body.appendChild(e); }`,
  );
  return page.textOf("probe");
};

describe("the mark as a button", () => {
  it("keeps the keyboard focus on the mark when Enter plays it and the sidebar is redrawn", async () => {
    const page = await openState("empty");
    page.exec("document.getElementById('mark').focus(); playMark('side');");
    expect(probe(page, "document.activeElement && document.activeElement.id")).toBe("mark");
    // It plays: the sting where the page has one, else the deep breath.
    expect(
      probe(page, "stingUntil > Date.now() ? stingAt : deepUntil > Date.now() ? deepAt : 'none'"),
    ).toBe("side");
    expect(page.errors).toEqual([]);
  });
  it("is not offered as a button when motion is off, because pressing it would do nothing", async () => {
    const page = await openState("empty");
    expect(probe(page, "document.getElementById('mark').getAttribute('role')")).toBe("button");
    page.exec("document.documentElement.className = 'motion-off'; render();");
    expect(probe(page, "document.getElementById('mark').getAttribute('role')")).toBe("null");
  });
});

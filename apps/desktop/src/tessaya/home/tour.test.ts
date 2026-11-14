import { describe, expect, it } from "vite-plus/test";

import { SETUP_STEPS } from "../setup/firstRun.ts";
import { APP_SCRIPT } from "./appScript.ts";
import { openWindowPage } from "./fakeDom.ts";

const status = { label: "Listening", tone: "good", device: "", mark: "" };
const open = (mode: string, step: number) =>
  openWindowPage(APP_SCRIPT, {
    status,
    controls: [],
    extra: { setup: { mode, step, steps: SETUP_STEPS, hold: "F9" } },
  });
/** The page's own step and window, written where the test can read them. */
const probe = (page: Awaited<ReturnType<typeof open>>) => {
  page.exec(
    "{ const e = document.getElementById('probe') || document.createElement('div'); e.id = 'probe'; e.textContent = setupStep + ' ' + modal; document.body.appendChild(e); }",
  );
  return page.textOf("probe");
};

describe("the tour", () => {
  it("reopens where it was left, also on an install that answered the offer", async () => {
    const page = await open("none", 3);
    page.exec("tourStart()");
    expect(probe(page)).toBe("3 setup");
    expect(page.textOf("mbody")).toContain(`Step 4 of ${SETUP_STEPS.length}`);
  });
  it("closes on Esc or the backdrop without losing the place or being marked done", async () => {
    const page = await open("offer", 3);
    page.exec("tourStart()");
    page.exec("closeModal()");
    expect(probe(page)).toBe("3 null");
    expect(page.errors).toEqual([]);
  });
});

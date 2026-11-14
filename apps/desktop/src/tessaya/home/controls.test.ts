import { describe, expect, it } from "vite-plus/test";

import type { FakeElement } from "./fakeDom.ts";
import { openState, STATES } from "./pageStates.ts";
import { SETTINGS, TABS } from "./tabs.ts";

const MODALS = [...SETTINGS.map((s) => s.id), "setup"];
const HANDLERS = ["onclick", "onchange", "oninput", "onkeydown", "onsubmit", "onmousedown"];

/** What an element does when used, from the way the page script wired it. */
const wired = (e: FakeElement): boolean => {
  const own = e as unknown as Record<string, unknown>;
  // A submit button works through its form.
  for (let up = e.parent; up !== null; up = up.parent)
    if (
      up.tagName.toLowerCase() === "form" &&
      typeof (up as unknown as Record<string, unknown>)["onsubmit"] === "function"
    )
      return true;
  return (
    HANDLERS.some((h) => typeof own[h] === "function") ||
    [...e.listeners.values()].some((l) => l.length > 0) ||
    e.attrs.has("href")
  );
};
const isControl = (e: FakeElement): boolean =>
  ["button", "a", "input", "select", "textarea"].includes(e.tagName.toLowerCase()) ||
  /\b(ibtn|toggle|switch)\b/.test(e.className) ||
  ["button", "switch", "checkbox", "radio", "tab", "menuitem"].includes(e.attrs.get("role") ?? "");
const describe_ = (e: FakeElement) =>
  `<${e.tagName.toLowerCase()} class="${e.className}"${e.attrs.has("aria-label") ? ` aria-label="${e.attrs.get("aria-label")}"` : ""}>${e.textContent.slice(0, 30)}`;

/** A control that does nothing must say why: disabled with a title or label. */
const reasoned = (e: FakeElement): boolean =>
  (e.disabled || e.attrs.get("aria-disabled") === "true") &&
  (e.attrs.has("title") || e.attrs.has("aria-label") || e.textContent.length > 0);

describe("every control on every page and dialog does something or says why not", () => {
  it("has a handler, or is disabled with a stated reason", async () => {
    const dead = new Set<string>();
    for (const name of Object.keys(STATES)) {
      const page = await openState(name);
      const sweep = () => {
        for (const e of page.elements())
          if (isControl(e) && !wired(e) && !reasoned(e)) dead.add(describe_(e));
      };
      sweep();
      for (const { id } of TABS) {
        page.show(id);
        sweep();
      }
      for (const m of MODALS) {
        page.openModal(m);
        sweep();
        page.closeModal();
      }
    }
    expect([...dead]).toEqual([]);
  });
});

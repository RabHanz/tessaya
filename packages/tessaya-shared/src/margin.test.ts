import { describe, expect, it } from "vite-plus/test";

import { announceRoute } from "./margin.ts";
import { toolReach } from "./trust.ts";

const base = {
  priority: "normal" as const,
  private: true,
  dueAt: null,
  now: 1_000_000,
  quiet: false,
  vessel: "tessel-1",
  othersThere: false,
};

describe("announceRoute", () => {
  it.each([
    ["he is alone by a speaker", {}, "speak"],
    ["low priority", { priority: "low" as const }, "card"],
    ["quiet hours", { quiet: true }, "card"],
    ["nowhere near a speaker", { vessel: null }, "card"],
    ["private with a guest there", { othersThere: true }, "card"],
    ["not private with a guest there", { othersThere: true, private: false }, "speak"],
    ["due in an hour", { dueAt: 1_000_000 + 3_600_000 }, "card"],
    ["due a minute ago", { dueAt: 1_000_000 - 60_000 }, "speak"],
  ])("%s", (_name, change, action) => {
    expect(announceRoute({ ...base, ...change }).action).toBe(action);
  });
});

describe("The Margin's reach", () => {
  it("an add or tick is everyday; his own things there need him, the shared lists do not", () => {
    expect(toolReach("margin_write", { tool: "capture" })).toBe("home");
    expect(toolReach("margin_read", { tool: "list_shopping_items" })).toBe("home");
    expect(toolReach("margin_read", { tool: "get_my_week" })).toBe("personal");
  });
});

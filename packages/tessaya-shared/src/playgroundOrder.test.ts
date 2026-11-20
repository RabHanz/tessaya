import { describe, expect, it } from "vite-plus/test";

import { EVERYDAY, modelOrder } from "./playgroundOrder.ts";

describe("the playground's first model", () => {
  const worn = {
    id: "her:freya",
    name: "Lilac",
    from: "his",
    url: "/tessaya/layer/companion/body/public/freya",
  };
  const library = { id: "lib:1", name: "Studio", from: "his", url: "/x" };

  it("opens his last-used model first, then his layer's in its order, and never Everyday while he has one", () => {
    expect(modelOrder([worn, library], "lib:1")).toEqual([library, worn]);
    expect(modelOrder([worn, library], null)).toEqual([worn, library]);
    expect(modelOrder([worn, library], "gone")).not.toContainEqual(EVERYDAY);
  });

  it("falls back to the CC0 Everyday only when nothing of his exists", () => {
    expect(modelOrder([], "anything")).toEqual([EVERYDAY]);
  });
});

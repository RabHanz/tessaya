import { describe, expect, it } from "vite-plus/test";

import { modelOrder } from "./playgroundOrder.ts";

describe("the playground's first model", () => {
  const worn = {
    id: "her:freya",
    name: "Lilac",
    from: "his",
    url: "/tessaya/layer/companion/body/public/freya",
  };
  const library = { id: "lib:1", name: "Studio", from: "his", url: "/x" };

  it("opens his last-used model first, then his layer's in its order", () => {
    expect(modelOrder([worn, library], "lib:1")).toEqual([library, worn]);
    expect(modelOrder([worn, library], null)).toEqual([worn, library]);
    expect(modelOrder([worn, library], "gone")).toEqual([worn, library]);
  });

  it("offers no stock body when nothing of his exists", () => {
    expect(modelOrder([], "anything")).toEqual([]);
  });
});

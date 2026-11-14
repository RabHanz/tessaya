import { describe, expect, it } from "vite-plus/test";

import { changedFrom } from "./jsonStore.ts";

describe("changedFrom", () => {
  it("keeps only what he changed, so a new default is not frozen into his file", () => {
    const defaults = { model: "a", output: "spoken", volume: 1 };
    expect(changedFrom({ model: "a", output: "written", volume: 1 }, defaults)).toEqual({
      output: "written",
    });
  });
});

import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_ROUTING, parseRouting } from "./costRouting.ts";

describe("cost routing", () => {
  it("reads his cheap model over the default and ignores anything that is not a model name", () => {
    expect(DEFAULT_ROUTING.cheap).toBe("haiku");
    expect(parseRouting('{"strong":"sonnet","cheap":"sonnet"}')).toEqual({ cheap: "sonnet" });
    expect(parseRouting('{"cheap":"x y"}')).toEqual(DEFAULT_ROUTING);
    expect(parseRouting("not json")).toEqual(DEFAULT_ROUTING);
    expect(parseRouting(undefined)).toEqual(DEFAULT_ROUTING);
  });
});

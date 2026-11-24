import { expect, it } from "vite-plus/test";

import { privateHits } from "./guard-private.mjs";

it("finds private names in text bound for the release home", () => {
  expect(privateHits("version: 0.1.190\npath: Tessaya-0.1.190-x64.exe")).toEqual([]);
  expect(privateHits("built on hetzner at 100.64.1.2")).toEqual([
    "a cloud provider's name used as a machine",
    "a tailnet address",
  ]);
});

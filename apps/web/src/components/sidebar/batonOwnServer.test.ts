import { expect, it } from "vite-plus/test";

import { ownServerOf } from "./batonOwnServer";

it("is this app's own server even when a linked one registered first", () => {
  // The desktop's phone inbox went to the first connection, a peer without hands-host (2026-11-08).
  expect(ownServerOf(["e-box", "e-laptop"], "e-laptop")).toBe("e-laptop");
  expect(ownServerOf(["e-box"], "e-laptop")).toBe("e-box");
  expect(ownServerOf([], null)).toBeUndefined();
});

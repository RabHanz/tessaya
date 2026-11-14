import { expect, it } from "vite-plus/test";

import { envOf } from "./envOf.ts";

const names = ["TESSAYA_X_TEST", "BATON_X_TEST"];

it("reads the TESSAYA_ name first, then the old BATON_ one", () => {
  using _env = {
    [Symbol.dispose]: () => names.forEach((n) => delete process.env[n]),
  };
  expect(envOf("X_TEST")).toBeUndefined();
  process.env["BATON_X_TEST"] = "old";
  expect(envOf("X_TEST")).toBe("old");
  process.env["TESSAYA_X_TEST"] = "new";
  expect(envOf("X_TEST")).toBe("new");
  // An env object of its own (a child's, or the host's from HostProcess) reads the same way.
  expect(envOf("X_TEST", { BATON_X_TEST: "old" })).toBe("old");
  expect(envOf("X_TEST", { BATON_X_TEST: "old", TESSAYA_X_TEST: "new" })).toBe("new");
});

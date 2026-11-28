import { assert, describe, it } from "@effect/vitest";

import { announceAccess } from "./TessayaAnnounceRoutes.ts";

describe("announceAccess", () => {
  it("lets only an announce token push, never another session", () => {
    assert.isNull(announceAccess(new Set(["tessaya:announce"])));
    assert.strictEqual(announceAccess(null)?.status, 401);
    assert.strictEqual(
      announceAccess(new Set(["orchestration:operate", "settings:write"]))?.status,
      403,
    );
  });
});

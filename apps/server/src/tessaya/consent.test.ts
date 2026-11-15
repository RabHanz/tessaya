import { stands, standingKey } from "@t3tools/tessaya-shared/consent";
import { OWNER_MEMBER_ID } from "@t3tools/tessaya-shared/household";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { describe, expect } from "vite-plus/test";

import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { Consent, hisOwnTurn, layer as consentLayer, readGrants, setGrant } from "./consent.ts";
import { layerMemory } from "./TessayaDatabase.ts";

describe("one consent store", () => {
  it.effect("an Always allow given once holds on every vessel for him, never for a guest", () =>
    Effect.gen(function* () {
      const key = standingKey("job_schedule", "It runs by itself later.");
      yield* setGrant(key, true);
      const keys = yield* readGrants;
      const owner = { member: OWNER_MEMBER_ID };
      const verified = { kind: "owner", personId: "owner", verified: true };
      // His Tessel turn with his voice verified (or held for the session), and his own desktop, phone and web.
      for (const origin of [
        { kind: "device", hisVoice: true, speaker: verified, ...owner },
        { kind: "desktop", ...owner },
        { kind: "phone", ...owner },
        { kind: "web", ...owner },
      ])
        expect(stands(keys, key, { his: hisOwnTurn(origin) })).toBe(true);
      // A guest on the Tessel, his own voice unverified at his desk, and an agent are asked.
      for (const origin of [
        { kind: "device", hisVoice: false, speaker: { kind: "guest" }, member: null },
        { kind: "desktop", hisVoice: false, speaker: { ...verified, verified: false }, ...owner },
        { kind: "mcp", ...owner },
      ])
        expect(stands(keys, key, { his: hisOwnTurn(origin) })).toBe(false);
      // Revoked in Settings: asked again.
      expect(yield* setGrant(key, false)).toEqual([]);
      expect(yield* readGrants).toEqual([]);
    }).pipe(Effect.provide(layerMemory)),
  );

  it.effect(
    "reads and writes his yeses on Tessaya's database beside upstream's SqlClient (the room's runners)",
    () =>
      Effect.gen(function* () {
        const consent = yield* Consent;
        const key = standingKey("project_add", "It would add a project to this computer.");
        // Upstream's database is the ambient SqlClient here, and has no fabric_settings table.
        const upstream = Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }));
        expect(yield* upstream(consent.set(key, true))).toEqual([key]);
        expect(yield* upstream(consent.read)).toEqual([key]);
        expect(
          yield* upstream(
            Effect.flatMap(SqlClient.SqlClient, (sql) =>
              Effect.exit(sql`SELECT 1 FROM fabric_settings`),
            ),
          ),
        ).toMatchObject({ _tag: "Failure" });
      }).pipe(Effect.provide(Layer.provideMerge(consentLayer, layerMemory))),
  );
});

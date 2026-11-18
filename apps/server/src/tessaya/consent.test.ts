import { LOOK_GRANT, stands, standingKey } from "@t3tools/tessaya-shared/consent";
import { OWNER_MEMBER_ID } from "@t3tools/tessaya-shared/household";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { describe, expect } from "vite-plus/test";

import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import {
  Consent,
  CONSENT_KEY,
  hisOwnTurn,
  holds,
  layer as consentLayer,
  readGrants,
  readScoped,
  setGrant,
} from "./consent.ts";
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
    "his look allowed once on the Tessel holds for every later ask that knows him, never a guest's or an unverified voice",
    () =>
      Effect.gen(function* () {
        // His voice held from earlier in the talk (A1): Voice ID knows him, but not on this turn's audio.
        const tessel = {
          kind: "device",
          id: "r1-desk",
          hisVoice: false,
          speaker: { kind: "owner", personId: "owner", verified: true, inherited: true },
          member: OWNER_MEMBER_ID,
          assurance: 1,
        };
        expect(yield* holds(LOOK_GRANT, tessel)).toBe(false);
        // He answers Always allow on the first ask.
        yield* setGrant(LOOK_GRANT, true, { member: OWNER_MEMBER_ID });
        for (let ask = 0; ask < 3; ask++) expect(yield* holds(LOOK_GRANT, tessel)).toBe(true);
        // A guest's voice, his own unverified (A0), and a turn that read outside content are still asked.
        expect(
          yield* holds(LOOK_GRANT, { ...tessel, speaker: { kind: "guest" }, member: null }),
        ).toBe(false);
        expect(yield* holds(LOOK_GRANT, { ...tessel, assurance: 0 })).toBe(false);
        expect(yield* holds(LOOK_GRANT, { ...tessel, tainted: true })).toBe(false);
        // Revoked (Settings, or "stop letting you look at my screen"): asked again.
        yield* setGrant(LOOK_GRANT, false);
        expect(yield* holds(LOOK_GRANT, tessel)).toBe(false);
      }).pipe(Effect.provide(layerMemory)),
  );

  it.effect("a grant scoped to one device or with an end holds only there and until then", () =>
    Effect.gen(function* () {
      const key = standingKey("job_schedule", "It runs by itself later.");
      const desk = { kind: "device", id: "r1-desk", member: OWNER_MEMBER_ID, assurance: 2 };
      yield* setGrant(key, true, { device: "r1-desk", until: 60_000 });
      expect(yield* holds(key, desk)).toBe(true);
      expect(yield* holds(key, { ...desk, id: "r1-kitchen" })).toBe(false);
      yield* TestClock.adjust("2 minutes");
      expect(yield* holds(key, desk)).toBe(false);
      expect(yield* readGrants).toEqual([]);
      // An older store's bare keys (the desktop's migrated Always allows) are his, everywhere.
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE fabric_settings SET value = ${JSON.stringify([LOOK_GRANT])} WHERE key = ${CONSENT_KEY}`;
      expect(yield* readScoped).toEqual([{ key: LOOK_GRANT, member: OWNER_MEMBER_ID }]);
      expect(yield* holds(LOOK_GRANT, { ...desk, id: "r1-kitchen" })).toBe(true);
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

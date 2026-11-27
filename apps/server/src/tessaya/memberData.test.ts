import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { expect } from "vite-plus/test";

import { destroyOf, exportOf, MEMBER_DATA, NOT_PERSONAL, releaseOf } from "./memberData.ts";
import { layerMemory as SqlitePersistenceMemory } from "./TessayaDatabase.ts";

const MEMBERISH = /member|person(?!a)|speaker|caller|^who$|by_whom/;

it.effect(
  "every member-keyed column the migrations make is exported and destroyed, or says why not",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const tables = yield* sql<{ name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'tessaya_%' OR name LIKE 'fabric_%')`;
      const found: Array<string> = [];
      for (const { name } of tables)
        for (const col of yield* sql<{ name: string }>`SELECT name FROM pragma_table_info(${name})`)
          if (MEMBERISH.test(col.name)) found.push(`${name}.${col.name}`);
      const covered = new Set([
        ...MEMBER_DATA.map((t) => `${t.table}.${t.column}`),
        ...Object.keys(NOT_PERSONAL),
      ]);
      expect(found.filter((c) => !covered.has(c)).join(" ")).toBe("");
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

it.effect(
  "a member's export holds only theirs; destroying it keeps what the home keeps, unsigned, and touches no one else",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const at = "2026-11-27T00:00:00.000Z";
      // The owner's row is the migration's own.
      yield* sql`INSERT INTO tessaya_household_members (id, name, role, created_at, profile_links_json)
        VALUES ('maya', 'Maya', 'adult', ${at}, ${JSON.stringify([{ home: "Mum's", member: "m-1" }])})`;
      for (const id of ["maya", "owner"]) {
        yield* sql`INSERT INTO tessaya_comms_consent (target, caller, state, set_by, since)
          VALUES (${`person:${id}`}, 'kitchen', 'allow', ${id}, ${at})`;
      }
      yield* sql`INSERT INTO tessaya_room_transcript (at, vessel, conversation, role, who, text)
        VALUES (1, 'kitchen', 'c', 'them', 'maya', 'my bike lock code is 4512')`;
      yield* sql`INSERT INTO fabric_devices (id, kind, name, via, manifest, updated_at, member)
        VALUES ('maya-phone', 'phone', 'Maya phone', 'app', '{}', 1, 'maya')`;

      const mine = yield* exportOf(sql, "maya");
      expect(mine["tessaya_household_members"]?.map((r) => r["id"])).toEqual(["maya"]);
      expect(mine["tessaya_comms_consent"]?.map((r) => r["target"])).toEqual(["person:maya"]);
      expect(mine["tessaya_room_transcript"]).toHaveLength(1);
      expect(mine["fabric_devices"]).toHaveLength(1);
      expect(mine["tessaya_household_members"]?.[0]?.["profile_links_json"]).toContain("Mum's");

      // Removal: what reaches her ends at once; her data waits for the window.
      yield* releaseOf(sql, "maya");
      expect((yield* exportOf(sql, "maya"))["tessaya_comms_consent"]).toEqual([]);
      expect((yield* exportOf(sql, "maya"))["fabric_devices"]).toEqual([]);
      expect((yield* exportOf(sql, "maya"))["tessaya_room_transcript"]).toHaveLength(1);
      expect(
        (yield* exportOf(sql, "maya"))["tessaya_household_members"]?.[0]?.["profile_links_json"],
      ).toBeNull();

      yield* destroyOf(sql, "maya");
      expect(Object.values(yield* exportOf(sql, "maya")).every((rows) => rows.length === 0)).toBe(
        true,
      );
      const left = yield* exportOf(sql, "owner");
      expect(left["tessaya_household_members"]).toHaveLength(1);
      expect(left["tessaya_comms_consent"]).toHaveLength(1);
    }).pipe(Effect.provide(SqlitePersistenceMemory)),
);

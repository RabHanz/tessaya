// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { rosterMoves } from "@t3tools/baton-shared/osPack";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as ServerConfig from "../../../config.ts";
import { PACK_DIR_NAME, readPackFiles } from "../../../baton/OperatingSystemPack.ts";

/**
 * The 14 Nov roster (PERSONA-TEAM-DESIGN §1): Onyx takes `engineering`, Alfred moves to `butler`, Freya to
 * `companion`, Sebastian to `alter-ego`. Records keyed by persona id follow each face by name (`rosterMoves`), so
 * nothing of Alfred's lands on Onyx. Not additive (a reviewed exception): rows are re-keyed, never deleted, and a
 * build from before only stops seeing those personas' own items.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const userdata = Option.isNone(config) ? null : NodePath.dirname(config.value.dbPath);
  const { ids, files } = rosterMoves(userdata === null ? {} : readPackFiles(userdata).roles);
  for (const [from, to] of ids) {
    const episode = `conversation:${from}:`;
    yield* sql`UPDATE fabric_memory_items SET persona = ${to} WHERE persona = ${from}`;
    yield* sql`
      UPDATE fabric_memory_items
      SET source_ref = ${`conversation:${to}:`} || substr(source_ref, ${episode.length + 1})
      WHERE substr(source_ref, 1, ${episode.length}) = ${episode}
    `;
    yield* sql`UPDATE fabric_job_terms SET persona = ${to} WHERE persona = ${from}`;
    yield* sql`
      UPDATE fabric_job_terms SET part_spec_json = json_set(part_spec_json, '$.role', ${to})
      WHERE json_valid(part_spec_json) AND json_extract(part_spec_json, '$.role') = ${from}
    `;
    yield* sql`
      UPDATE tessaya_member_preferences SET value = ${to} WHERE key = 'persona' AND value = ${from}
    `;
  }
  if (userdata === null) return;
  const roles = NodePath.join(userdata, PACK_DIR_NAME, "roles");
  for (const [from, to] of files) {
    const failed = yield* Effect.sync(() => {
      try {
        NodeFS.renameSync(NodePath.join(roles, `${from}.md`), NodePath.join(roles, `${to}.md`));
        return null;
      } catch (cause) {
        return String(cause);
      }
    });
    if (failed !== null)
      yield* Effect.logWarning("persona roster: a pack file was not moved", { from, to, failed });
  }
});

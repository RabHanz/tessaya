import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Identity decision 1: a home that already had private stores, every one open to its owner, keeps that rule; a new home
 * starts sealed. Only a mark here: `HouseholdSettings.keepOwnersRule` turns it into the setting once.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT OR IGNORE INTO fabric_settings (key, value)
    SELECT 'household.ownerOpenedBefore', 'on'
    WHERE EXISTS (SELECT 1 FROM tessaya_private_stores)
  `;
});

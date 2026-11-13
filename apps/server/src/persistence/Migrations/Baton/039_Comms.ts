import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Comms (tessaya-ops research/COMMS-DESIGN.md C-0): notes and their receipts per person and vessel, calls with one row
 * per leg, drop-in consent, and per-leg call quality (numbers only, never audio). Additive.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS tessaya_comms_notes (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      from_member TEXT,
      from_label TEXT NOT NULL,
      from_vessel TEXT,
      to_json TEXT NOT NULL,
      text TEXT NOT NULL,
      forms_json TEXT NOT NULL,
      urgency TEXT NOT NULL,
      private INTEGER NOT NULL DEFAULT 0,
      reply_to TEXT,
      tag TEXT,
      audio TEXT,
      created_at TEXT NOT NULL,
      deliver_at TEXT,
      expires_at TEXT
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS tessaya_comms_notes_created ON tessaya_comms_notes (created_at)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS tessaya_comms_receipts (
      note_id TEXT NOT NULL,
      person TEXT NOT NULL DEFAULT '',
      vessel TEXT NOT NULL DEFAULT '',
      state TEXT NOT NULL,
      at TEXT NOT NULL,
      PRIMARY KEY (note_id, person, vessel)
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS tessaya_comms_receipts_person ON tessaya_comms_receipts (person, state)`;
  yield* sql`
    CREATE TABLE IF NOT EXISTS tessaya_comms_calls (
      id TEXT PRIMARY KEY,
      mode TEXT NOT NULL,
      host TEXT,
      host_label TEXT NOT NULL,
      to_json TEXT NOT NULL,
      started_at TEXT NOT NULL,
      ended_at TEXT,
      end_reason TEXT
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS tessaya_comms_legs (
      call_id TEXT NOT NULL,
      vessel TEXT NOT NULL,
      person TEXT,
      state TEXT NOT NULL,
      muted INTEGER NOT NULL DEFAULT 0,
      joined_at TEXT,
      left_at TEXT,
      PRIMARY KEY (call_id, vessel)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS tessaya_comms_consent (
      target TEXT NOT NULL,
      caller TEXT NOT NULL,
      state TEXT NOT NULL,
      set_by TEXT NOT NULL,
      since TEXT NOT NULL,
      PRIMARY KEY (target, caller)
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS tessaya_comms_quality (
      call_id TEXT NOT NULL,
      vessel TEXT NOT NULL,
      at INTEGER NOT NULL,
      rtt_ms REAL,
      jitter_ms REAL,
      loss_pct REAL,
      underruns INTEGER,
      mouth_to_ear_ms REAL,
      mos REAL
    )
  `;
  yield* sql`CREATE INDEX IF NOT EXISTS tessaya_comms_quality_at ON tessaya_comms_quality (at)`;
});

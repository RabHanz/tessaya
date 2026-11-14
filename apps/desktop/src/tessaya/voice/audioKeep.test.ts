/* oxlint-disable t3code/no-wall-clock-in-tests -- Baton file predating the rule (D82) */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalRandom:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_KEEP,
  planRetention,
  runRetention,
  saveClip,
  saveGate,
  spaceUsed,
} from "./audioKeep.ts";
import { openHistory } from "./history.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-01T12:00:00Z");

describe("retention", () => {
  it("deletes old clips, keeps corrected ones up to the cap, oldest corrected first when over", () => {
    const clip = (name: string, daysOld: number, bytes: number, corrected: boolean) => ({
      path: name,
      at: NOW - daysOld * DAY,
      bytes,
      corrected,
    });
    const plan = planRetention(
      [
        clip("new", 2, 10, false),
        clip("old", 40, 10, false),
        clip("fix-old", 90, 600, true),
        clip("fix-mid", 60, 600, true),
        clip("fix-new", 5, 600, true),
      ],
      NOW,
      { ...DEFAULT_KEEP, capBytes: 1_300 },
    );
    expect(plan.map((c) => c.path)).toEqual(["old", "fix-old"]);
  });
});

describe("saving", () => {
  it("is off by default, pauses on a nearly full drive, and otherwise writes the clip", () => {
    expect(saveGate(DEFAULT_KEEP, 100 * 1024 ** 3)).toMatchObject({ ok: false });
    const on = { ...DEFAULT_KEEP, enabled: true };
    expect(saveGate(on, 4 * 1024 ** 3)).toMatchObject({
      ok: false,
      reason: expect.stringContaining("paused"),
    });
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "keep-"));
    const saved = saveClip({
      dir,
      id: "a",
      bytes: new Uint8Array(100),
      at: new Date("2026-11-01T00:00:00Z"),
      keep: on,
      freeBytes: 20 * 1024 ** 3,
    });
    expect(saved.path).toBe(NodePath.join(dir, "2026-11", "a.webm"));
    expect(spaceUsed(dir)).toBe(100);
    expect(
      saveClip({ dir, id: "b", bytes: new Uint8Array(1), at: new Date(), keep: on, freeBytes: 1 })
        .path,
    ).toBeNull();
  });

  it("the daily job deletes the file and unlinks the turn, sparing a corrected clip", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "keep-"));
    const history = openHistory(":memory:");
    const make = (name: string, at: string, corrected: boolean) => {
      const path = NodePath.join(dir, name);
      NodeFS.writeFileSync(path, "x");
      const id = history.add({
        at,
        kind: "dictation",
        app: "",
        raw: name,
        cleaned: null,
        status: "none",
        model: null,
        delivery: null,
        error: null,
        audio: path,
      });
      if (corrected) history.update(id, { corrected: true });
      return { id, path };
    };
    const stale = make("stale.webm", "2026-09-01T00:00:00Z", false);
    const fix = make("fix.webm", "2026-09-01T00:00:00Z", true);
    expect(runRetention({ history, now: NOW, keep: { ...DEFAULT_KEEP, enabled: true } })).toBe(1);
    expect(NodeFS.existsSync(stale.path)).toBe(false);
    expect(history.get(stale.id)?.audio).toBeNull();
    expect(NodeFS.existsSync(fix.path)).toBe(true);
  });
});

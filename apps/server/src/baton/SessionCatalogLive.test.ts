// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { readKeptFile, scanTranscriptTimes } from "./SessionCatalogLive.ts";

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const DAY = 24 * 60 * 60_000;

describe("scanTranscriptTimes", () => {
  it("looks again only at new, recent or running transcripts until the next full pass", async () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scan-"));
    const folder = NodePath.join(home, "projects", "-work");
    NodeFS.mkdirSync(folder, { recursive: true });
    const file = (n: number) => NodePath.join(folder, `${ID(n)}.jsonl`);
    const now = 1_793_000_000_000;
    const at = (n: number, ms: number) => {
      NodeFS.writeFileSync(file(n), "{}\n", { flag: "a" });
      NodeFS.utimesSync(file(n), ms / 1000, ms / 1000);
    };
    try {
      at(1, now - 3 * DAY);
      at(2, now - 3 * DAY);
      const first = await scanTranscriptTimes([home], new Set(), null, now);
      const mtimeOf = (scan: Awaited<ReturnType<typeof scanTranscriptTimes>>, n: number) =>
        scan.folders.get(folder)?.files.get(`${ID(n)}.jsonl`);

      // Both old transcripts written to again (appending leaves the folder's mtime alone); only 2's session runs.
      at(1, now);
      at(2, now);
      const folderTime = NodeFS.statSync(folder).mtimeMs / 1000;
      NodeFS.utimesSync(folder, folderTime, folderTime);
      const second = await scanTranscriptTimes([home], new Set([ID(2)]), first, now + 60_000);
      expect(mtimeOf(second, 1)).toBe(mtimeOf(first, 1));
      expect(mtimeOf(second, 2)).toBe(now);

      // A new transcript moves the folder's mtime, so it is listed again.
      at(3, now);
      NodeFS.utimesSync(folder, (now + 1_000) / 1000, (now + 1_000) / 1000);
      const third = await scanTranscriptTimes([home], new Set(), second, now + 120_000);
      expect(mtimeOf(third, 3)).toBe(now);

      // The full pass every ten minutes catches the rest.
      const full = await scanTranscriptTimes([home], new Set(), third, now + 11 * 60_000);
      expect(mtimeOf(full, 1)).toBe(now);
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });
  it("lets the event loop run while it scans (14 Nov: a full pass blocked it 3 to 4 s every 10 minutes)", async () => {
    const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "scan-"));
    try {
      for (let f = 0; f < 40; f += 1) {
        const folder = NodePath.join(home, "projects", `-work-${f}`);
        NodeFS.mkdirSync(folder, { recursive: true });
        for (let n = 0; n < 5; n += 1)
          NodeFS.writeFileSync(NodePath.join(folder, `${ID(n)}.jsonl`), "{}\n");
      }
      let turns = 0;
      let scanning = true;
      const spin = () => {
        if (!scanning) return;
        turns += 1;
        setImmediate(spin);
      };
      setImmediate(spin);
      const scan = await scanTranscriptTimes([home], new Set(), null, 1_793_000_000_000);
      scanning = false;
      expect(scan.folders.size).toBe(40);
      expect(turns).toBeGreaterThan(1);
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("the kept-messages file", () => {
  it("reads, is empty when missing, and moves a corrupt or wrong-shaped file aside", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "kept-"));
    const file = NodePath.join(dir, "kept.json");
    try {
      expect(readKeptFile(file)).toEqual({ kept: {}, problem: null });
      NodeFS.writeFileSync(file, JSON.stringify({ s1: ["hello"] }));
      expect(readKeptFile(file)).toEqual({ kept: { s1: ["hello"] }, problem: null });
      for (const bad of ["{not json", JSON.stringify({ s1: [1] })]) {
        NodeFS.writeFileSync(file, bad);
        const read = readKeptFile(file);
        expect(read.kept).toEqual({});
        expect(read.problem).toMatch(/moved to/);
        expect(NodeFS.existsSync(file)).toBe(false);
      }
      // Unreadable (here a directory where the file should be) is moved aside too, not left to fail every start.
      NodeFS.mkdirSync(file);
      expect(readKeptFile(file).problem).toMatch(/could not be read; moved to/);
      expect(NodeFS.existsSync(file)).toBe(false);
      expect(NodeFS.readdirSync(dir).filter((n) => n.includes(".bad-"))).toHaveLength(3);
    } finally {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });
});

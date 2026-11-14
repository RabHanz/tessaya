// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off globalJsonInEffect:off
/**
 * The pack's one owner is the household's home server (SPINE-UNIFY §10, P4). This server, when it has a home, keeps a
 * working copy in step (planPackSync): his edits here go to the home, the home's changes come back, the home wins a
 * file both changed, and a file the home overwrites on first contact is kept aside in `.pack-before-sync/`.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  packFileFits,
  packHash,
  packPathSyncs,
  planPackSync,
  type PackBase,
  type PackFiles,
} from "@t3tools/tessaya-shared/packSync";
import * as Effect from "effect/Effect";

import { homeLink } from "./TessayaHousehold.ts";

const BASE_FILE = ".sync-base.json";
const ASIDE_DIR = ".pack-before-sync";

/** Every file of the pack that syncs, by its path inside the pack folder. */
export const readPackFiles = (dir: string): PackFiles => {
  const out: Record<string, string> = {};
  const walk = (rel: string) => {
    let entries: NodeFS.Dirent[] = [];
    try {
      entries = NodeFS.readdirSync(NodePath.join(dir, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const path = rel === "" ? e.name : `${rel}/${e.name}`;
      if (e.isDirectory()) walk(path);
      else if (e.isFile() && packPathSyncs(path)) {
        try {
          const text = NodeFS.readFileSync(NodePath.join(dir, path), "utf8");
          if (packFileFits(text)) out[path] = text;
        } catch {
          // unreadable: left out, so it is neither sent nor overwritten
        }
      }
    }
  };
  walk("");
  return out;
};

const writeFile = (dir: string, path: string, text: string | null) => {
  const file = NodePath.join(dir, path);
  if (text === null) {
    NodeFS.rmSync(file, { force: true });
    return;
  }
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(`${file}.tmp`, text);
  NodeFS.renameSync(`${file}.tmp`, file);
};

/**
 * The home's end of a push: written only when the home's file is still the one the pusher last saw (`base`, null
 * for a file the pusher never had from here), so a change made at the home in between is never lost.
 */
export const acceptPackPush = (
  dir: string,
  path: string,
  text: string | null,
  base: string | null,
): { readonly ok: true } | { readonly refused: string } => {
  if (!packPathSyncs(path)) return { refused: "That file is not part of the pack." };
  if (text !== null && !packFileFits(text)) return { refused: "That file is too large." };
  const now = readPackFiles(dir)[path];
  if ((now === undefined ? null : packHash(now)) !== base && now !== text)
    return { refused: "The home's copy changed; it comes back on the next sync." };
  writeFile(dir, path, text);
  return { ok: true };
};

const readBase = (dir: string): PackBase => {
  try {
    const v = JSON.parse(NodeFS.readFileSync(NodePath.join(dir, BASE_FILE), "utf8")) as unknown;
    return typeof v === "object" && v !== null ? (v as PackBase) : {};
  } catch {
    return {};
  }
};

/** One round with the home server; nothing when this server has no home. Returns how many files moved each way. */
export const syncPackWithHome = Effect.fn("TessayaPack.sync")(function* (dir: string) {
  const home = yield* homeLink;
  if (home === null) return null;
  const call = (init: RequestInit) =>
    Effect.tryPromise({
      try: async (signal) => {
        const r = await fetch(new URL("/api/tessaya/pack", home.url), {
          ...init,
          headers: {
            ...init.headers,
            authorization: `Bearer ${home.token}`,
            "content-type": "application/json",
          },
          signal,
        });
        return { ok: r.ok, body: (await r.json().catch(() => ({}))) as Record<string, unknown> };
      },
      catch: () => "unreachable" as const,
    }).pipe(Effect.timeout("20 seconds"));
  const got = yield* call({ method: "GET" });
  const files = got.body["files"];
  if (!got.ok || typeof files !== "object" || files === null) return null;
  const base = readBase(dir);
  const here = readPackFiles(dir);
  const plan = planPackSync(base, here, files as PackFiles);
  const next: Record<string, string> = { ...plan.base };
  let pushed = 0;
  for (const p of plan.push) {
    const sent = yield* call({
      method: "PUT",
      body: JSON.stringify({ path: p.path, text: p.text, base: base[p.path] ?? null }),
    }).pipe(Effect.orElseSucceed(() => ({ ok: false, body: {} })));
    if (sent.ok) pushed += 1;
    // Not taken: the base stays as it was, so the next round plans this file again.
    else if (base[p.path] === undefined) delete next[p.path];
    else next[p.path] = base[p.path]!;
  }
  yield* Effect.sync(() => {
    for (const p of plan.pull) {
      const mine = here[p.path];
      // First contact with a file both had: his copy is kept aside, never lost.
      if (mine !== undefined && base[p.path] === undefined)
        writeFile(NodePath.join(dir, ASIDE_DIR), p.path, mine);
      writeFile(dir, p.path, p.text);
    }
    writeFile(dir, BASE_FILE, `${JSON.stringify(next)}\n`);
  });
  return { pushed, pulled: plan.pull.length };
});

// @effect-diagnostics nodeBuiltinImport:off
/**
 * The 14 Nov roster on this computer (the server's migration 41 does its database): each old default face's files
 * follow it by name, so Alfred's conversation, his user jobs and his nameless pack edits leave `engineering` (now
 * Onyx's) for `butler`. Runs once; a marker file says it ran.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { rosterMoves } from "@t3tools/tessaya-shared/osPack";

import { writeJsonFile } from "../writing/jsonStore.ts";
import { PACK_FOLDER } from "./packRows.ts";

const MARKER = "tessaya-roster-2.done";

const rolesIn = (dir: string): Record<string, string> => {
  const roles: Record<string, string> = {};
  let names: string[] = [];
  try {
    names = NodeFS.readdirSync(dir).filter((n) => n.endsWith(".md"));
  } catch {
    // no roles of his own
  }
  for (const name of names)
    roles[name.slice(0, -3)] = NodeFS.readFileSync(NodePath.join(dir, name), "utf8");
  return roles;
};

/** What it moved, in words for the lifecycle log. */
export const moveRoster = (stateDir: string): ReadonlyArray<string> => {
  const marker = NodePath.join(stateDir, MARKER);
  if (NodeFS.existsSync(marker)) return [];
  const rolesDir = NodePath.join(stateDir, PACK_FOLDER, "roles");
  const { ids, files } = rosterMoves(rolesIn(rolesDir));
  const moved: string[] = [];
  const move = (from: string, to: string) => {
    if (!NodeFS.existsSync(from) || NodeFS.existsSync(to)) return;
    NodeFS.renameSync(from, to);
    moved.push(`${NodePath.basename(from)} -> ${NodePath.basename(to)}`);
  };
  for (const [from, to] of files)
    move(NodePath.join(rolesDir, `${from}.md`), NodePath.join(rolesDir, `${to}.md`));
  const conversation = NodePath.join(stateDir, "conversation");
  for (const [from, to] of ids)
    for (const ext of [".ndjson", ".ndjson.1"])
      move(
        NodePath.join(conversation, `${from}${ext}`),
        NodePath.join(conversation, `${to}${ext}`),
      );
  const jobsFile = NodePath.join(stateDir, "user-jobs.json");
  try {
    const saved = JSON.parse(NodeFS.readFileSync(jobsFile, "utf8")) as { jobs?: unknown };
    if (Array.isArray(saved.jobs)) {
      const jobs = saved.jobs.map((job: { owner?: unknown }) => {
        const to = typeof job?.owner === "string" ? ids.get(job.owner) : undefined;
        return to === undefined ? job : { ...job, owner: to };
      });
      if (jobs.some((job, i) => job !== (saved.jobs as unknown[])[i])) {
        writeJsonFile(jobsFile, { ...saved, jobs });
        moved.push("user-jobs.json owners");
      }
    }
  } catch {
    // no jobs of his own, or a damaged file the store keeps aside on its next read
  }
  NodeFS.writeFileSync(marker, `${JSON.stringify(Object.fromEntries(ids))}\n`);
  return moved;
};

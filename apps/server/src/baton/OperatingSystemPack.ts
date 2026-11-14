// @effect-diagnostics nodeBuiltinImport:off
/**
 * Reads the user's own operating-system pack from `<userdata>/operating-system/` (D148): `executive.md`
 * and `roles/<name>.md`. The folder is theirs; nothing here writes to it, and nothing in the repository
 * or the installer contains a pack.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { parseRouting, type Routing } from "@t3tools/baton-shared/costRouting";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import { mergePack, packPrompt, type OsPack } from "@t3tools/baton-shared/osPack";

export const PACK_DIR_NAME = "operating-system";
const MAX_FILE_BYTES = 64 * 1024;

const readText = (file: string): string | undefined => {
  try {
    return NodeFS.statSync(file).size > MAX_FILE_BYTES
      ? undefined
      : NodeFS.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
};

export const readPack = (userdata: string): OsPack => {
  const dir = NodePath.join(userdata, PACK_DIR_NAME);
  let names: string[] = [];
  try {
    names = NodeFS.readdirSync(NodePath.join(dir, "roles"));
  } catch {
    // no roles folder: the defaults stand
  }
  const roles: Record<string, string> = {};
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const text = readText(NodePath.join(dir, "roles", name));
    if (text !== undefined) roles[name.slice(0, -3)] = text;
  }
  const executive = readText(NodePath.join(dir, "executive.md"));
  return mergePack({ ...(executive === undefined ? {} : { executive }), roles });
};

/** The pack's own files as he wrote them (no defaults), so memory's door can refuse their text. */
export const packFileTexts = (userdata: string): ReadonlyArray<string> => {
  const dir = NodePath.join(userdata, PACK_DIR_NAME);
  let roles: string[] = [];
  try {
    roles = NodeFS.readdirSync(NodePath.join(dir, "roles")).filter((n) => n.endsWith(".md"));
  } catch {
    // no roles folder
  }
  return [NodePath.join(dir, "executive.md"), ...roles.map((n) => NodePath.join(dir, "roles", n))]
    .map(readText)
    .filter((text): text is string => text !== undefined);
};

/** The planning frame for a job, read fresh so an edit counts at the next job. */
export const planningFrame = (userdata: string): string => packPrompt(readPack(userdata));

/** The cost routing table, `routing.json` in the pack folder, over the default. */
export const readRouting = (userdata: string): Routing =>
  parseRouting(readText(NodePath.join(userdata, PACK_DIR_NAME, "routing.json")));

/** Her personas as this server's pack resolves them: the one registry every body reads (SPINE-UNIFY §10). */
export const personasList = Effect.gen(function* () {
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const pack = Option.isNone(config)
    ? mergePack({})
    : readPack(NodePath.dirname(config.value.dbPath));
  return { personas: pack.personas };
}).pipe(Effect.withSpan("OperatingSystemPack.personasList"));

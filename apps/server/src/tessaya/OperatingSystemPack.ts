// @effect-diagnostics nodeBuiltinImport:off
/**
 * Reads the user's own operating-system pack from `<userdata>/operating-system/` (D148): `executive.md`
 * and `roles/<name>.md`. The folder is theirs; nothing here writes to it, and nothing in the repository
 * or the installer contains a pack.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { parseRouting, type Routing } from "@t3tools/tessaya-shared/costRouting";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import { mergeTemplates, type JobTemplate } from "@t3tools/tessaya-shared/jobTemplates";
import { mergePack, packPrompt, type OsPack } from "@t3tools/tessaya-shared/osPack";
import { parseWakeStore, wakeModelOf } from "@t3tools/tessaya-shared/wakeModels";
import * as Clock from "effect/Clock";

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

/** A pack subfolder's `.md` files by stem; none when it is missing. */
const mdFiles = (dir: string): Record<string, string> => {
  let names: string[] = [];
  try {
    names = NodeFS.readdirSync(dir);
  } catch {
    // no such folder: the defaults stand
  }
  const out: Record<string, string> = {};
  for (const name of names) {
    if (!name.endsWith(".md")) continue;
    const text = readText(NodePath.join(dir, name));
    if (text !== undefined) out[name.slice(0, -3)] = text;
  }
  return out;
};

/** His own files as he wrote them, before the defaults. */
export const readPackFiles = (
  userdata: string,
): { readonly executive?: string; readonly roles: Record<string, string> } => {
  const dir = NodePath.join(userdata, PACK_DIR_NAME);
  const executive = readText(NodePath.join(dir, "executive.md"));
  return {
    ...(executive === undefined ? {} : { executive }),
    roles: mdFiles(NodePath.join(dir, "roles")),
  };
};

export const readPack = (userdata: string): OsPack => mergePack(readPackFiles(userdata));

/** The template catalogue: his `templates/<name>.md` over the defaults, read fresh so an edit counts at the next job. */
export const readTemplates = (userdata: string): ReadonlyArray<JobTemplate> =>
  mergeTemplates(mdFiles(NodePath.join(userdata, PACK_DIR_NAME, "templates")));

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

/** Her wake-word models (`wake-models.json`, kept by TessayaWake); empty when there is none yet. */
const readWakeStore = (userdata: string) => {
  try {
    return parseWakeStore(
      JSON.parse(readText(NodePath.join(userdata, PACK_DIR_NAME, "wake-models.json")) ?? "null"),
    );
  } catch {
    return parseWakeStore(null);
  }
};

/** Her personas as this server's pack resolves them: the one registry every body reads (SPINE-UNIFY §10). */
export const personasList = Effect.gen(function* () {
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const userdata = Option.isNone(config) ? null : NodePath.dirname(config.value.dbPath);
  const pack = userdata === null ? mergePack({}) : readPack(userdata);
  const store = userdata === null ? parseWakeStore(null) : readWakeStore(userdata);
  const now = yield* Clock.currentTimeMillis;
  return {
    personas: pack.personas.map((p) => ({ ...p, wakeModel: wakeModelOf(p.wake, store, now) })),
  };
}).pipe(Effect.withSpan("OperatingSystemPack.personasList"));

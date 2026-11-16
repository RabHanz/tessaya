// @effect-diagnostics nodeBuiltinImport:off
/**
 * Hiring, editing, copying, retiring and restoring personas: the one registry is his pack's role files (personaFile),
 * which every body already reads. Settings, the composer and her voice tool all come through `changePersona`.
 */
import * as NodePath from "node:path";

import type {
  TessayaPersonaChangeInput,
  TessayaPersonaChangeResult,
  TessayaPersonaDraft,
} from "@t3tools/tessaya-contracts";
import {
  createPersona,
  draftProblem,
  duplicatePersona,
  editPersona,
  retiredPersonas,
  setRetired,
} from "@t3tools/tessaya-shared/personaFile";
import { commercialBuild, isLibraryVoice } from "@t3tools/tessaya-shared/voiceLibrary";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import { PACK_DIR_NAME, readPack } from "./OperatingSystemPack.ts";
import { changeGroup, HIS_GROUP } from "./GroupTalk.ts";
import { TessayaVoiceLibrary } from "./TessayaVoiceLibrary.ts";

/**
 * `owner` is his own turn (verified voice or his keyboard) or an owner's settings session: only then may a private
 * persona be made, changed, copied or retired, or a persona made private.
 */
export const changePersona = Effect.fn("PersonaChanges.change")(function* (
  input: TessayaPersonaChangeInput,
  who: { readonly owner: boolean },
) {
  const config = yield* ServerConfig.ServerConfig;
  const userdata = config.stateDir;
  const packDir = NodePath.join(userdata, PACK_DIR_NAME);
  const bin = () => retiredPersonas(packDir);
  const no = (error: string): TessayaPersonaChangeResult => ({ ok: false, error, bin: bin() });
  const done = (id?: string): TessayaPersonaChangeResult => ({
    ok: true,
    ...(id === undefined ? {} : { id }),
    bin: bin(),
  });
  if (input.op === "bin") return done();
  if (input.op === "group") {
    const changed = yield* changeGroup(HIS_GROUP, input.change, who);
    return { ...done(), line: changed.line, group: changed.group };
  }

  const pack = readPack(userdata);
  const known = [...pack.personas, ...bin()];
  const target =
    input.op === "create"
      ? undefined
      : known.find((p) => p.id === input.id || p.name.toLowerCase() === input.id.toLowerCase());
  if (input.op !== "create" && target === undefined) return no("There is no persona by that name.");
  const targetPrivate = pack.personas.find((p) => p.id === target?.id)?.private === true;
  if (
    !who.owner &&
    (targetPrivate ||
      (input.op !== "duplicate" && "draft" in input && input.draft.private === true))
  )
    return no("Only he can do that, in his own voice or at his keyboard.");

  const nameTaken = (name: string) =>
    known.some((p) => p.id !== target?.id && p.name.toLowerCase() === name.trim().toLowerCase());

  const checked = Effect.fnUntraced(function* (draft: TessayaPersonaDraft) {
    const problem = draftProblem(draft);
    if (problem !== null) return { problem, draft };
    if (draft.name !== undefined && nameTaken(draft.name))
      return { problem: `There is already a persona called ${draft.name.trim()}.`, draft };
    const wake = draft.wake?.trim().toLowerCase();
    if (wake && pack.personas.some((p) => p.id !== target?.id && p.wake?.toLowerCase() === wake))
      return { problem: "Another persona already wakes to that word.", draft };
    const context = { commercial: commercialBuild(process.env) };
    if (draft.voice != null && !isLibraryVoice("pocket", draft.voice.toLowerCase(), context))
      return { problem: "That voice is not in the library.", draft };
    if (
      draft.cloudVoice != null &&
      !isLibraryVoice("gemini", draft.cloudVoice.toLowerCase(), context)
    )
      return { problem: "That cloud voice is not in the library.", draft };
    if (draft.cloneVoice == null) return { problem: null, draft };
    // A clone by id or name, from the one voice library, while his consent for it stands.
    const voices = yield* Effect.serviceOption(TessayaVoiceLibrary);
    const clones = Option.isNone(voices) ? [] : ((yield* voices.value.library).clones ?? []);
    const wanted = draft.cloneVoice.trim().toLowerCase();
    const clone = clones.find((c) => c.id === wanted || c.name.toLowerCase() === wanted);
    return clone === undefined
      ? { problem: "There is no saved clone by that name.", draft }
      : { problem: null, draft: { ...draft, cloneVoice: clone.id } };
  });

  const write = (run: () => string | boolean | null) =>
    Effect.try({ try: run, catch: () => "The persona's file could not be written." }).pipe(
      Effect.map((r) =>
        r === false || r === null
          ? no("That persona cannot be changed.")
          : done(typeof r === "string" ? r : target?.id),
      ),
      Effect.catch((why) => Effect.succeed(no(why))),
    );

  switch (input.op) {
    case "create": {
      if (input.draft.name === undefined || input.draft.name.trim() === "")
        return no("Give the new persona a name.");
      const { problem, draft } = yield* checked(input.draft);
      if (problem !== null) return no(problem);
      const name = input.draft.name;
      return yield* write(() => createPersona(packDir, { ...draft, name }));
    }
    case "edit": {
      const { problem, draft } = yield* checked(input.draft);
      if (problem !== null) return no(problem);
      if (target!.id === "executive" && draft.private === true)
        return no("The lead cannot be private.");
      return yield* write(() => editPersona(packDir, target!.id, draft));
    }
    case "duplicate": {
      const problem = draftProblem({ name: input.name });
      if (problem !== null) return no(problem);
      if (nameTaken(input.name))
        return no(`There is already a persona called ${input.name.trim()}.`);
      return yield* write(() => duplicatePersona(packDir, target!.id, input.name.trim()));
    }
    case "retire":
      if (target!.id === "executive") return no("The lead cannot be retired.");
      return yield* write(() => setRetired(packDir, target!.id, true));
    case "restore":
      return yield* write(() => setRetired(packDir, target!.id, false));
  }
});

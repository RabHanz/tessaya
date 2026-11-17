// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off
/**
 * Hiring, editing, copying, retiring and restoring personas, and Character Cards in and out (characterCard): the one
 * registry is his pack's role files (personaFile), which every body already reads. Settings, the composer and her voice tool all come through `changePersona`.
 */
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type {
  TessayaPersonaChangeInput,
  TessayaPersonaChangeResult,
} from "@t3tools/tessaya-contracts";
import {
  type PersonaDraft,
  createPersona,
  draftProblem,
  duplicatePersona,
  editPersona,
  retiredPersonas,
  setRetired,
} from "@t3tools/tessaya-shared/personaFile";
import {
  cardOf,
  colourOf,
  draftFromCard,
  draftOfHire,
  HireDraft,
  hirePrompt,
  pngWithCard,
} from "@t3tools/tessaya-shared/characterCard";
import { commercialBuild, isLibraryVoice } from "@t3tools/tessaya-shared/voiceLibrary";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerConfig from "../config.ts";
import { PACK_DIR_NAME, readPack } from "./OperatingSystemPack.ts";
import { changeGroup, HIS_GROUP } from "./GroupTalk.ts";
import { TessayaOneShot } from "./TessayaOneShot.ts";
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
  const wanted = "id" in input ? input.id.toLowerCase() : undefined;
  const target =
    wanted === undefined
      ? undefined
      : known.find((p) => p.id === wanted || p.name.toLowerCase() === wanted);
  if (wanted !== undefined && target === undefined) return no("There is no persona by that name.");
  const targetPrivate = pack.personas.find((p) => p.id === target?.id)?.private === true;
  if (
    !who.owner &&
    (targetPrivate ||
      (input.op !== "duplicate" && "draft" in input && input.draft.private === true))
  )
    return no("Only he can do that, in his own voice or at his keyboard.");

  const nameTaken = (name: string) =>
    known.some((p) => p.id !== target?.id && p.name.toLowerCase() === name.trim().toLowerCase());
  /** "Luna", or "Luna 2" when Luna is already on the team. */
  const freeName = (name: string) => {
    let free = name;
    for (let n = 2; nameTaken(free); n++) free = `${name.slice(0, 36).trimEnd()} ${n}`;
    return free;
  };

  const checked = Effect.fnUntraced(function* <D extends PersonaDraft>(draft: D) {
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
    case "import": {
      const bytes = yield* cardBytes(input);
      const card =
        bytes instanceof Uint8Array || bytes.startsWith("{") ? draftFromCard(bytes) : bytes;
      if (typeof card === "string") return no(card);
      const name = freeName(card.draft.name);
      let result = yield* checked({ ...card.draft, name });
      // A voice this library lacks is left out rather than refusing the whole card.
      if (result.problem !== null && card.draft.voice !== undefined) {
        const { voice: _voice, ...rest } = card.draft;
        result = yield* checked({ ...rest, name });
      }
      if (result.problem !== null) return no(result.problem);
      const draft = result.draft;
      const made = yield* write(() => createPersona(packDir, { ...draft, name }));
      return made.ok ? { ...made, line: `${name} came from the card and is on the team.` } : made;
    }
    case "export": {
      const persona = pack.personas.find((p) => p.id === target!.id);
      if (persona === undefined) return no(`Restore ${target!.name} first, then export them.`);
      const json = cardOf({
        ...persona,
        about: persona.lead ? pack.executive : (pack.roles[persona.id] ?? ""),
      });
      const png = pngWithCard(json, colourOf(persona.name));
      const dir = NodePath.join(userdata, "exports", "personas");
      const files = [
        NodePath.join(dir, `${persona.id}.card.json`),
        NodePath.join(dir, `${persona.id}.card.png`),
      ];
      const saved = yield* Effect.try({
        try: () => {
          NodeFS.mkdirSync(dir, { recursive: true });
          NodeFS.writeFileSync(files[0]!, json);
          NodeFS.writeFileSync(files[1]!, png);
          return files;
        },
        catch: () => "not saved",
      }).pipe(Effect.orElseSucceed(() => []));
      return { ...done(persona.id), card: { json, png: png.toString("base64"), files: saved } };
    }
    case "hire": {
      const oneShot = yield* Effect.serviceOption(TessayaOneShot);
      if (Option.isNone(oneShot))
        return no("Hiring from a sentence needs her brain, and it is not on here.");
      const hire = yield* oneShot.value
        .run({
          prompt: hirePrompt(
            input.sentence,
            known.map((p) => p.name),
          ),
          outputSchema: HireDraft,
          role: "background",
          feature: "persona-hire",
        })
        .pipe(Effect.orElseSucceed(() => null));
      if (hire === null) return no("I could not draft that persona just now. Try again.");
      const drafted = draftOfHire(hire);
      const draft = { ...drafted, name: freeName(drafted.name) };
      const problem = draftProblem(draft);
      return problem === null ? { ...done(), draft } : no(problem);
    }
  }
});

const CARD_MAX = 8_000_000;

/** The card's text or bytes: as sent, from a file on this server, or from an https link (8 MB at most); else why not. */
const cardBytes = Effect.fn("PersonaChanges.cardBytes")(function* (input: {
  readonly card?: string;
  readonly source?: string;
}) {
  const card = input.card?.trim();
  if (card !== undefined && card !== "")
    return card.startsWith("{") ? card : new Uint8Array(Buffer.from(card, "base64"));
  const source = input.source?.trim() ?? "";
  if (source === "") return "Send the card, or say where it is.";
  const why = Effect.catch((reason: string) => Effect.succeed(reason));
  if (/^https:[/][/]/i.test(source))
    return yield* Effect.tryPromise({
      try: async (): Promise<Uint8Array | string> => {
        const response = await fetch(source, { signal: AbortSignal.timeout(20_000) });
        if (!response.ok || Number(response.headers.get("content-length") ?? 0) > CARD_MAX)
          return "That link did not give a card.";
        const body = new Uint8Array(await response.arrayBuffer());
        return body.length > CARD_MAX ? "That card is too big." : body;
      },
      catch: () => "That link could not be reached.",
    }).pipe(why);
  if (/^[a-z]+:[/][/]/i.test(source)) return "Only https links can be read.";
  const file = source.startsWith("~") ? NodePath.join(NodeOS.homedir(), source.slice(1)) : source;
  return yield* Effect.try({
    try: (): Uint8Array | string =>
      NodeFS.statSync(file).size > CARD_MAX
        ? "That card is too big."
        : new Uint8Array(NodeFS.readFileSync(file)),
    catch: () => `There is no card at ${source} on this server.`,
  }).pipe(why);
});

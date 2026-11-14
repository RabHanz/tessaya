// @effect-diagnostics nodeBuiltinImport:off
/**
 * The prompt lab (B-030): each persona's live prompt, his named variants of it, runs on chosen models scored side by
 * side, and promotion to live with rollback. Variants are files in his pack (`variants/<persona>/<name>.md`); promoting
 * one writes the persona's own file and keeps what was live as `previous.md`, so a rollback swaps them back. Settings,
 * the voice and `tessaya_prompt_lab` all call this one service.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { BatonPromptLabInput, BatonPromptLabResult } from "@t3tools/baton-contracts";
import { DEFAULT_PACK_FILES, splitFront } from "@t3tools/baton-shared/osPack";
import {
  DEFAULT_SCENARIOS,
  LAB_MODELS,
  labSystem,
  scoreReply,
  VARIANT_TEXT_MAX,
  variantNameProblem,
  type LabCell,
  type LabScenario,
} from "@t3tools/baton-shared/promptLab";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import { BatonOneShot } from "../baton/BatonOneShot.ts";
import { PACK_DIR_NAME, readPack } from "../baton/OperatingSystemPack.ts";

/**
 * Prompt sources another layer adds to the lab (an internal build's gated prompts). This door carries their names
 * only; their text stays with the layer that owns it.
 */
export const PromptLabSources = Context.Reference<
  ReadonlyArray<{ readonly id: string; readonly label: string }>
>("t3/tessaya/PromptLabSources", { defaultValue: () => [] });

/** Every call a run makes: variants × models × scenarios, so one ask cannot queue an hour of turns. */
const LAB_MAX_CALLS = 24;
const PREVIOUS = "previous";

export class PromptLab extends Context.Service<
  PromptLab,
  { readonly call: (input: BatonPromptLabInput) => Effect.Effect<BatonPromptLabResult> }
>()("t3/tessaya/PromptLab") {}

const Reply = Schema.Struct({ reply: Schema.String });

const make = Effect.gen(function* () {
  const oneShot = yield* BatonOneShot;
  const userdata = NodePath.dirname((yield* ServerConfig.ServerConfig).dbPath);
  const packDir = NodePath.join(userdata, PACK_DIR_NAME);
  const liveFile = (id: string) =>
    id === "executive"
      ? NodePath.join(packDir, "executive.md")
      : NodePath.join(packDir, "roles", `${id}.md`);
  const variantDir = (id: string) => NodePath.join(packDir, "variants", id);
  const read = (file: string): string | null => {
    try {
      return NodeFS.readFileSync(file, "utf8");
    } catch {
      return null;
    }
  };
  /** The faces the lab shows: a private persona's prompt is not shown here. */
  const faces = () => readPack(userdata).personas.filter((p) => p.private !== true);
  const liveOf = (id: string) =>
    read(liveFile(id)) ??
    (id === "executive" ? DEFAULT_PACK_FILES.executive : (DEFAULT_PACK_FILES.roles[id] ?? ""));
  const variantsOf = (id: string) => {
    let names: string[] = [];
    try {
      names = NodeFS.readdirSync(variantDir(id)).filter((n) => n.endsWith(".md"));
    } catch {
      // none saved yet
    }
    return names
      .map((n) => n.slice(0, -3))
      .filter((n) => n !== PREVIOUS)
      .toSorted()
      .map((name) => ({ name, text: read(NodePath.join(variantDir(id), `${name}.md`)) ?? "" }));
  };
  const write = (file: string, text: string) => {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
  };
  const said = (line: string): BatonPromptLabResult => ({ line });

  const list = Effect.fn("PromptLab.list")(function* () {
    return {
      line: "The live prompt of each persona and your variants.",
      personas: faces().map((p) => ({
        id: p.id,
        name: p.name,
        live: liveOf(p.id),
        mine: read(liveFile(p.id)) !== null,
        variants: variantsOf(p.id),
        previous: NodeFS.existsSync(NodePath.join(variantDir(p.id), `${PREVIOUS}.md`)),
      })),
      sources: yield* PromptLabSources,
      models: [...LAB_MODELS],
    } satisfies BatonPromptLabResult;
  });

  const run = Effect.fn("PromptLab.run")(function* (
    input: Extract<BatonPromptLabInput, { op: "run" }>,
    persona: { readonly id: string; readonly name: string; readonly role: string },
  ) {
    const bad = input.models.find((m) => !(LAB_MODELS as ReadonlyArray<string>).includes(m));
    if (bad !== undefined)
      return said(`${bad} is not a model the lab runs; use ${LAB_MODELS.join(", ")}.`);
    const scenarios: ReadonlyArray<LabScenario> =
      input.message === undefined || input.message.trim() === ""
        ? DEFAULT_SCENARIOS
        : [{ id: "message", said: input.message.trim() }];
    if (input.variants.length * input.models.length * scenarios.length > LAB_MAX_CALLS)
      return said(`That is more than ${LAB_MAX_CALLS} replies; try fewer variants or models.`);
    const texts = new Map<string, string>();
    for (const v of input.variants) {
      const text =
        v === "live" ? liveOf(persona.id) : read(NodePath.join(variantDir(persona.id), `${v}.md`));
      if (text === null) return said(`${persona.name} has no variant called ${v}.`);
      texts.set(v, text);
    }
    const jobs = [...texts].flatMap(([variant, text]) =>
      input.models.map((model) => ({ variant, text, model })),
    );
    const cells: ReadonlyArray<LabCell> = yield* Effect.forEach(
      jobs,
      ({ variant, text, model }) =>
        Effect.gen(function* () {
          const { fields, body } = splitFront(text);
          const system = labSystem(
            { name: persona.name, role: fields["role"] ?? persona.role },
            body,
          );
          const replies = yield* Effect.forEach(scenarios, (scenario) =>
            oneShot
              .run({ prompt: scenario.said, outputSchema: Reply, role: "voice", model, system })
              .pipe(
                Effect.map((r) => r.reply),
                Effect.catch((error) => Effect.succeed(`(no reply: ${error.detail})`)),
                Effect.map((reply) => ({
                  scenario: scenario.id,
                  reply,
                  score: scoreReply(scenario, reply),
                })),
              ),
          );
          return { variant, model, replies };
        }),
      { concurrency: 3 },
    );
    return { line: `Ran ${jobs.length} combinations on ${scenarios.length} scenarios.`, cells };
  });

  const call = Effect.fn("PromptLab.call")(function* (input: BatonPromptLabInput) {
    if (input.op === "list") return yield* list();
    const persona = faces().find(
      (p) => p.id === input.persona || p.name.toLowerCase() === input.persona.toLowerCase(),
    );
    if (persona === undefined) return said(`There is no persona ${input.persona} in the lab.`);
    const dir = variantDir(persona.id);
    switch (input.op) {
      case "save": {
        const problem = variantNameProblem(input.variant);
        if (problem !== null) return said(problem);
        if (input.text.length > VARIANT_TEXT_MAX) return said("That variant is too long.");
        write(NodePath.join(dir, `${input.variant}.md`), input.text);
        return said(`Saved ${persona.name}'s variant ${input.variant}. Nothing live changed.`);
      }
      case "delete": {
        const file = NodePath.join(dir, `${input.variant}.md`);
        if (variantNameProblem(input.variant) !== null || !NodeFS.existsSync(file))
          return said(`${persona.name} has no variant called ${input.variant}.`);
        NodeFS.renameSync(file, `${file}.bak`);
        return said(
          `Removed variant ${input.variant}; its text is kept as ${input.variant}.md.bak.`,
        );
      }
      case "run":
        return yield* run(input, persona);
      case "promote": {
        const text = read(NodePath.join(dir, `${input.variant}.md`));
        if (variantNameProblem(input.variant) !== null || text === null)
          return said(`${persona.name} has no variant called ${input.variant}.`);
        // What was live is kept for the rollback; an empty one means the shipped default was live.
        write(NodePath.join(dir, `${PREVIOUS}.md`), read(liveFile(persona.id)) ?? "");
        write(liveFile(persona.id), text);
        return said(
          `${persona.name} now runs on variant ${input.variant}. Say roll back to undo it.`,
        );
      }
      case "rollback": {
        const previousFile = NodePath.join(dir, `${PREVIOUS}.md`);
        const previous = read(previousFile);
        if (previous === null) return said(`There is nothing to roll ${persona.name} back to.`);
        const current = read(liveFile(persona.id)) ?? "";
        // A swap: rolling back again puts the promoted variant back.
        write(previousFile, current);
        if (previous.trim() === "") NodeFS.rmSync(liveFile(persona.id), { force: true });
        else write(liveFile(persona.id), previous);
        return said(
          `${persona.name} is back on what was live before. Roll back again to undo that.`,
        );
      }
    }
  });

  return PromptLab.of({ call });
});

export const layer = Layer.effect(PromptLab, make);

// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * The pack in Baton's window (D148): the executive framing, each role and the routing table as rows to
 * open and correct. They are the same files the server reads; a row that has no file yet writes the
 * neutral default into the folder first, so there is something real to edit. "Use default" deletes his
 * file, never the default.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { DEFAULT_ROUTING } from "@t3tools/tessaya-shared/costRouting";
import {
  DEFAULT_PACK_FILES,
  mergePack,
  modelOf,
  splitFront,
  type OsPack,
} from "@t3tools/tessaya-shared/osPack";
import {
  DEFAULT_TEMPLATE_FILES,
  mergeTemplates,
  type JobTemplate,
} from "@t3tools/tessaya-shared/jobTemplates";
import { setPersonaField } from "@t3tools/tessaya-shared/personaFile";
import { parseWakeStore, wakeModelOf, type WakeStore } from "@t3tools/tessaya-shared/wakeModels";
import {
  commercialBuild,
  DEFAULT_POCKET_VOICE,
  voiceLibrary,
} from "@t3tools/tessaya-shared/voiceLibrary";

import type { HomeControl } from "../home/batonHome.ts";
import { POCKET_VOICES } from "../voice/pocketVoice.ts";

export const PACK_FOLDER = "operating-system";
const NAME = /^[a-z0-9][a-z0-9-]{0,40}$/;

const fileFor = (dir: string, id: string): string | null => {
  if (id === "executive") return NodePath.join(dir, "executive.md");
  if (id === "routing") return NodePath.join(dir, "routing.json");
  const m = /^(role|template):(.+)$/.exec(id);
  return m !== null && NAME.test(m[2]!)
    ? NodePath.join(dir, m[1] === "role" ? "roles" : "templates", `${m[2]}.md`)
    : null;
};

const defaultText = (id: string): string =>
  id === "executive"
    ? DEFAULT_PACK_FILES.executive
    : id === "routing"
      ? JSON.stringify(DEFAULT_ROUTING, null, 2)
      : id.startsWith("template:")
        ? (DEFAULT_TEMPLATE_FILES[id.slice("template:".length)] ?? "")
        : (DEFAULT_PACK_FILES.roles[id.replace(/^role:/, "")] ?? "");

/** His template files by stem (none when the folder is missing). */
const templateFiles = (dir: string): Record<string, string> => {
  const out: Record<string, string> = {};
  let names: string[] = [];
  try {
    names = NodeFS.readdirSync(NodePath.join(dir, "templates")).filter((n) => n.endsWith(".md"));
  } catch {
    // no templates of his own
  }
  for (const name of names) {
    try {
      out[name.slice(0, -3)] = NodeFS.readFileSync(NodePath.join(dir, "templates", name), "utf8");
    } catch {
      // unreadable: the default stands
    }
  }
  return out;
};

/** The template catalogue as the server reads it: his files over the defaults, read fresh each call. */
export const readTemplates = (dir: string): ReadonlyArray<JobTemplate> =>
  mergeTemplates(templateFiles(dir));

const roleNames = (dir: string): ReadonlyArray<string> => {
  let mine: string[] = [];
  try {
    mine = NodeFS.readdirSync(NodePath.join(dir, "roles"))
      .filter((n) => n.endsWith(".md"))
      .map((n) => n.slice(0, -3));
  } catch {
    // no roles folder yet
  }
  return [
    ...new Set([...Object.keys(DEFAULT_PACK_FILES.roles), ...mine.filter((n) => NAME.test(n))]),
  ];
};

/** His pack as the server reads it: his files over the neutral default, read fresh each call. */
export const readPack = (dir: string): OsPack => {
  const text = (file: string): string | undefined => {
    try {
      return NodeFS.readFileSync(file, "utf8");
    } catch {
      return undefined;
    }
  };
  const roles: Record<string, string> = {};
  for (const name of roleNames(dir)) {
    const brief = text(NodePath.join(dir, "roles", `${name}.md`));
    if (brief !== undefined) roles[name] = brief;
  }
  const executive = text(NodePath.join(dir, "executive.md"));
  return mergePack({ ...(executive === undefined ? {} : { executive }), roles });
};

export const packControls = (dir: string): ReadonlyArray<HomeControl> => {
  const row = (id: string, label: string, hint: string): HomeControl => {
    const file = fileFor(dir, id)!;
    const mine = NodeFS.existsSync(file);
    let text = defaultText(id);
    if (mine) {
      try {
        text = NodeFS.readFileSync(file, "utf8");
      } catch {
        // Unreadable: the default shows, and saving writes a new file.
      }
    }
    return {
      id: `p.ed:${id}`,
      section: "Operating-system pack",
      label,
      hint: mine ? `${hint} Your file.` : `${hint} The neutral default; saving makes it your file.`,
      kind: "editor",
      text,
      mine,
      more: id !== "executive",
    };
  };
  return [
    row("executive", "How Tessaya frames a job", "Every plan follows it."),
    ...roleNames(dir).map((name) =>
      row(`role:${name}`, `Specialist: ${name}`, "Briefed when a part is given to it."),
    ),
    ...readTemplates(dir).map((t) =>
      row(
        `template:${t.id}`,
        `Template: ${t.title}`,
        t.kind === "job"
          ? "Loaded into a job of this kind; its persona and team are who Tessaya usually picks."
          : "A face to hire: copy it into a role file with a name of your own.",
      ),
    ),
    row(
      "routing",
      "The cheap model for routine work",
      "Rewrites and sorting run on it. Each persona's own model is in its file.",
    ),
    {
      id: "p.folder",
      section: "Operating-system pack",
      label: "Pack folder",
      hint: "To import your own document, run scripts/tessaya/import-operating-system.mjs on it; it writes here.",
      kind: "action",
      button: "Open folder",
      more: true,
    },
  ];
};

/** `p:<id>` Edit, `p:<id>:later` Use default. */
export const packAction = (id: string) => {
  const m = /^p:(executive|routing|(?:role|template):[a-z0-9-]+?)(:later)?$/.exec(id);
  return m === null ? null : ({ id: m[1]!, reset: m[2] !== undefined } as const);
};

/** The file to open: made from the default when he has none, so there is something to edit. */
export const fileToEdit = (dir: string, id: string): string | null => {
  const file = fileFor(dir, id);
  if (file === null) return null;
  if (!NodeFS.existsSync(file)) {
    NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
    NodeFS.writeFileSync(file, `${defaultText(id)}\n`, { flag: "wx" });
  }
  return file;
};

/** Back to the default: his file goes (a .bak stays), the default is untouched. */
export const useDefault = (dir: string, id: string): boolean => {
  const file = fileFor(dir, id);
  if (file === null || !NodeFS.existsSync(file)) return false;
  NodeFS.renameSync(file, `${file}.bak`);
  return true;
};

/** `p.ed:<id>:save` with the text, `p.ed:<id>:reset`. */
export const packEdit = (id: string) => {
  const m = /^p\.ed:(executive|routing|(?:role|template):[a-z0-9-]+?):(save|reset)$/.exec(id);
  return m === null ? null : ({ id: m[1]!, save: m[2] === "save" } as const);
};

export const PACK_TEXT_MAX = 40_000;

/** Null when it was saved; otherwise why not, in words for him. The routing table must stay valid JSON. */
export const savePackText = (dir: string, id: string, text: string): string | null => {
  const file = fileFor(dir, id);
  if (file === null) return "That is not a part of the pack.";
  if (text.trim() === "") return "A part of the pack cannot be empty; use the default instead.";
  if (text.length > PACK_TEXT_MAX) return "That is too long.";
  if (id === "routing") {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
        return "The routing table must be a JSON object.";
      }
    } catch {
      return "The routing table is not valid JSON, so it was not saved.";
    }
  }
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  // The file he had stays as a .bak until the next save.
  if (NodeFS.existsSync(file)) NodeFS.copyFileSync(file, `${file}.bak`);
  NodeFS.writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
  return null;
};

const fileIdOf = (personaId: string) =>
  personaId === "executive" ? personaId : `role:${personaId}`;
const capital = (word: string) => `${word[0]!.toUpperCase()}${word.slice(1)}`;

/** The roster on the Voice tab: each face, its wake word, and its voice to change or put back. */
/** His persona's wake word and whether a model wakes to it yet (the training pipeline's `wake-models.json`). */
const wakeLine = (wake: string | null, store: WakeStore) => {
  if (wake === null) return "No wake word yet: say or type the name.";
  const model = wakeModelOf(wake, store, Date.now());
  return model === "trained"
    ? `Wake word: ${wake}.`
    : `Wake word: ${wake}, ${model === "training" ? "being trained" : "not trained yet"}; until then say "switch to ${wake}".`;
};

export const rosterControls = (dir: string): ReadonlyArray<HomeControl> => {
  const pack = readPack(dir);
  let trained = parseWakeStore(null);
  try {
    trained = parseWakeStore(
      JSON.parse(NodeFS.readFileSync(NodePath.join(dir, "wake-models.json"), "utf8")),
    );
  } catch {
    // none trained here beyond the shipped words
  }
  return pack.personas.map((persona) => {
    const id = fileIdOf(persona.id);
    const model = modelOf(pack, persona.id);
    const fallback = splitFront(defaultText(id)).fields["voice"] ?? DEFAULT_POCKET_VOICE;
    let own: string | undefined;
    try {
      own = splitFront(NodeFS.readFileSync(fileFor(dir, id)!, "utf8")).fields["voice"];
    } catch {
      // no file of his: the default voice
    }
    return {
      id: `v.persona:${persona.id}`,
      section: "Personas",
      label: persona.lead ? `${persona.name} (lead)` : persona.name,
      hint: `${wakeLine(persona.wake, trained)} Thinks on ${model.model} at most, ${model.effort} effort. ${persona.role}`.trim(),
      kind: "choice",
      value: own === undefined || own === "" ? "default" : own.toLowerCase(),
      options: [
        {
          value: "default",
          label: `Default (${capital(fallback)})`,
          voice: fallback.toLowerCase(),
        },
        ...voiceLibrary("pocket", { commercial: commercialBuild(process.env) }).map((v) => ({
          value: v.id,
          label: `${v.name} (${v.gender}${v.personalUse ? ", personal use" : ""})`,
          voice: v.id,
        })),
      ],
    };
  });
};

/** A persona's voice in its own file (made from the default when he has none); null takes the line out. */
export const setPersonaVoice = (dir: string, personaId: string, voice: string | null): boolean =>
  (voice === null || (POCKET_VOICES as ReadonlyArray<string>).includes(voice)) &&
  setPersonaField(dir, personaId, "voice", voice);

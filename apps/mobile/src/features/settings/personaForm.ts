import type {
  TessayaPersona,
  TessayaPersonaChangeInput,
  TessayaPersonaDraft,
  TessayaPersonaGroup,
} from "@t3tools/tessaya-contracts";

export const DIALS = [
  ["energy", "Energy"],
  ["warmth", "Warmth"],
  ["play", "Playfulness"],
  ["expr", "Expressiveness"],
  ["formal", "Formality"],
  ["sass", "Sass"],
] as const;
type Dial = (typeof DIALS)[number][0];

export interface PersonaForm {
  readonly id: string | null;
  readonly name: string;
  readonly role: string;
  /** "he/him", "she/her", "they/them". */
  readonly pronouns: string;
  readonly about: string;
  readonly traits: Readonly<Partial<Record<Dial, number>>>;
  readonly model: string;
  readonly private: boolean;
  /** How far a private persona comes into his private rooms. */
  readonly privateRooms: "never" | "one-on-one" | "open";
  /** One greeting per line. */
  readonly greetings: string;
}

export const BLANK_PERSONA: PersonaForm = {
  id: null,
  name: "",
  role: "",
  pronouns: "",
  about: "",
  traits: {},
  model: "",
  private: false,
  privateRooms: "open",
  greetings: "",
};

/** Editing starts with an empty brief: the server keeps the current one unless he writes a new one. */
export const personaFormFor = (p: TessayaPersona): PersonaForm => ({
  id: p.id,
  name: p.name,
  role: p.role,
  pronouns: p.pronouns ?? "",
  about: "",
  traits: p.traits ?? {},
  model: p.brain?.model ?? "",
  private: p.private === true,
  privateRooms: p.privateRooms ?? "open",
  greetings: (p.greetings ?? []).join("\n"),
});

/** A drafted hire (or any draft) as an unsaved form; nothing is stored until he presses Create. */
export const personaFormOfDraft = (d: TessayaPersonaDraft): PersonaForm => ({
  ...BLANK_PERSONA,
  name: d.name ?? "",
  role: d.role ?? "",
  pronouns: d.pronouns ?? "",
  about: d.about ?? "",
  traits: d.traits ?? {},
  model: d.model ?? "",
  private: d.private === true,
  greetings: (d.greetings ?? []).join("\n"),
});

export function personaSave(f: PersonaForm): TessayaPersonaChangeInput {
  const greetings = f.greetings
    .split("\n")
    .map((g) => g.trim())
    .filter((g) => g !== "");
  const draft: TessayaPersonaDraft = {
    name: f.name.trim(),
    role: f.role,
    ...(f.pronouns.trim() === "" ? {} : { pronouns: f.pronouns.trim() }),
    ...(f.about.trim() === "" ? {} : { about: f.about }),
    traits: f.traits,
    model: f.model.trim() === "" ? null : f.model.trim(),
    private: f.private,
    ...(f.private ? { privateRooms: f.privateRooms } : {}),
    ...(f.id === null && greetings.length === 0 ? {} : { greetings }),
  };
  return f.id === null ? { op: "create", draft } : { op: "edit", id: f.id, draft };
}

type GroupChange = Extract<TessayaPersonaChangeInput, { op: "group" }>["change"];

/** A member switch: changes a live group directly; before one exists it gathers picks and starts at two. */
export function groupToggle(
  group: TessayaPersonaGroup | null,
  picked: ReadonlyArray<string>,
  id: string,
  on: boolean,
): { readonly picked: ReadonlyArray<string>; readonly change: GroupChange | null } {
  if (group !== null)
    return {
      picked,
      change: on ? { op: "add", personas: [id] } : { op: "leave", persona: id },
    };
  const next = on ? [...picked, id] : picked.filter((p) => p !== id);
  return next.length >= 2
    ? { picked: [], change: { op: "start", personas: next } }
    : { picked: next, change: null };
}

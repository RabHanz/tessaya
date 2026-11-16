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
  readonly about: string;
  readonly traits: Readonly<Partial<Record<Dial, number>>>;
  readonly model: string;
  readonly private: boolean;
}

export const BLANK_PERSONA: PersonaForm = {
  id: null,
  name: "",
  role: "",
  about: "",
  traits: {},
  model: "",
  private: false,
};

/** Editing starts with an empty brief: the server keeps the current one unless he writes a new one. */
export const personaFormFor = (p: TessayaPersona): PersonaForm => ({
  id: p.id,
  name: p.name,
  role: p.role,
  about: "",
  traits: p.traits ?? {},
  model: p.brain?.model ?? "",
  private: p.private === true,
});

export function personaSave(f: PersonaForm): TessayaPersonaChangeInput {
  const draft: TessayaPersonaDraft = {
    name: f.name.trim(),
    role: f.role,
    ...(f.about.trim() === "" ? {} : { about: f.about }),
    traits: f.traits,
    model: f.model.trim() === "" ? null : f.model.trim(),
    private: f.private,
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

import { describe, expect, it } from "vite-plus/test";

import {
  BLANK_PERSONA,
  groupToggle,
  personaFormFor,
  personaFormOfDraft,
  personaSave,
} from "./personaForm";

describe("personaSave", () => {
  it("creates with the brief and the default brain when the model is blank", () => {
    expect(personaSave({ ...BLANK_PERSONA, name: " Luna ", about: "Calm.", model: "  " })).toEqual({
      op: "create",
      draft: { name: "Luna", role: "", about: "Calm.", traits: {}, model: null, private: false },
    });
  });

  it("edits without sending an empty brief, so the current one stays", () => {
    const form = personaFormFor({
      id: "freya",
      name: "Freya",
      wake: null,
      voice: "v",
      role: "Lead",
      lead: true,
      traits: { warmth: 0.8 },
      brain: { model: "opus", effort: "high" },
      greetings: ["Morning.", "Back again?"],
    });
    expect(personaSave({ ...form, about: "   " })).toEqual({
      op: "edit",
      id: "freya",
      draft: {
        name: "Freya",
        role: "Lead",
        traits: { warmth: 0.8 },
        model: "opus",
        private: false,
        greetings: ["Morning.", "Back again?"],
      },
    });
  });

  it("confirms a drafted hire as a create that keeps its greetings", () => {
    const form = personaFormOfDraft({
      name: "Basil",
      role: "Cooking buddy",
      about: "Cheerful.",
      traits: { warmth: 0.9 },
      greetings: ["What are we cooking?"],
    });
    expect(personaSave(form)).toEqual({
      op: "create",
      draft: {
        name: "Basil",
        role: "Cooking buddy",
        about: "Cheerful.",
        traits: { warmth: 0.9 },
        model: null,
        private: false,
        greetings: ["What are we cooking?"],
      },
    });
  });
});

describe("groupToggle", () => {
  it("gathers picks and starts the group at two", () => {
    const first = groupToggle(null, [], "a", true);
    expect(first).toEqual({ picked: ["a"], change: null });
    expect(groupToggle(null, first.picked, "b", true)).toEqual({
      picked: [],
      change: { op: "start", personas: ["a", "b"] },
    });
    expect(groupToggle(null, ["a"], "a", false)).toEqual({ picked: [], change: null });
  });

  it("adds to and leaves a live group", () => {
    const group = { members: [{ id: "a" }, { id: "b" }], mode: "answer" as const };
    expect(groupToggle(group, [], "c", true).change).toEqual({ op: "add", personas: ["c"] });
    expect(groupToggle(group, [], "a", false).change).toEqual({ op: "leave", persona: "a" });
  });
});

import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_OS_PACK,
  leadsProject,
  mergePack,
  modelOf,
  packPrompt,
  PACK_PROMPT_CHARS,
  personaFor,
  rosterLine,
} from "./osPack.ts";

describe("the operating-system pack", () => {
  it("lets a user's files win by name, ignores bad names and empty files, and keeps the rest", () => {
    const merged = mergePack({
      executive: "  My way.  ",
      roles: { research: "Mine.", "../evil": "x", legal: "A lawyer.", marketing: "   " },
    });
    expect(merged.executive).toBe("My way.");
    expect(merged.roles["research"]).toBe("Mine.");
    expect(merged.roles["legal"]).toBe("A lawyer.");
    expect(merged.roles["../evil"]).toBeUndefined();
    expect(merged.roles["marketing"]).toBe(DEFAULT_OS_PACK.roles["marketing"]);
    expect(mergePack({}).executive).toBe(DEFAULT_OS_PACK.executive);
  });
  it("reads a persona's `private: yes`, never for the lead", () => {
    const pack = mergePack({
      roles: {
        research: "---\nname: Sebastian\nprivate: yes\n---\nResearch.",
        executive: "---\nprivate: yes\n---\nLead.",
      },
    });
    expect(pack.personas.find((p) => p.id === "research")?.private).toBe(true);
    expect(pack.personas.find((p) => p.lead)?.private).toBeUndefined();
  });
  it("carries each persona's body, temperament, eyes and model, and drops what it cannot read", () => {
    const tessaya = DEFAULT_OS_PACK.personas.find((p) => p.lead)!;
    expect(tessaya).toMatchObject({
      character: "selvedge",
      traits: { energy: 0.5, warmth: 0.6, sass: 0.3 },
      guilt: 1,
      brain: { model: "opus", effort: "medium" },
    });
    const pack = mergePack({
      roles: {
        nova: "---\nname: Nova\nwake: Nova\nvoice: eve\ncharacter: purl\neyes: curious\ntraits: energy 0.9, warmth 2, play x, sass .25\nguilt: 7\n---\nbrief",
      },
    });
    const nova = pack.personas.find((p) => p.id === "nova")!;
    expect(nova).toMatchObject({
      character: "purl",
      eyes: "curious",
      traits: { energy: 0.9, sass: 0.25 },
    });
    expect(nova.traits).not.toHaveProperty("warmth");
    expect(nova.guilt).toBeUndefined();
    expect(nova.brain).toEqual({ model: "sonnet", effort: "medium" });
  });

  it("frames the planning turn and stays within its cap", () => {
    expect(packPrompt(DEFAULT_OS_PACK)).toContain("job brief");
    expect(packPrompt(mergePack({ executive: "x".repeat(20_000) })).length).toBe(PACK_PROMPT_CHARS);
  });
  it("keeps the front-matter out of the briefs the planner reads", () => {
    expect(packPrompt(DEFAULT_OS_PACK)).not.toContain("voice:");
    expect(DEFAULT_OS_PACK.roles["research"]).toMatch(/^Persona:/);
  });
});

describe("the roster", () => {
  const who = (pack = DEFAULT_OS_PACK, wake: string | null = null, text = "what time is it") => {
    const p = personaFor(pack.personas, { wake, text });
    return `${p.name}/${p.voice}`;
  };
  it("tells each persona who the others are and what they do, in one line, leaving out a private one (PRESENCE)", () => {
    expect(rosterLine(DEFAULT_OS_PACK.personas, "operations")).toBe(
      "Tessaya leads and hands out the work; Alfred handles sessions, builds and releases; Sebastian handles research and analysis",
    );
    expect(rosterLine(DEFAULT_OS_PACK.personas, "executive")).not.toContain("Tessaya");
    const hidden = DEFAULT_OS_PACK.personas.map((p) =>
      p.id === "research" ? { ...p, private: true } : p,
    );
    expect(rosterLine(hidden, "operations")).not.toContain("Sebastian");
  });
  it("answers a wake word with that persona's name and voice", () => {
    expect(who(DEFAULT_OS_PACK, "Freya")).toBe("Freya/azelma");
    expect(who(DEFAULT_OS_PACK, "alfred")).toBe("Alfred/peter_yearsley");
    expect(who(DEFAULT_OS_PACK, "Tessaya")).toBe("Tessaya/eve");
  });
  it("falls back to the lead for an unknown wake word, a hotkey or a typed ask", () => {
    expect(who(DEFAULT_OS_PACK, "Onyx")).toBe("Tessaya/eve");
    expect(who(DEFAULT_OS_PACK, null)).toBe("Tessaya/eve");
    // Sebastian has no wake word yet, so his word wakes the lead; his name in the sentence reaches him.
    expect(who(DEFAULT_OS_PACK, "Sebastian")).toBe("Tessaya/eve");
    expect(who(DEFAULT_OS_PACK, null, "Sebastian, compare these two")).toBe("Sebastian/michael");
  });
  it("lets his file override the default field by field, and add a face of his own", () => {
    const pack = mergePack({
      roles: {
        operations: "---\nvoice: anna\n---\nMy operator.",
        legal: "---\nname: Lex\nwake: Onyx\nvoice: paul\nrole: contracts\n---\nA lawyer.",
      },
    });
    expect(who(pack, "Freya")).toBe("Freya/anna");
    expect(pack.roles["operations"]).toBe("My operator.");
    expect(who(pack, "Onyx")).toBe("Lex/paul");
    // A file with no front-matter keeps the default face.
    expect(who(mergePack({ roles: { engineering: "Mine." } }), "Alfred")).toBe(
      "Alfred/peter_yearsley",
    );
  });
  it("reads each persona's team and the projects it leads, telling apart two projects with one title", () => {
    const pack = mergePack({
      executive: "---\nwalled: shop, tax\n---\n",
      roles: { engineering: "---\nprojects: shop, site\nleads: Site, shop@studio\n---\n" },
    });
    const alfred = pack.personas.find((p) => p.name === "Alfred")!;
    expect(pack.walled).toEqual(["shop", "tax"]);
    expect(alfred.projects).toEqual(["shop", "site"]);
    const at = (title: string, computer: string | null) => ({ title, computer });
    const known = [at("site", "laptop"), at("shop", "studio"), at("shop", "laptop")];
    expect(leadsProject(alfred, at("site", "laptop"), known)).toBe(true);
    // Unqualified, a title matches only when one known project has it.
    expect(leadsProject(alfred, at("site", null), known)).toBe(true);
    expect(leadsProject(alfred, at("site", null), [...known, at("site", "studio")])).toBe(false);
    expect(leadsProject(alfred, at("shop", "studio"), known)).toBe(true);
    expect(leadsProject(alfred, at("shop", "laptop"), known)).toBe(false);
    expect(leadsProject(alfred, at("shop", null), known)).toBe(false);
    expect(leadsProject(alfred, at("tax", "laptop"), known)).toBe(false);
    expect(leadsProject(pack.personas[0]!, at("tax", null), [])).toBe(true);
  });

  it("runs each persona on the model and effort its file names: the lead on Opus, specialists on Sonnet", () => {
    const opus = { model: "opus", effort: "medium" };
    const sonnet = { model: "sonnet", effort: "medium" };
    expect(modelOf(DEFAULT_OS_PACK, "executive")).toEqual(opus);
    expect(modelOf(DEFAULT_OS_PACK, "operations")).toEqual(sonnet);
    // A role with no face of its own is still a specialist.
    expect(modelOf(DEFAULT_OS_PACK, "marketing")).toEqual(sonnet);
    const pack = mergePack({
      executive: "---\neffort: high\n---\n",
      roles: {
        research: "---\nmodel: haiku\neffort: low\n---\nMine.",
        legal: "A lawyer.",
        operations: "---\nmodel: rm -rf /\neffort: brutal\n---\nMine.",
      },
    });
    expect(modelOf(pack, "executive")).toEqual({ model: "opus", effort: "high" });
    expect(modelOf(pack, "research")).toEqual({ model: "haiku", effort: "low" });
    expect(modelOf(pack, "legal")).toEqual(sonnet);
    expect(modelOf(pack, "operations")).toEqual(sonnet);
    expect(modelOf(pack, "nobody")).toEqual(sonnet);
  });
});

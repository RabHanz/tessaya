// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { mergePack } from "./osPack.ts";
import {
  createPersona,
  draftProblem,
  duplicatePersona,
  editPersona,
  retiredPersonas,
  setRetired,
} from "./personaFile.ts";

const packOf = (dir: string) => {
  const roles: Record<string, string> = {};
  for (const f of NodeFS.readdirSync(NodePath.join(dir, "roles")))
    roles[f.slice(0, -3)] = NodeFS.readFileSync(NodePath.join(dir, "roles", f), "utf8");
  return mergePack({ roles });
};

describe("persona registry changes", () => {
  it("hires, tunes, copies, retires and restores through the one pack", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "persona-"));
    using _cleanup = { [Symbol.dispose]: () => NodeFS.rmSync(dir, { recursive: true }) };
    const tmp = { dir };
    const id = createPersona(tmp.dir, {
      name: "Luna",
      pronouns: "She/Her",
      role: "a film buff",
      about: "Dry, teases him about his taste.",
      traits: { sass: 0.9 },
      cloneVoice: "abc",
      model: "gpt-5",
      greetings: ["Popcorn?", "Seen anything good?"],
    });
    expect(id).toBe("luna");
    let luna = packOf(tmp.dir).personas.find((p) => p.id === "luna");
    expect(luna).toMatchObject({
      name: "Luna",
      pronouns: "she/her",
      cloneVoice: "abc",
      traits: { sass: 0.9 },
      greetings: ["Popcorn?", "Seen anything good?"],
    });
    expect(luna?.brain?.model).toBe("gpt-5");
    expect(packOf(tmp.dir).roles["luna"]).toBe("Dry, teases him about his taste.");

    // One dial moves; the others stay.
    editPersona(tmp.dir, "luna", { traits: { warmth: 0.7 } });
    luna = packOf(tmp.dir).personas.find((p) => p.id === "luna");
    expect(luna?.traits).toEqual({ warmth: 0.7, sass: 0.9 });
    // how far she comes into his private rooms, and out again
    editPersona(tmp.dir, "luna", { private: true, privateRooms: "one-on-one" });
    expect(packOf(tmp.dir).personas.find((p) => p.id === "luna")?.privateRooms).toBe("one-on-one");
    editPersona(tmp.dir, "luna", { sealed: "companion" });
    expect(packOf(tmp.dir).personas.find((p) => p.id === "luna")?.sealed).toBe("companion");
    editPersona(tmp.dir, "luna", { private: false, privateRooms: null, sealed: null });
    expect(packOf(tmp.dir).personas.find((p) => p.id === "luna")?.privateRooms).toBeUndefined();
    editPersona(tmp.dir, "luna", { pronouns: "they/them" });
    expect(packOf(tmp.dir).personas.find((p) => p.id === "luna")?.pronouns).toBe("they/them");
    editPersona(tmp.dir, "luna", { greetings: [] });
    expect(packOf(tmp.dir).personas.find((p) => p.id === "luna")?.greetings).toBeUndefined();

    // A default face edited keeps its default dials beside the new one.
    editPersona(tmp.dir, "companion", { traits: { warmth: 0.5 } });
    const freya = packOf(tmp.dir).personas.find((p) => p.id === "companion");
    expect(freya?.traits).toMatchObject({ warmth: 0.5, energy: 0.78 });

    // A copy has no wake word: one word wakes one face.
    const copy = duplicatePersona(tmp.dir, "companion", "Freya Two");
    const two = packOf(tmp.dir).personas.find((p) => p.id === copy);
    expect(two).toMatchObject({ name: "Freya Two", wake: null, traits: { warmth: 0.5 } });

    setRetired(tmp.dir, "luna", true);
    expect(packOf(tmp.dir).personas.some((p) => p.id === "luna")).toBe(false);
    expect(retiredPersonas(tmp.dir)).toEqual([{ id: "luna", name: "Luna" }]);
    setRetired(tmp.dir, "luna", false);
    expect(packOf(tmp.dir).personas.some((p) => p.id === "luna")).toBe(true);
    expect(retiredPersonas(tmp.dir)).toEqual([]);
    expect(setRetired(tmp.dir, "executive", true)).toBe(false);
  });

  it("refuses a field that would break the file's front-matter", () => {
    expect(draftProblem({ name: "Luna\nprivate: yes" })).not.toBeNull();
    expect(draftProblem({ role: "ok\nowner: full" })).not.toBeNull();
    expect(draftProblem({ about: "---\nname: X" })).not.toBeNull();
    expect(draftProblem({ traits: { warmth: 2 } })).not.toBeNull();
    expect(draftProblem({ pronouns: "he/him\nprivate: yes" })).not.toBeNull();
    expect(draftProblem({ pronouns: "she or he" })).not.toBeNull();
    expect(draftProblem({ pronouns: "he/him" })).toBeNull();
    expect(draftProblem({ name: "Luna Rae", about: "Line one.\nLine two." })).toBeNull();
  });
});

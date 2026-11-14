// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { DEFAULT_PACK_FILES } from "@t3tools/baton-shared/osPack";
import { describe, expect, it } from "vite-plus/test";

import {
  fileToEdit,
  packAction,
  packControls,
  packEdit,
  readPack,
  rosterControls,
  savePackText,
  setPersonaVoice,
  useDefault,
} from "./packRows.ts";

describe("the pack in the window", () => {
  it("lists the framing, each role and the routing, writes the default to edit, and returns to it", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-packwin-"));
    const first = packControls(dir);
    expect(first.filter((c) => c.id.startsWith("p.ed:template:")).length).toBeGreaterThanOrEqual(
      16,
    );
    expect(first.map((c) => c.id).filter((id) => !id.startsWith("p.ed:template:"))).toEqual([
      "p.ed:executive",
      "p.ed:role:butler",
      "p.ed:role:engineering",
      "p.ed:role:marketing",
      "p.ed:role:research",
      "p.ed:role:alter-ego",
      "p.ed:role:companion",
      "p.ed:routing",
      "p.folder",
    ]);
    expect(first[0]).toMatchObject({
      kind: "editor",
      mine: false,
      text: DEFAULT_PACK_FILES.executive,
    });

    const file = fileToEdit(dir, "executive")!;
    expect(NodeFS.readFileSync(file, "utf8").trim()).toBe(DEFAULT_PACK_FILES.executive);
    NodeFS.writeFileSync(file, "Mine.\n");
    expect(fileToEdit(dir, "executive")).toBe(file);
    expect(NodeFS.readFileSync(file, "utf8")).toBe("Mine.\n");
    expect(packControls(dir)[0]).toMatchObject({ mine: true, text: "Mine.\n" });

    NodeFS.mkdirSync(NodePath.join(dir, "roles"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, "roles", "legal.md"), "A lawyer.");
    expect(packControls(dir).some((c) => c.id === "p.ed:role:legal")).toBe(true);

    expect(useDefault(dir, "executive")).toBe(true);
    expect(NodeFS.existsSync(file)).toBe(false);
    expect(NodeFS.existsSync(`${file}.bak`)).toBe(true);
    expect(useDefault(dir, "executive")).toBe(false);
    expect(fileToEdit(dir, "role:../x")).toBeNull();
    // A template opens from its default into his templates folder, where the server reads it.
    const trip = fileToEdit(dir, "template:plan-a-trip")!;
    expect(trip).toBe(NodePath.join(dir, "templates", "plan-a-trip.md"));
    expect(NodeFS.readFileSync(trip, "utf8")).toContain("title: Plan a trip");
    expect(packEdit("p.ed:template:plan-a-trip:save")).toEqual({
      id: "template:plan-a-trip",
      save: true,
    });
    expect(packAction("p:role:legal:later")).toEqual({ id: "role:legal", reset: true });
    expect(packAction("p:executive")).toEqual({ id: "executive", reset: false });
    expect(packAction("p.folder")).toBeNull();
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });
});

describe("editing the pack in the window", () => {
  it("saves a part, keeps the file it replaced, and refuses empty or broken text", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-packed-"));
    expect(packEdit("p.ed:role:legal:save")).toEqual({ id: "role:legal", save: true });
    expect(packEdit("p.ed:executive:reset")).toEqual({ id: "executive", save: false });
    expect(packEdit("p.ed:../../etc:save")).toBeNull();
    expect(savePackText(dir, "executive", "First version")).toBeNull();
    expect(savePackText(dir, "executive", "Second version")).toBeNull();
    expect(NodeFS.readFileSync(NodePath.join(dir, "executive.md"), "utf8")).toBe(
      "Second version\n",
    );
    expect(NodeFS.readFileSync(NodePath.join(dir, "executive.md.bak"), "utf8")).toBe(
      "First version\n",
    );
    expect(savePackText(dir, "executive", "   ")).toContain("empty");
    expect(savePackText(dir, "routing", "{not json")).toContain("not valid JSON");
    expect(savePackText(dir, "routing", "[1]")).toContain("JSON object");
    expect(savePackText(dir, "routing", '{"planning":"strong"}')).toBeNull();
    expect(savePackText(dir, "role:../x", "text")).toContain("not a part");
  });
});

describe("the roster in the window", () => {
  it("shows each persona's wake word and voice, changes a voice in its file, and puts the default back", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-roster-"));
    const rows = () => rosterControls(dir).map((c) => [c.id, c.kind === "choice" ? c.value : ""]);
    expect(rows()).toEqual([
      ["v.persona:executive", "default"],
      ["v.persona:butler", "default"],
      ["v.persona:engineering", "default"],
      ["v.persona:alter-ego", "default"],
      ["v.persona:companion", "default"],
    ]);
    expect(rosterControls(dir)[4]).toMatchObject({ label: "Freya" });
    // The page plays an option's own voice; Default carries the persona's default as data.
    const freya = rosterControls(dir)[4];
    expect(freya?.kind === "choice" ? freya.options[0] : null).toMatchObject({
      value: "default",
      voice: expect.stringMatching(/^[a-z]+$/),
    });
    expect(setPersonaVoice(dir, "companion", "nobody")).toBe(false);
    expect(setPersonaVoice(dir, "companion", "anna")).toBe(true);
    expect(rows()[4]).toEqual(["v.persona:companion", "anna"]);
    expect(readPack(dir).personas.find((p) => p.name === "Freya")?.voice).toBe("anna");
    // Every library voice is offered, personal-use ones too (outside a commercial build).
    expect(setPersonaVoice(dir, "companion", "cosette")).toBe(true);
    expect(setPersonaVoice(dir, "companion", null)).toBe(true);
    expect(rows()[4]).toEqual(["v.persona:companion", "default"]);
    expect(readPack(dir).personas.find((p) => p.name === "Freya")?.voice).toBe("azelma");
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });
});

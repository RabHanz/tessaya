import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_OS_PACK } from "./osPack.ts";
import { OWNER_DOC_CHARS, ownerDoc, ownerLine } from "./ownerProfile.ts";

const TOOLS = { doc: "owner_doc", remember: "remember" };
const DOC = `# Manual

## 1. Principles

### Outcomes over outputs
Progress, not volume.

## 2. Deciding whether to build
Which outcome does it serve?

### Reversibility
Fast when it can be undone.

## 3. Writing
Lead with the answer.
`;

describe("ownerLine", () => {
  const files = { voice: "VOICE", likes: "LIKES", docs: { manual: DOC } };
  const persona = (id: string) => DEFAULT_OS_PACK.personas.find((p) => p.id === id)!;

  it("gives the alter ego the whole profile, the others the slice, and every one the documents", () => {
    expect(persona("alter-ego").owner).toBe("full");
    const full = ownerLine(persona("alter-ego"), files, TOOLS);
    expect(full).toContain("VOICE");
    expect(full).not.toContain("LIKES");
    expect(full).toContain("keep it with remember");
    const brief = ownerLine(persona("companion"), files, TOOLS);
    expect(brief).toContain("LIKES");
    expect(brief).not.toContain("VOICE");
    for (const line of [full, brief]) expect(line).toContain("manual");
    expect(ownerLine({ owner: "none" }, files, TOOLS)).toBe("");
  });

  it("says nothing with no folder, and falls back to the slice when there is no profile", () => {
    expect(ownerLine(persona("alter-ego"), { docs: {} }, TOOLS)).toBe("");
    expect(ownerLine(persona("alter-ego"), { likes: "LIKES", docs: {} }, TOOLS)).toContain("LIKES");
  });
});

describe("ownerDoc", () => {
  const docs = { manual: DOC, long: `# Long\n\n## Part\n${"x".repeat(OWNER_DOC_CHARS)}` };

  it("lists the documents and their sections when no name matches", () => {
    const listed = ownerDoc(docs, {});
    expect(listed).toContain("manual: Manual; 1. Principles; Outcomes over outputs");
    expect(ownerDoc(docs, { name: "nothing" })).toBe(listed);
    expect(ownerDoc({}, {})).toBe("He has kept no documents here.");
  });

  it("returns a short document whole and a long one as its sections", () => {
    expect(ownerDoc(docs, { name: "Manual" })).toBe(DOC);
    expect(ownerDoc(docs, { name: "long" })).toContain("Ask again with one of these sections.");
  });

  it("returns a section to the next heading at its level, subsections included", () => {
    const section = ownerDoc(docs, { name: "man", section: "deciding build" });
    expect(section.startsWith("## 2. Deciding whether to build")).toBe(true);
    expect(section).toContain("Fast when it can be undone.");
    expect(section).not.toContain("Lead with the answer.");
    expect(ownerDoc(docs, { name: "manual", section: "reversibility" })).toBe(
      "### Reversibility\nFast when it can be undone.",
    );
    expect(ownerDoc(docs, { name: "manual", section: "pricing" })).toContain(
      'No section of manual matches "pricing"',
    );
  });
});

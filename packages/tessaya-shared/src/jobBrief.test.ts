import { describe, expect, it } from "vite-plus/test";

import { briefNudge, parseJobBrief } from "./jobBrief.ts";

const FULL = `## Job brief
**The job:** get the site live without losing the old links.
### Desired outcomes
- lower the time to ship
### Leverage point
Fix the redirect rule, not each page.
### Build or do not build
Build: it serves the launch, it is reversible.
### Steps
1. define 2. locate
### Specialists
engineering, marketing
### Reversibility
Can be undone with one revert.
### Permissions
Edit ~/site only.`;

describe("the job brief", () => {
  it("accepts a plan with every section, whatever the heading style", () => {
    expect(parseJobBrief(FULL)).toEqual({ ok: true, missing: [] });
    expect(parseJobBrief(FULL.replaceAll("### ", "**").replaceAll("\n", "**\n")).ok).toBe(true);
  });
  it("names what is missing, and an ordinary plan with no brief is not ready", () => {
    const some = FULL.replace(/### Leverage point\n.*\n/, "").replace(/### Permissions\n.*/, "");
    expect(parseJobBrief(some).missing).toEqual(["leverage", "permissions"]);
    const plain = parseJobBrief("I will edit the files and run the tests, then tell you.");
    expect(plain.ok).toBe(false);
    expect(plain.missing).toHaveLength(8);
    expect(briefNudge(["leverage"])).toContain("missing: leverage");
  });
});

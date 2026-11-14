import { standingVerdict } from "@t3tools/tessaya-shared/trust";
import { describe, expect, it } from "vite-plus/test";

import { standingGate } from "./standingGate.ts";

const lead = { id: "executive", name: "Tessaya", lead: true, tools: null } as never;

describe("a standing job's run", () => {
  it("uses only its own tools, each judged as a run nobody is watching, then the slot's gate", async () => {
    const reached: string[] = [];
    const gate = standingGate(async (call) => (reached.push(call.tool), { allow: true }), {
      tools: ["jobs_list", "type_text"],
      judge: (tool) => standingVerdict(tool, lead),
    });
    expect(await gate({ tool: "mcp__baton__jobs_list", input: {} })).toEqual({ allow: true });
    // Not one of its tools: refused before anything else is asked.
    expect(await gate({ tool: "mcp__baton__session_send", input: {} })).toMatchObject({
      allow: false,
    });
    // One of its tools that may not run with nobody there: held, and the slot's gate is never reached.
    const held = await gate({ tool: "mcp__baton__type_text", input: { text: "x" } });
    expect(held).toMatchObject({ allow: false });
    expect(reached).toEqual(["mcp__baton__jobs_list"]);
  });
});

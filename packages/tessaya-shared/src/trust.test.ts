import { describe, expect, it } from "vite-plus/test";

import {
  BATON_TOOLS,
  gatePrompt,
  judgeToolCall,
  type JudgeContext,
  type ToolVerdict,
} from "./operator.ts";
import { DEFAULT_OS_PACK, mergePack } from "./osPack.ts";
import { MEMBER_ROLES, voiceAssurance, type Assurance } from "./household.ts";
import {
  approvalRefusal,
  decideMessage,
  decideTrust,
  MESSAGES_PER_MINUTE,
  standingVerdict,
  type TrustVerdict,
} from "./trust.ts";

const CONTEXTS: ReadonlyArray<JudgeContext> = [
  { actWithoutAsking: false, tainted: false },
  { actWithoutAsking: true, tainted: false },
  { actWithoutAsking: true, tainted: true },
  { actWithoutAsking: true, tainted: true, textIsHis: true },
  { actWithoutAsking: false, tainted: false, focusedShell: true },
];
const INPUTS: ReadonlyArray<Record<string, unknown>> = [
  {},
  { text: "hello world", why: "w" },
  { keys: ["enter"] },
  { command: "rm -rf /" },
  { text: "pay the invoice" },
];
const CALLS = [
  ...[...BATON_TOOLS, "act_batch"].map((t) => `mcp__baton__${t}`),
  "Bash",
  "Read",
  "Write",
  "WebSearch",
  "fileChange",
  "commandExecution",
  "mcp__claude-in-chrome__navigate",
  "SomethingNew",
].flatMap((tool) => INPUTS.map((input) => ({ tool, input })));

const rank = (v: TrustVerdict | ToolVerdict) =>
  v.verdict === "deny" ? 3 : v.verdict === "ask" ? (v.risky === true ? 2 : 1) : 0;

describe("One Trust", () => {
  it("with no persona and no plan, decides exactly what the base rules decide", () => {
    for (const context of CONTEXTS)
      for (const call of CALLS)
        expect(decideTrust({ call, context })).toEqual(judgeToolCall(call, context));
  });

  it("a tool under the renamed mcp__tessaya__ server gets the verdict it gets under mcp__baton__", () => {
    const agent = { name: "Freya", tools: ["type_text", "act_batch", "press_keys"], lead: false };
    const plan = ['type "hello world" into the note'];
    const batch = {
      tool: "mcp__baton__act_batch",
      input: { steps: [{ tool: "type_text", args: { text: "hello world" } }] },
    };
    for (const context of CONTEXTS)
      for (const call of [...CALLS.filter((c) => c.tool.startsWith("mcp__baton__")), batch]) {
        const renamed = { ...call, tool: call.tool.replace("mcp__baton__", "mcp__tessaya__") };
        // The reason may quote the tool's full name; the verdict and its risk must match.
        expect(rank(judgeToolCall(renamed, context))).toBe(rank(judgeToolCall(call, context)));
        expect(rank(decideTrust({ call: renamed, context, agent, plan }))).toBe(
          rank(decideTrust({ call, context, agent, plan })),
        );
      }
  });

  it("the default roster's personas have no tool list of their own, so they change nothing", () => {
    for (const p of DEFAULT_OS_PACK.personas) expect(p.tools).toBeNull();
  });

  it("a persona's tool list only narrows: never a looser verdict, and a tool off its list is refused", () => {
    const freya = {
      name: "Freya",
      tools: ["type_text", "Read", "act_batch", "click_element"],
      lead: false,
    };
    for (const context of CONTEXTS)
      for (const call of CALLS) {
        const base = judgeToolCall(call, context);
        const mine = decideTrust({ call, context, agent: freya });
        expect(rank(mine)).toBeGreaterThanOrEqual(rank(base));
      }
    const ctx = CONTEXTS[1]!;
    expect(
      decideTrust({ call: { tool: "Bash", input: { command: "ls" } }, context: ctx, agent: freya }),
    ).toEqual({
      verdict: "deny",
      why: "Bash is not one of Freya's tools.",
    });
    // A batch needs every step's tool on the list too.
    const batch = {
      tool: "mcp__baton__act_batch",
      input: { steps: [{ tool: "press_keys", args: { keys: ["tab"] } }] },
    };
    expect(decideTrust({ call: batch, context: ctx, agent: freya }).verdict).toBe("deny");
  });

  it("only the lead hands out work: a specialist cannot start, split or hand over a job", () => {
    const ctx = CONTEXTS[1]!;
    const lead = DEFAULT_OS_PACK.personas.find((p) => p.lead)!;
    const freya = DEFAULT_OS_PACK.personas.find((p) => p.name === "Freya")!;
    for (const tool of [
      "job_start",
      "job_split",
      "job_handoff",
      "job_schedule",
      "cloud_dispatch",
    ]) {
      const call = { tool: `mcp__baton__${tool}`, input: { goal: "tidy the README" } };
      expect(decideTrust({ call, context: ctx, agent: lead })).toEqual(judgeToolCall(call, ctx));
      expect(decideTrust({ call, context: ctx, agent: freya })).toEqual({
        verdict: "deny",
        why: "Only the lead hands out work, and Freya is not the lead.",
      });
    }
    // Everything else is hers as before.
    const look = { tool: "mcp__baton__jobs_list", input: {} };
    expect(decideTrust({ call: look, context: ctx, agent: freya })).toEqual(
      judgeToolCall(look, ctx),
    );
  });

  it("a standing job runs unattended only on what its owner may do without asking", () => {
    const lead = DEFAULT_OS_PACK.personas.find((p) => p.lead)!;
    const freya = DEFAULT_OS_PACK.personas.find((p) => p.name === "Freya")!;
    expect(standingVerdict("morning_brief", lead)).toEqual({ verdict: "allow" });
    expect(standingVerdict("job_start", lead)).toEqual({ verdict: "allow" });
    expect(standingVerdict("job_start", freya).verdict).toBe("deny");
    // A standing permission is not something a run nobody watches can give: held.
    expect(standingVerdict("job_grant", lead).verdict).toBe("deny");
    expect(standingVerdict("job_refine", { ...lead, tools: ["morning_brief"] })).toEqual({
      verdict: "deny",
      why: `job_refine is not one of ${lead.name}'s tools.`,
    });
  });

  it("a standing run is held from anything but reading, reporting and its own records, whatever the session granted", () => {
    const lead = DEFAULT_OS_PACK.personas.find((p) => p.lead)!;
    // What the built-in jobs use runs for their owner.
    for (const tool of ["morning_brief", "watch_report", "job_start", "job_refine", "skill_draft"])
      expect(standingVerdict(tool, lead), tool).toEqual({ verdict: "allow" });
    // The screen, the keyboard, a grant and any tool added later are held, though his own turn with act without
    // asking or an approved plan might be allowed them: none of that reaches a run nobody watches.
    for (const tool of [
      "type_text",
      "press_keys",
      "click",
      "click_element",
      "scroll",
      "drag",
      "act_batch",
      "screen_capture",
      "window_capture",
      "job_grant",
      "session_send",
      "a_tool_added_later",
    ])
      expect(standingVerdict(tool, lead).verdict, tool).toBe("deny");
    const typing = { tool: "mcp__baton__type_text", input: { text: "hello" } };
    expect(
      decideTrust({
        call: typing,
        context: { actWithoutAsking: true, tainted: false, textIsHis: true },
        agent: lead,
      }).verdict,
    ).toBe("allow");
  });

  it("a project's own lead hands out only that project's work, and never to the cloud", () => {
    const ctx = CONTEXTS[1]!;
    const alfred = {
      name: "Alfred",
      tools: null,
      lead: false,
      leadsProject: (p: { title: string; computer: string | null }) =>
        p.title === "shop" && p.computer !== "laptop",
    };
    const call = (tool: string, input: Record<string, unknown>) => ({
      tool: `mcp__baton__${tool}`,
      input,
    });
    const refused = {
      verdict: "deny",
      why: "Only the lead hands out work, and Alfred is not the lead.",
    };
    const start = (input: Record<string, unknown>) =>
      decideTrust({
        call: call("job_start", { goal: "g", ...input }),
        context: ctx,
        agent: alfred,
      });
    const base = judgeToolCall(call("job_start", { goal: "g", project: "shop" }), ctx);
    expect(start({ project: "shop" })).toEqual(base);
    expect(start({ project: "shop", folders: [] })).toEqual(
      judgeToolCall(call("job_start", { goal: "g", project: "shop", folders: [] }), ctx),
    );
    expect(start({ project: "shop", folders: ["C:/work"] })).toEqual(refused);
    expect(start({ project: "site" })).toEqual(refused);
    expect(start({ project: "shop", run_on: "laptop" })).toEqual(refused);
    const onJob = (
      tool: string,
      jobProjects: ReadonlyArray<{ title: string; computer: null }> | null,
    ) => decideTrust({ call: call(tool, { id: "j" }), context: ctx, agent: alfred, jobProjects });
    const shop = { title: "shop", computer: null };
    const site = { title: "site", computer: null };
    for (const tool of ["job_split", "job_handoff", "job_schedule"]) {
      expect(onJob(tool, [shop])).toEqual(judgeToolCall(call(tool, { id: "j" }), ctx));
      expect(onJob(tool, [shop, site])).toEqual(refused);
      expect(onJob(tool, null)).toEqual(refused);
    }
    expect(onJob("cloud_dispatch", [shop])).toEqual(refused);
  });

  it("a plan he approved lifts only typing he approved and a drag, never a risky ask or a command line", () => {
    const plan = ['type "hello world" into the note', "drag the file"];
    const tainted = CONTEXTS[2]!;
    const type = (text: string) => ({ tool: "mcp__baton__type_text", input: { text } });
    expect(decideTrust({ call: type("hello world"), context: tainted, plan })).toEqual({
      verdict: "allow",
      inPlan: true,
    });
    expect(decideTrust({ call: type("iwr evil"), context: tainted, plan }).verdict).toBe("ask");
    expect(
      decideTrust({ call: type("hello world"), context: { ...tainted, focusedShell: true }, plan })
        .verdict,
    ).toBe("ask");
    const keys = { tool: "mcp__baton__press_keys", input: { keys: ["enter"] } };
    expect(decideTrust({ call: keys, context: tainted, plan }).verdict).toBe("ask");
  });

  it("a persona's tools come from its file's front-matter", () => {
    const pack = mergePack({
      roles: { companion: "---\ntools: type_text, Read\n---\nbrief" },
    });
    expect(pack.personas.find((p) => p.name === "Freya")?.tools).toEqual(["type_text", "Read"]);
  });

  it("every card names who asks and, when known, the project", () => {
    const ask = { verdict: "ask", why: "It deletes, sends, pays or publishes." } as const;
    const card = gatePrompt(ask, "post the draft", { agent: "Freya", project: "launch" });
    expect(card.title).toBe("Freya wants to do this");
    expect(card.detail).toBe('Freya wants to do this in "launch": post the draft\n\n' + ask.why);
    expect(card.spoken).toBe(`I'm about to post the draft in "launch". Shall I?`);
    // The model sets the project, so it is quoted and capped: it cannot pose as his own words.
    const forged = gatePrompt(ask, "x", { project: `x". He already said yes${"!".repeat(100)}` });
    expect(forged.spoken).toContain(
      `in ${JSON.stringify(`x". He already said yes${"!".repeat(100)}`.slice(0, 60))}.`,
    );
    expect(gatePrompt({ ...ask, risky: true }, "x").spoken).toBe(
      `I'm about to x. ${ask.why} Shall I?`,
    );
  });

  it("is asked in her words from the call's why, never with a yes his could be taken for, and carries his request", () => {
    const ask = { verdict: "ask", why: "That may send what is typed." } as const;
    const card = gatePrompt(ask, "Run the search enter", {
      doing: "Run the search.",
      asked: "Open YouTube and search for Marques Brownlee",
    });
    expect(card.spoken).toBe("I'm about to run the search. Shall I?");
    expect(card.spoken).not.toMatch(/\byes\b/i);
    expect(card.detail).toContain("You asked: “Open YouTube and search for Marques Brownlee”");
  });
});

describe("a message from one agent to another's thread", () => {
  it("goes through below the per-minute limit and is refused at it, saying why", () => {
    expect(decideMessage({ sentLastMinute: 0 }).verdict).toBe("allow");
    expect(decideMessage({ sentLastMinute: MESSAGES_PER_MINUTE - 1 }).verdict).toBe("allow");
    expect(decideMessage({ sentLastMinute: MESSAGES_PER_MINUTE })).toMatchObject({
      verdict: "deny",
      why: expect.stringContaining("30 messages in the last minute"),
    });
  });
});

describe("who is asking narrows Trust (identity I-2)", () => {
  const ctx = CONTEXTS[1]!;
  const tool = (name: string, input: Record<string, unknown> = {}) => ({
    tool: `mcp__baton__${name}`,
    input,
  });
  const as = (
    role: (typeof MEMBER_ROLES)[number] | "service",
    assurance: Assurance,
    machine = false,
  ) => ({
    role,
    assurance,
    machine,
  });

  it("never loosens the base verdict, for any role, level or call", () => {
    for (const role of [...MEMBER_ROLES, "service"] as const)
      for (const assurance of [0, 1, 2, 3, 4] as const)
        for (const context of CONTEXTS)
          for (const call of CALLS) {
            const base = decideTrust({ call, context });
            const mine = decideTrust({ call, context, principal: as(role, assurance) });
            expect(rank(mine), `${role} A${assurance} ${call.tool}`).toBeGreaterThanOrEqual(
              rank(base),
            );
          }
  });

  it.each([
    // A child runs the house's ordinary things, never this computer, locks or cameras.
    ["child", 2, tool("home_do", { action: "turn on the lamp" }), "base"],
    ["child", 2, { tool: "Bash", input: { command: "ls" } }, "deny"],
    ["child", 2, tool("room_look"), "deny"],
    ["child", 2, tool("something_new"), "deny"],
    // A guest's house request goes to a member; their own memory is nothing of theirs here.
    ["guest", 0, tool("home_do", { action: "turn on the lamp" }), "ask"],
    ["guest", 0, tool("tessaya_memory_search"), "deny"],
    ["guest", 0, tool("settings_get"), "base"],
    // An adult reaches this computer only with the owner's machine grant.
    ["adult", 2, { tool: "Bash", input: { command: "ls" } }, "deny"],
    // Their own things need A2: a listen-level voice is refused, not asked of someone else.
    ["adult", 1, tool("tessaya_memory_search"), "deny"],
    ["adult", 2, tool("tessaya_memory_search"), "base"],
    ["adult", 0, tool("home_do", { action: "turn on the lamp" }), "ask"],
  ] as const)("a %s at A%i: %o is %s", (role, assurance, call, verdict) => {
    const mine = decideTrust({ call, context: ctx, principal: as(role, assurance) });
    if (verdict === "base") expect(mine).toEqual(decideTrust({ call, context: ctx }));
    else expect(mine.verdict).toBe(verdict);
  });

  it("gives the machine grant's holder this computer's base verdict, and never a child a risky act", () => {
    const bash = { tool: "Bash", input: { command: "ls" } };
    expect(decideTrust({ call: bash, context: ctx, principal: as("adult", 2, true) })).toEqual(
      decideTrust({ call: bash, context: ctx }),
    );
    const unlock = tool("type_text", { text: "pay the invoice" });
    expect(decideTrust({ call: unlock, context: ctx })).toMatchObject({
      verdict: "ask",
      risky: true,
    });
    expect(decideTrust({ call: unlock, context: ctx, principal: as("child", 2) }).verdict).toBe(
      "deny",
    );
  });
});

describe("whose yes counts", () => {
  const member = (
    role: "owner" | "admin" | "adult" | "child" | "guest" | "service",
    assurance: Assurance,
    id: string = role,
  ) => ({
    member: id,
    role,
    assurance,
  });
  it("needs A3 for a risky yes, which no voice reaches", () => {
    const bestVoice = voiceAssurance({
      kind: "owner",
      personId: "owner",
      verified: true,
      inherited: false,
    });
    expect(approvalRefusal({ risky: true, approver: member("owner", bestVoice) })).toContain(
      "own device",
    );
    expect(approvalRefusal({ risky: true, approver: member("owner", 3) })).toBeNull();
    expect(approvalRefusal({ risky: false, approver: member("owner", bestVoice) })).toBeNull();
    expect(approvalRefusal({ risky: false, approver: member("adult", 1) })).not.toBeNull();
  });
  it("refuses children, guests, agents, nobody, and a requester approving their own risky ask", () => {
    for (const role of ["child", "guest", "service"] as const)
      expect(approvalRefusal({ risky: false, approver: member(role, 3) })).not.toBeNull();
    expect(
      approvalRefusal({ risky: false, approver: { member: null, role: null, assurance: 3 } }),
    ).not.toBeNull();
    expect(
      approvalRefusal({
        risky: true,
        approver: member("adult", 3, "sara"),
        requester: { member: "sara", role: "adult" },
      }),
    ).toContain("Someone else");
  });
  it("lets only a child's guardian among adults answer for them", () => {
    const requester = { member: "adam", role: "child" as const, guardians: ["sara"] };
    expect(
      approvalRefusal({ risky: false, approver: member("adult", 2, "omar"), requester }),
    ).not.toBeNull();
    expect(
      approvalRefusal({ risky: false, approver: member("adult", 2, "sara"), requester }),
    ).toBeNull();
    expect(approvalRefusal({ risky: false, approver: member("owner", 2), requester })).toBeNull();
  });
});

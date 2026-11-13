/**
 * One Trust: the one function that answers "may this agent do this now?". The base rules are `judgeToolCall`; a plan
 * he approved may lift only the asks `PLAN_SKIPS` names, for its own steps; a persona's tool list can only narrow
 * what is left. Nothing here widens the base rules.
 */
import {
  BATON_TOOL_PREFIX,
  batchSteps,
  batonToolName,
  isOwnTool,
  judgeToolCall,
  type JudgeContext,
  type ToolCall,
  type ToolVerdict,
} from "./operator.ts";
import type { Assurance, MemberRole, PrincipalRole } from "./household.ts";
import type { ProjectRef } from "./osPack.ts";

/** Who is asking: a persona from the roster. `tools: null` is no list of its own, so only the base rules apply. */
export interface TrustAgent {
  readonly name: string;
  readonly tools: ReadonlyArray<string> | null;
  /** Only the lead hands out work (decision 2026-11-05). */
  readonly lead: boolean;
  /** Whether it leads this project (a project's own lead); absent is none. */
  readonly leadsProject?: (project: ProjectRef) => boolean;
}

/** Tools that hand work to another agent: the lead's alone. */
export const DELEGATING_TOOLS: ReadonlySet<string> = new Set([
  "job_start",
  "job_split",
  "job_handoff",
  "job_schedule",
  "cloud_dispatch",
]);

export interface TrustAsk {
  readonly call: ToolCall;
  readonly context: JudgeContext;
  readonly agent?: TrustAgent;
  /** The steps of a plan he approved this turn (plan_show). */
  readonly plan?: ReadonlyArray<string> | null;
  /** The projects of the job a job_split, job_handoff or job_schedule names; null when it could not be read. */
  readonly jobProjects?: ReadonlyArray<ProjectRef> | null;
  /** Who is asking and how sure we are (identity I-2). It only narrows; absent, nothing changes. */
  readonly principal?: TrustPrincipal;
}

/** Who a turn is from, for Trust: their role, their assurance (A0-A4), and whether they hold the "machine" grant. */
export interface TrustPrincipal {
  readonly role: PrincipalRole;
  readonly assurance: Assurance;
  readonly machine?: boolean;
}

/**
 * What a tool reaches, for the role table (HOUSEHOLD-DESIGN §5): talk and look-ups, the speaker's own things, the house,
 * what is locked or watched, household settings and members, or this computer. Unlisted tools are this computer's, so a
 * new tool is closed to children and guests until it is placed here.
 */
export type ToolReach = "general" | "personal" | "home" | "secure" | "household" | "machine";

const REACH: Readonly<Record<string, ToolReach>> = {
  ...Object.fromEntries(
    [
      "tessaya_ask",
      "tessaya_ask_status",
      "tessaya_pronounce",
      "settings_find",
      "settings_get",
      "settings_explain",
      "members_list",
      "watch_report",
      "what_happened",
      "morning_brief",
      "trust_show",
    ].map((t) => [t, "general" as const]),
  ),
  ...Object.fromEntries(
    [
      "tessaya_memory_search",
      "tessaya_memory_remember",
      "tessaya_memory_forget",
      "tessaya_memory_about",
      "memory_remember",
      "note_search",
      "member_preferences",
      // Their own messages: a private one is theirs alone.
      "comms_inbox",
      "comms_play",
      "comms_dnd",
    ].map((t) => [t, "personal" as const]),
  ),
  ...Object.fromEntries(
    [
      "set_device_volume",
      "device_list",
      "device_read",
      "device_set",
      "home_find",
      "home_state",
      "home_do",
      "home_undo",
      // Messages and announcements to the people here: a child may, a guest is refused by the service.
      "comms_send",
      "comms_react",
      // Who may set one off is the owner's per-kind rule, judged by the service; okay and false alarm stop it.
      "comms_emergency",
      "comms_emergency_ok",
      "comms_false_alarm",
    ].map((t) => [t, "home" as const]),
  ),
  ...Object.fromEntries(
    ["room_look", "home_automations", "home_automation_save", "home_automation_set"].map((t) => [
      t,
      "secure" as const,
    ]),
  ),
  ...Object.fromEntries(
    [
      "settings_set",
      "member_invite",
      "member_set_role",
      "member_remove",
      "member_restore",
      "member_rename",
      "member_preference_set",
      "household_home_server",
    ].map((t) => [t, "household" as const]),
  ),
};
export const toolReach = (tool: string): ToolReach => REACH[batonToolName(tool)] ?? "machine";

/** What each role may reach at all (HOUSEHOLD-DESIGN §5); "machine" also needs the owner's grant below the owner. */
const ROLE_REACH: Readonly<Record<MemberRole, ReadonlySet<ToolReach>>> = {
  owner: new Set(["general", "personal", "home", "secure", "household", "machine"]),
  admin: new Set(["general", "personal", "home", "secure", "household", "machine"]),
  adult: new Set(["general", "personal", "home", "secure", "household", "machine"]),
  child: new Set(["general", "personal", "home"]),
  guest: new Set(["general", "home"]),
};

/** The least assurance each reach needs before it is done without a yes (ACCOUNTS-IDENTITY-DESIGN §3.2). */
const REACH_ASSURANCE: Readonly<Record<ToolReach, Assurance>> = {
  general: 0,
  home: 1,
  personal: 2,
  secure: 2,
  household: 2,
  machine: 2,
};

/** The least assurance this tool needs before it is done without a yes. */
export const reachAssurance = (tool: string): Assurance => REACH_ASSURANCE[toolReach(tool)];

/**
 * Why this principal may not use this tool at all, or null: outside their role's reach, this computer without the
 * owner's grant, or their own things below A2. The room's tool runner checks it at execution; Trust below adds asks.
 */
export const principalRefusal = (principal: TrustPrincipal, tool: string): string | null => {
  if (principal.role === "service") return null;
  const role = principal.role;
  const reach = toolReach(tool);
  if (
    !ROLE_REACH[role].has(reach) ||
    (reach === "machine" && role !== "owner" && principal.machine !== true)
  )
    return `${batonToolName(tool)} is not for a ${role} in this home.`;
  // My own things need me, not a likely me: refused rather than asked of someone else.
  if (reach === "personal" && principal.assurance < REACH_ASSURANCE.personal)
    return "I need to be sure it's you for that: try again on your own device.";
  return null;
};

/** The role and assurance's narrowing of a verdict: never looser than `verdict`. */
const narrowFor = (
  principal: TrustPrincipal,
  call: ToolCall,
  verdict: TrustVerdict,
): TrustVerdict => {
  if (verdict.verdict === "deny" || principal.role === "service") return verdict;
  for (const tool of toolsUsed(call)) {
    const why = principalRefusal(principal, tool);
    if (why !== null) return { verdict: "deny", why };
  }
  const role = principal.role;
  // Locks, money, deletion and commands: never a child's or a guest's, asked or not.
  if (verdict.verdict === "ask" && verdict.risky === true && (role === "child" || role === "guest"))
    return { verdict: "deny", why: `A ${role} can't do this; ask a parent or the owner.` };
  const needs = Math.max(...toolsUsed(call).map((t) => REACH_ASSURANCE[toolReach(t)]));
  if (principal.assurance >= needs || verdict.verdict === "ask") return verdict;
  return {
    verdict: "ask",
    why: `I'm not sure enough who's asking (A${principal.assurance}) to do this without a yes.`,
  };
};

/**
 * Whether a yes counts (ACCOUNTS-IDENTITY-DESIGN §3.2): only a member whose role may approve, at A2 for an ordinary ask
 * and A3 on their own device for a risky one; never a service, never a child or guest, and never the requester saying
 * yes to their own risky ask. A child's ask is answered by one of their guardians, the owner or an admin.
 */
export const approvalRefusal = (ask: {
  readonly risky: boolean;
  readonly approver: {
    readonly member: string | null;
    readonly role: PrincipalRole | null;
    readonly assurance: Assurance;
  };
  readonly requester?: {
    readonly member: string | null;
    readonly role: PrincipalRole | null;
    readonly guardians?: ReadonlyArray<string>;
  };
}): string | null => {
  const { approver, requester } = ask;
  if (approver.member === null || approver.role === null)
    return "Only a member of this home can say yes.";
  if (approver.role === "service") return "An agent can't say yes for anyone.";
  if (approver.role === "child" || approver.role === "guest")
    return `A ${approver.role} can't say yes to this.`;
  if (approver.assurance < (ask.risky ? 3 : 2))
    return ask.risky
      ? "This needs a yes on your own device, with your face, fingerprint or PIN."
      : "I need to be sure it's you before that yes counts.";
  if (ask.risky && requester?.member === approver.member)
    return "Someone else has to say yes to a risky request of your own.";
  if (
    requester?.role === "child" &&
    approver.role === "adult" &&
    !(requester.guardians ?? []).includes(approver.member)
  )
    return "Only their guardian, the owner or an admin answers for a child.";
  return null;
};

export type TrustVerdict = ToolVerdict | { readonly verdict: "allow"; readonly inPlan: true };

/**
 * The only reasons a plan he approved may skip, and for which steps: typing after a read, and a drag. Keys never (Enter
 * sends; Win, Alt and other chords open things), nor what deletes, sends, pays, publishes or reaches a command line.
 */
const PLAN_SKIPS: Readonly<Record<string, ReadonlySet<string>>> = {
  type_text: new Set(["It follows something it read."]),
  drag: new Set(["It wants to drag something."]),
};

/**
 * Whether a hands step is one he approved: the text it types is a step's quoted text, or a whole phrase of a step at
 * least three characters long (a letter at a time, or a word inside another, would smuggle text past the plan); a drag
 * only where a step says drag.
 */
export const inApprovedSteps = (
  steps: ReadonlyArray<string>,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): boolean => {
  const words = steps.join("\n").toLowerCase();
  if (tool === "drag") return /\bdrag\b/.test(words);
  if (tool !== "type_text" || typeof args["text"] !== "string") return false;
  const text = args["text"].trim().toLowerCase();
  if (text === "") return false;
  const quoted = [...words.matchAll(/["“”]([^"“”]+)["“”]/g)].some((m) => m[1]!.trim() === text);
  if (quoted) return true;
  const phrase = text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return (
    text.length >= 3 &&
    new RegExp(`(^|[^\\p{L}\\p{N}])${phrase}($|[^\\p{L}\\p{N}])`, "u").test(words)
  );
};

/** A batch is covered only when every step is, each judged alone (a batch's own verdict keeps one reason of several). */
const planCovers = (
  call: ToolCall,
  context: JudgeContext,
  plan: ReadonlyArray<string>,
): boolean => {
  if (!isOwnTool(call.tool) || context.focusedShell === true) return false;
  const covered = (tool: string, args: Readonly<Record<string, unknown>>) => {
    const one = judgeToolCall({ tool: `${BATON_TOOL_PREFIX}${tool}`, input: args }, context);
    return (
      one.verdict === "allow" ||
      (one.verdict === "ask" &&
        one.risky !== true &&
        PLAN_SKIPS[tool]?.has(one.why) === true &&
        inApprovedSteps(plan, tool, args))
    );
  };
  const name = batonToolName(call.tool);
  if (name !== "act_batch") return covered(name, call.input);
  const steps = batchSteps(call.input) ?? [];
  return steps.length > 0 && steps.every((s) => covered(s.tool, s.input));
};

/** The tools a call uses: a batch uses itself and each of its steps. */
const toolsUsed = (call: ToolCall): ReadonlyArray<string> => {
  const name = batonToolName(call.tool);
  return name === "act_batch" && isOwnTool(call.tool)
    ? [name, ...(batchSteps(call.input) ?? []).map((s) => s.tool)]
    : [name];
};

/** Tools a project's own lead may use on a job in a project it leads. */
const PROJECT_JOB_TOOLS: ReadonlySet<string> = new Set([
  "job_split",
  "job_handoff",
  "job_schedule",
]);

/**
 * A project's own lead hands out that project's work only: a job_start in projects it leads with no
 * folders of its own, or a split, handoff or schedule of a job whose projects it all leads. Never the cloud.
 */
const projectLeadMay = (ask: TrustAsk, agent: TrustAgent, tool: string): boolean => {
  const leads = agent.leadsProject;
  if (leads === undefined) return false;
  if (tool === "job_start") {
    const project = ask.call.input["project"];
    const folders = ask.call.input["folders"];
    const runOn = ask.call.input["run_on"];
    return (
      typeof project === "string" &&
      (folders === undefined || (Array.isArray(folders) && folders.length === 0)) &&
      leads({
        title: project,
        computer: typeof runOn === "string" && runOn.trim() !== "" ? runOn : null,
      })
    );
  }
  const projects = ask.jobProjects ?? [];
  return PROJECT_JOB_TOOLS.has(tool) && projects.length > 0 && projects.every(leads);
};

export const decideTrust = (ask: TrustAsk): TrustVerdict => {
  const decided = decideBase(ask);
  return ask.principal === undefined ? decided : narrowFor(ask.principal, ask.call, decided);
};

const decideBase = (ask: TrustAsk): TrustVerdict => {
  const base = judgeToolCall(ask.call, ask.context);
  const verdict: TrustVerdict =
    base.verdict === "ask" &&
    ask.plan !== null &&
    ask.plan !== undefined &&
    planCovers(ask.call, ask.context, ask.plan)
      ? { verdict: "allow", inPlan: true }
      : base;
  const agent = ask.agent;
  if (verdict.verdict === "deny" || agent === undefined) return verdict;
  if (!agent.lead) {
    const delegates = toolsUsed(ask.call).find(
      (t) => DELEGATING_TOOLS.has(t) && !projectLeadMay(ask, agent, t),
    );
    if (delegates !== undefined)
      return {
        verdict: "deny",
        why: `Only the lead hands out work, and ${agent.name} is not the lead.`,
      };
  }
  if (agent.tools === null) return verdict;
  const mine = new Set(agent.tools.map((t) => t.toLowerCase()));
  const outside = toolsUsed(ask.call).find((t) => !mine.has(t.toLowerCase()));
  return outside === undefined
    ? verdict
    : { verdict: "deny", why: `${outside} is not one of ${agent.name}'s tools.` };
};

/**
 * A standing job (a rule, a playbook, a schedule) runs by itself only where its one tool is on the unattended list
 * and allowed for its owner with nobody there to ask. Anything else is held: the run is recorded as held and does
 * nothing.
 */
/**
 * What a run nobody is watching may use at all: reading and reporting, and the three writes the built-in jobs make
 * into Tessaya's own records (a read-only look job, a note on a job, a skill draft that waits for his yes). Anything
 * else, including every screen and keyboard tool and any tool added later, is held.
 */
const UNATTENDED_TOOLS: ReadonlySet<string> = new Set([
  "jobs_list",
  "home_find",
  "home_state",
  "home_automations",
  "device_list",
  "watch_report",
  "what_happened",
  "morning_brief",
  "needs_me",
  "commit_list",
  "trust_show",
  "cloud_status",
  "cloud_list",
  "cloud_usage",
  "activity_today",
  "weave_list",
  "note_search",
  "approvals_list",
  "job_start",
  "job_refine",
  "skill_draft",
]);

/** Whether a run nobody is watching may use this tool at all (a user's standing job picks only from these). */
export const isUnattendedTool = (tool: string): boolean => UNATTENDED_TOOLS.has(tool);

export const standingVerdict = (tool: string, agent: TrustAgent): TrustVerdict =>
  UNATTENDED_TOOLS.has(tool)
    ? decideTrust({
        call: { tool: `${BATON_TOOL_PREFIX}${tool}`, input: {} },
        // Nothing he granted in person carries over: no act-without-asking, no plan, no screen or keys window.
        context: { actWithoutAsking: false, tainted: false },
        agent,
        plan: null,
      })
    : { verdict: "deny", why: `${tool} does not run with nobody there; it is held.` };

/** Agent-to-agent messages: sends one sender may make in a minute (decided 2026-11-06). */
export const MESSAGES_PER_MINUTE = 30;

/**
 * Whether one agent may message another agent's thread now. Who may reach which thread is T3's own rule (a link below
 * full access only reaches threads it started); this adds the per-sender limit, counted on the receiving machine.
 */
export const decideMessage = (ask: {
  /** What this sender sent in the last minute. */
  readonly sentLastMinute: number;
}): { readonly verdict: "allow" } | { readonly verdict: "deny"; readonly why: string } =>
  ask.sentLastMinute >= MESSAGES_PER_MINUTE
    ? {
        verdict: "deny",
        why: `This sender has sent ${MESSAGES_PER_MINUTE} messages in the last minute, the most allowed. Wait a minute, then send again.`,
      }
    : { verdict: "allow" };

/**
 * The gate for the one assistant's tools (D143). It asks One Trust (`decideTrust`), the same rules as the operator's
 * (D127), run INSIDE every tool, so no local process and no harness mode reaches a tool without it.
 * A yes is spoken or clicked; for anything high risk the default is no.
 */
import * as DateTime from "effect/DateTime";
import {
  addressBarAfter,
  batchSteps,
  batonToolName,
  describeToolCall,
  gatePrompt,
  READS_OUTSIDE,
  type ToolCall,
} from "@t3tools/baton-shared/operator";
import { decideTrust, type TrustAgent } from "@t3tools/baton-shared/trust";
import type { ProjectRef } from "@t3tools/baton-shared/osPack";
import { textIsFromConversation } from "@t3tools/baton-shared/conversation";
import { namesShell } from "@t3tools/baton-shared/screenCompanion";
import {
  chromeReads,
  hostForCall,
  isChromeTool,
  isSocialHost,
  socialLogLine,
} from "@t3tools/baton-shared/webPolicy";

export type Gate = (
  call: ToolCall,
) => Promise<{ readonly allow: true } | { readonly allow: false; readonly reason: string }>;

/**
 * Cut-ins over her voice, against the turn they cut. `begin` at each turn, and again once he has answered her own
 * question aloud: talking over that question was his answer, not a cut-in.
 */
export const createCutInMark = () => {
  let cuts = 0;
  let atTurn = 0;
  return {
    cut: () => void (cuts += 1),
    begin: () => void (atTurn = cuts),
    since: () => cuts !== atTurn,
  };
};

/** He talked over her reply since this turn began: it does nothing more, and his next words say what he wants. */
export const stopsOnCutIn =
  (gate: Gate, cutSinceTurn: () => boolean): Gate =>
  async (call) =>
    cutSinceTurn()
      ? {
          allow: false,
          reason:
            "He cut in over your reply, so this was not done. Do nothing more this turn; his next words say what he wants.",
        }
      : gate(call);

/** Has this turn read something outside the conversation? Reset when a new turn starts. */
/** Where a yes to typing was given for: the window with the keyboard and the box that was clicked. */
export interface TypingScope {
  readonly window: string;
  readonly field: string;
}

export interface TurnTaint {
  readonly mark: () => void;
  readonly on: () => boolean;
  /** His yes to typing covers more typing into the same window and box, until Enter, a send or the turn's end. */
  readonly allowTyping: (scope: TypingScope) => void;
  readonly typingAllowedFor: (scope: TypingScope) => boolean;
  readonly clearTyping: () => void;
  /** The box last clicked this turn: a control's name, or a coarse place. */
  readonly noteField: (field: string) => void;
  readonly field: () => string;
  /** What he said to start this turn: typing his own words is not following something it read. */
  readonly said: () => string;
  /** What this turn typed into a browser's address bar since it opened it; undefined when it is not there. */
  readonly addressBar: () => string | undefined;
  readonly setAddressBar: (typed: string | undefined) => void;
  readonly reset: (said?: string) => void;
}

export const createTaint = (): TurnTaint => {
  let tainted = false;
  let scope: TypingScope | null = null;
  let field = "";
  let said = "";
  let addressBar: string | undefined;
  return {
    mark: () => void (tainted = true),
    on: () => tainted,
    allowTyping: (next) => void (scope = next),
    typingAllowedFor: (now) =>
      scope !== null && scope.window === now.window && scope.field === now.field,
    clearTyping: () => void (scope = null),
    noteField: (next) => void (field = next),
    field: () => field,
    said: () => said,
    addressBar: () => addressBar,
    setAddressBar: (typed) => void (addressBar = typed),
    reset: (next = "") => {
      said = next;
      tainted = false;
      scope = null;
      field = "";
      addressBar = undefined;
    },
  };
};

/** A coarse place for a click by position, so a small slip is still the same box. */
export const fieldOf = (input: Readonly<Record<string, unknown>>): string =>
  typeof input["label"] === "string"
    ? `element:${input["label"].toLowerCase()}`
    : typeof input["id"] === "number"
      ? `element:#${input["id"]}`
      : `point:${Math.round(Number(input["x"]) / 60)},${Math.round(Number(input["y"]) / 60)}`;

/** The window with the keyboard is a web browser, by its title. */
const BROWSER = /\b(?:chrome|chromium|edge|firefox|brave|opera|vivaldi|arc|safari)\b/i;

/** The model's refusal when he answered her question with other words: those words are his next turn, not a no. */
export const answeredWithWords = (why: string): string =>
  `${why} He answered your question with other words, not a yes or a no, so it was not done yet. He did not decline, so do not say he did. His words come to you next; act on them then.`;

/**
 * His answer to a gate question: true or "always" (and do not ask about this again) is a yes, false a no, and
 * "words" means he said something else, which reaches the assistant as his next sentence.
 */
export type GateAnswer = boolean | "always" | "words";

export interface ConfirmPrompt {
  readonly title: string;
  readonly detail: string;
  readonly spoken: string;
  /** A question that runs out is a no, and no setting covers it. */
  readonly noOnExpiry: boolean;
  /** He may answer "always" (the card's Always allow): an ordinary ask on his own turn, not a command line or a read. */
  readonly canStand?: boolean;
}

/** What a device's or agent's turn may do without asking him: reading Tessaya's own state. Nothing on screen, no files. */
const OUTSIDE_READS: ReadonlySet<string> = new Set([
  "sessions_list",
  "sessions_find",
  "session_show",
  "fleet_status",
  "team_board",
  "memory_search",
  "memory_used",
  "memory_history",
  "wait",
  "jobs_list",
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
]);

/**
 * A drive's or lesson's differences from his assistant's gate: his approved plan is not its grant, the keys it is
 * allowed are its own (its harness never uses his input driver), and once it has read something its words are
 * never taken for his, so it asks before it types.
 */
export const forOperator = (input: {
  readonly taint: TurnTaint;
  readonly textIsHis: (text: string) => boolean;
}) => ({
  inPlan: () => null,
  keysAllowed: () => undefined,
  textIsHis: (text: string) => !input.taint.on() && input.textIsHis(text),
});

export const createAgentGate = (input: {
  readonly actWithoutAsking: () => boolean;
  readonly taint: TurnTaint;
  /** The text is his own words or Baton's own earlier reply, from the conversation. */
  readonly textIsHis: (text: string) => boolean;
  /** This turn's words came from a device or agent, not him: nothing counts as his, and every act follows a read. */
  readonly outside?: () => boolean;
  /** The window with the keyboard: its name, and whether it is a command line or cannot be told apart from one. */
  readonly focusedWindow: () => Promise<{
    readonly label: string;
    readonly shell: boolean;
    /** The window's handle, when the platform has one: a title can change under typing. */
    readonly window?: number;
  }>;
  readonly confirm: (prompt: ConfirmPrompt) => Promise<GateAnswer>;
  /**
   * His standing yeses ("go ahead and don't ask me again"), by tool, reason and app: an ordinary ask he has already
   * answered that way goes ahead. Never a risky one, never a device's turn.
   */
  readonly always?: {
    readonly has: (key: string) => boolean;
    readonly add: (key: string) => void;
  };
  /** A click's target is a text box in the last tree read. */
  readonly pointerField?: (tool: string, input: Readonly<Record<string, unknown>>) => boolean;
  readonly record: (entry: Readonly<Record<string, unknown>>) => void;
  /** He approved a plan for this turn (plan_show): its hands steps need no box each, except what stays risky. */
  readonly inPlan?: () => ReadonlyArray<string> | null;
  /** The persona this turn answers as: its own tool list narrows the gate, and every card names it. */
  readonly agent?: () => TrustAgent;
  /** The projects of a job by its id, so a project's own lead may split only its own project's jobs. */
  readonly jobProjects?: (id: string) => Promise<ReadonlyArray<ProjectRef> | null>;
  /** Keys were allowed for this window (a command line only when `shell` and he agreed); checked again when sent. */
  readonly keysAllowed?: (at: {
    readonly window?: number;
    readonly label: string;
    readonly shell: boolean;
  }) => void;
  /** His own Chrome (D3): whether social accounts are on, the clock, and a line sink for what is done on them. */
  readonly chrome?: {
    readonly socialOn: () => boolean;
    readonly now: () => number;
    readonly log: (line: string) => void;
  };
}): Gate => {
  let pageHost: string | null = null;
  /** Sessions already messaged with his yes, per job: later weaves in the same job are routine. */
  const weaveApproved = new Set<string>();
  const weaveKey = (c: ToolCall): string | null => {
    const job = c.input["job"];
    const to = c.input["session"];
    return typeof job === "string" && job !== "" && typeof to === "string"
      ? `${job}|${to.toLowerCase()}`
      : null;
  };
  const socialAt: number[] = [];
  const HOUR = 3_600_000;
  return async (call) => {
    const name = batonToolName(call.tool);
    const steps = name === "act_batch" ? (batchSteps(call.input) ?? []) : [];
    const words = call.input["text"] ?? call.input["value"] ?? call.input["goal"];
    const text =
      name === "act_batch"
        ? steps.map((s) => String(s.input["text"] ?? "")).join(" ")
        : typeof words === "string"
          ? words
          : "";
    const typing =
      name === "type_text" ||
      name === "press_keys" ||
      steps.some((s) => s.tool === "type_text" || s.tool === "press_keys");
    // type_text into a named window sets that window's box by value: it is the window judged, not the
    // one in front (0.1.65: Notepad named, a console in front, so it asked about a command line).
    const named =
      name === "type_text" && typeof call.input["window"] === "string"
        ? call.input["window"].trim()
        : "";
    const focus = !typing
      ? null
      : named !== ""
        ? { label: named, shell: namesShell(named) }
        : await input.focusedWindow();
    const browser = focus !== null && BROWSER.test(focus.label);
    const scope: TypingScope | null =
      name === "type_text" && focus !== null
        ? { window: focus.label, field: input.taint.field() }
        : null;
    const chromeCall = isChromeTool(call.tool);
    const callHost = chromeCall ? hostForCall(call.input, pageHost) : null;
    const social = callHost !== null && isSocialHost(callHost);
    const now = input.chrome?.now() ?? 0;
    const recent = socialAt.filter((t) => now - t < HOUR).length;
    const outside = input.outside?.() === true;
    const context = {
      ...(chromeCall
        ? {
            chrome: {
              socialOn: input.chrome?.socialOn() ?? false,
              pageHost,
              recentSocial: recent,
            },
          }
        : {}),
      actWithoutAsking: !outside && input.actWithoutAsking(),
      weaveStanding:
        name === "weave_send" && weaveKey(call) !== null && weaveApproved.has(weaveKey(call)!),
      tainted:
        outside || (input.taint.on() && !(scope !== null && input.taint.typingAllowedFor(scope))),
      ...(focus === null ? {} : { focusedShell: focus.shell }),
      ...(browser ? { browser: true } : {}),
      ...(input.taint.addressBar() === undefined ? {} : { addressBar: input.taint.addressBar()! }),
      ...(input.pointerField?.(name, call.input) === true ? { pointerField: true } : {}),
      textIsHis:
        !outside &&
        (name === "type_text" ||
          name === "act_batch" ||
          name === "session_send" ||
          name === "job_start" ||
          name === "job_split" ||
          name === "job_refine" ||
          name === "memory_remember" ||
          name === "weave_send" ||
          chromeCall) &&
        (input.textIsHis(text) ||
          textIsFromConversation(text, [{ said: input.taint.said(), reply: "" }])),
    };
    const agent = input.agent?.();
    const jobId = call.input["id"];
    const jobProjects =
      agent !== undefined &&
      !agent.lead &&
      (name === "job_split" || name === "job_handoff" || name === "job_schedule") &&
      typeof jobId === "string"
        ? ((await input.jobProjects?.(jobId).catch(() => null)) ?? null)
        : null;
    const trusted = decideTrust({
      call,
      context,
      plan: input.inPlan?.() ?? null,
      jobProjects,
      ...(agent === undefined ? {} : { agent }),
    });
    // A device's turn reads quietly; anything else it would do asks him first, whatever One Trust allows his own words.
    const judged =
      outside && trusted.verdict === "allow" && !OUTSIDE_READS.has(name)
        ? { verdict: "ask" as const, why: "A paired device asked for this, not you." }
        : trusted;
    const action = describeToolCall(call);
    /** A click names the box that typing goes to; Enter or a send ends any yes given to typing. */
    const after = () => {
      let bar = input.taint.addressBar();
      for (const step of name === "act_batch" ? steps : [{ tool: name, input: call.input }])
        bar = addressBarAfter(bar, step, browser);
      input.taint.setAddressBar(bar);
      if (name === "click" || name === "click_element") input.taint.noteField(fieldOf(call.input));
      if (name === "press_keys" || name === "session_send") input.taint.clearTyping();
      for (const step of steps) {
        if (step.tool === "click_element") input.taint.noteField(fieldOf(step.input));
        if (step.tool === "press_keys") input.taint.clearTyping();
      }
      if (name === "weave_send") {
        const key = weaveKey(call);
        if (key !== null) weaveApproved.add(key);
      }
    };
    const logSocial = (outcome: string) => {
      if (!social || callHost === null || input.chrome === undefined) return;
      input.chrome.log(
        socialLogLine({
          at: DateTime.formatIso(DateTime.makeUnsafe(now)),
          host: callHost,
          tool: call.tool,
          action,
          outcome,
        }),
      );
    };
    /** The tab goes where a navigation took it; later clicks are judged against that site. */
    const noteNavigation = () => {
      if (chromeCall && /__(navigate|tabs_create_mcp)$/.test(call.tool)) {
        pageHost = typeof call.input["url"] === "string" ? hostForCall(call.input, null) : pageHost;
      }
    };
    if (judged.verdict === "deny") {
      input.record({ tool: call.tool, action, outcome: "refused", why: judged.why });
      logSocial("refused");
      return { allow: false, reason: `${judged.why} Tell him why and stop.` };
    }
    /** `agreed`: he said yes to this call, so a command line it judged is one he agreed to. */
    const allowKeys = (agreed: boolean) => {
      if (focus !== null)
        input.keysAllowed?.({
          ...(focus.window === undefined ? {} : { window: focus.window }),
          label: focus.label,
          shell: focus.shell && agreed,
        });
    };
    const planCovers = "inPlan" in judged;
    if (judged.verdict === "allow") {
      noteNavigation();
      allowKeys(false);
      if (chromeReads(call.tool, call.input)) input.taint.mark();
      logSocial("allowed");
      after();
      input.record({
        tool: call.tool,
        action,
        outcome: planCovers ? "in his approved plan" : "allowed",
      });
      if (READS_OUTSIDE.has(name) || READS_OUTSIDE.has(call.tool)) input.taint.mark();
      return { allow: true };
    }
    const project = call.input["project"];
    const app = focus?.label.split(" - ").at(-1)?.trim() ?? "";
    const standingKey = `${name}|${judged.why}|${app}`;
    // Never for what follows a read or reaches a command line: that is what an injection would ask for.
    const canStand =
      input.always !== undefined &&
      judged.risky !== true &&
      !outside &&
      focus?.shell !== true &&
      !context.tainted;
    const standing = canStand && input.always?.has(standingKey) === true;
    const asked = gatePrompt(judged, action, {
      ...(agent === undefined ? {} : { agent: agent.name }),
      ...(typeof project === "string" && project !== "" ? { project } : {}),
      ...(typeof call.input["why"] === "string" ? { doing: call.input["why"] } : {}),
      ...(outside ? {} : { asked: input.taint.said() }),
    });
    const prompt = canStand ? { ...asked, canStand } : asked;
    const answer: GateAnswer = standing ? true : await input.confirm(prompt).catch(() => false);
    const yes = answer === true || answer === "always";
    if (answer === "always" && canStand) input.always?.add(standingKey);
    input.record({
      tool: call.tool,
      action,
      outcome: standing
        ? "allowed"
        : yes
          ? "he said yes"
          : answer === "words"
            ? "he answered with other words"
            : "he said no",
      ...(judged.risky === true ? { risky: true } : {}),
      why: standing ? `${judged.why} He said not to ask about this again.` : judged.why,
    });
    logSocial(yes ? "he said yes" : answer === "words" ? "not done" : "he said no");
    if (answer === "words") return { allow: false, reason: answeredWithWords(judged.why) };
    if (!yes) return { allow: false, reason: `${judged.why} He said no. Stop and tell him.` };
    // The yes was for the window judged before he was asked; keys must not follow focus elsewhere.
    if (focus !== null) {
      const now = await input.focusedWindow();
      const same =
        focus.window !== undefined && now.window !== undefined
          ? focus.window === now.window
          : focus.label === now.label;
      if (!same || now.shell !== focus.shell) {
        input.record({ tool: call.tool, action, outcome: "refused", why: "keyboard moved" });
        return {
          allow: false,
          reason:
            "The window with the keyboard changed while he was asked, so nothing was sent. Tell him, and ask him to click back into the window he wants.",
        };
      }
    }
    if (social) socialAt.push(now);
    noteNavigation();
    allowKeys(true);
    after();
    if (scope !== null && judged.risky !== true) input.taint.allowTyping(scope);
    if (READS_OUTSIDE.has(name) || READS_OUTSIDE.has(call.tool)) input.taint.mark();
    return { allow: true };
  };
};

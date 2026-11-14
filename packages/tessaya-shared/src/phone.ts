/**
 * What the phone page shows (docs/baton/MOBILE.md): the same lists the window has, boiled down to rows a small screen can
 * draw, plus the badge count. Pure; the server route reads the services and hands the results here.
 */
import type { TessayaJob, WatchFinding } from "@t3tools/tessaya-contracts";

import { buildApprovals, type Approval } from "./approvals.ts";
import {
  needsFromApprovals,
  needsFromFindings,
  needsFromJobs,
  rankNeeds,
  type NeedItem,
} from "./needsMe.ts";
import { retryRefusal } from "./jobReport.ts";
import { askLine, type PhoneAsk, type PhonePrompt } from "./phoneRelay.ts";
import type { WeaveRecord } from "./weave.ts";

export interface PhoneJobRow {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly canStop: boolean;
  /** Null when it can be retried; otherwise why not (shown, not hidden). */
  readonly retryWhy: string | null;
  readonly canRetry: boolean;
}

// A mirrored prompt names who asks in its own title and detail (the gate's card).
export interface PhoneApproval extends Omit<Approval, "kind" | "agent" | "project"> {
  /** A "prompt" is a question the desktop is asking him right now, mirrored here. */
  readonly kind: Approval["kind"] | "prompt";
  /** A job's plan or a mirrored question can be answered here; a session's question is answered in its thread. */
  readonly answerable: boolean;
  /** For a mirrored question: which button means yes and which means no. */
  readonly yes?: number;
  readonly cancel?: number;
  /** A question with more than two answers (the cloud card): one button each, none preselected. */
  readonly buttons?: ReadonlyArray<string>;
  /** A phone may answer only if its session holds this permission. */
  readonly needs?: "cloud-approve";
}

export interface PhoneAskRow {
  readonly id: string;
  readonly text: string;
  readonly status: string;
  readonly line: string;
}

export interface PhoneState {
  /** What the badge shows: the things waiting for his yes or his attention. */
  readonly badge: number;
  readonly needs: ReadonlyArray<NeedItem>;
  readonly approvals: ReadonlyArray<PhoneApproval>;
  readonly now: ReadonlyArray<string>;
  readonly jobs: ReadonlyArray<PhoneJobRow>;
  readonly weaves: ReadonlyArray<{
    readonly id: string;
    readonly line: string;
    readonly status: string;
  }>;
  /** Whether the desktop assistant is there to answer what the phone asks. */
  readonly desktop: { readonly connected: boolean };
  readonly asks: ReadonlyArray<PhoneAskRow>;
}

const RUNNING = new Set(["starting", "working", "monitoring"]);

const statusOf = (j: TessayaJob): string =>
  j.phase === "awaiting_agreement"
    ? "waiting for your OK"
    : j.limitReached !== null
      ? `stopped at its ${j.limitReached} limit`
      : j.group === "failed"
        ? "failed"
        : j.state === "done_unseen"
          ? "finished"
          : String(j.state).replaceAll("_", " ");

export const buildPhoneState = (input: {
  readonly jobs: ReadonlyArray<TessayaJob>;
  readonly findings: ReadonlyArray<WatchFinding>;
  readonly weaves: ReadonlyArray<WeaveRecord>;
  readonly now: number;
  readonly prompts?: ReadonlyArray<PhonePrompt>;
  readonly asks?: ReadonlyArray<PhoneAsk>;
  readonly desktopConnected?: boolean;
}): PhoneState => {
  const plans = buildApprovals({ jobs: input.jobs, sessions: [] });
  const mirrored = (input.prompts ?? []).map((p): PhoneApproval => ({
    id: `d:${p.id}`,
    kind: "prompt",
    title: p.title,
    action: p.detail,
    permission: "Asked on your computer; the first answer counts",
    ref: p.id,
    answerable: true,
    yes: p.yes,
    cancel: p.cancel,
    ...(p.buttons.length > 2 ? { buttons: p.buttons } : {}),
    ...(p.needs === undefined ? {} : { needs: p.needs }),
  }));
  const approvals = [
    ...mirrored,
    ...plans.map((a): PhoneApproval => ({ ...a, answerable: a.kind === "plan" })),
  ];
  const needs = rankNeeds(
    [
      ...mirrored.map((p): NeedItem => ({
        id: p.id,
        source: "approval",
        title: p.title,
        why: p.action.slice(0, 200),
        weight: 90,
        ref: p.ref,
      })),
      ...needsFromApprovals(plans),
      ...needsFromJobs(input.jobs, input.now),
      ...needsFromFindings(input.findings),
    ],
    input.now,
  );
  const doing = input.jobs.filter(
    (j) =>
      j.phase === "approved" &&
      j.group !== "failed" &&
      j.limitReached === null &&
      RUNNING.has(String(j.state)),
  );
  return {
    badge: needs.length,
    needs,
    approvals,
    now:
      doing.length === 0
        ? ["Nothing is running right now."]
        : doing.map((j) => `${j.title}: ${statusOf(j)}`),
    jobs: input.jobs.map((j) => {
      const retryWhy = retryRefusal(j);
      return {
        id: j.workSessionId,
        title: j.title,
        status: statusOf(j),
        canStop: j.phase === "approved" && j.group !== "failed" && j.limitReached === null,
        retryWhy,
        canRetry: retryWhy === null,
      };
    }),
    desktop: { connected: input.desktopConnected ?? false },
    asks: (input.asks ?? []).map((a) => ({
      id: a.id,
      text: a.text,
      status: a.status,
      line: askLine(a, input.desktopConnected ?? false),
    })),
    weaves: input.weaves.slice(0, 30).map((w) => ({
      id: w.id,
      line: `${w.from} to ${w.toLabel}: ${w.text.slice(0, 160)}`,
      status: w.status,
    })),
  };
};

/** The words an approve or deny button uses, from the exact action the approval would allow. */
export const decisionLabel = (a: Pick<Approval, "action">, decision: "approve" | "deny"): string =>
  decision === "approve" ? `Approve: ${a.action}` : `Deny: ${a.action}`;

export type PhoneDecision = "approve" | "deny";
export const parseDecision = (value: unknown): PhoneDecision | null =>
  value === "approve" || value === "deny" ? value : null;

/** A 16 kHz mono 16-bit WAV, the form the speech model takes; the page builds it, the server checks it. */
export const WAV_MAX_BYTES = 6 * 1024 * 1024;
export const checkWav = (bytes: Uint8Array): string | null => {
  if (bytes.byteLength < 44) return "That recording is empty.";
  if (bytes.byteLength > WAV_MAX_BYTES)
    return "That recording is too long. Keep it under three minutes.";
  const text = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (text(0, 4) !== "RIFF" || text(8, 12) !== "WAVE") return "That is not a WAV recording.";
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return view.getUint16(22, true) === 1 &&
    view.getUint32(24, true) === 16_000 &&
    view.getUint16(34, true) === 16
    ? null
    : "The recording must be 16 kHz mono 16-bit.";
};

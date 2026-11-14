import {
  OrchestrationFiringId,
  OrchestrationRuleId,
  ProviderInstanceId,
  ThreadId,
  WorkSessionId,
  type OrchestrationFiring,
  type OrchestrationRule,
  type OrchestrationRuleWithFirings,
} from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import { buildRuleRows, describeFiring, rulesByWorkSession } from "./batonRuleView";

const workSessionId = WorkSessionId.make("ws-scheduler");

const rule = (overrides?: Partial<OrchestrationRule>): OrchestrationRule => ({
  id: OrchestrationRuleId.make("rule-1"),
  workSessionId,
  source: "When Claude finishes this, have Codex review it.",
  trigger: { kind: "on_done" },
  action: {
    kind: "start_provider_session",
    providerInstanceId: ProviderInstanceId.make("codex"),
    model: "gpt-5",
    role: "review",
    runtimeMode: "approval-required",
    prompt: "Review the change.",
    title: "Review",
  },
  followUp: null,
  status: "enabled",
  maxFirings: 3,
  firedCount: 0,
  createdAt: "2026-09-18T05:00:00.000Z",
  updatedAt: "2026-09-18T05:00:00.000Z",
  lastFiredAt: null,
  ...overrides,
});

const firing = (overrides?: Partial<OrchestrationFiring>): OrchestrationFiring => ({
  id: OrchestrationFiringId.make("rule-1#1"),
  ruleId: OrchestrationRuleId.make("rule-1"),
  workSessionId,
  triggeredBy: "on_done:done_unseen",
  outcome: "completed",
  producedThreadId: ThreadId.make("review-thread"),
  detail: "Started codex as review.",
  startedAt: "2026-09-18T05:10:00.000Z",
  completedAt: "2026-09-18T05:10:02.000Z",
  ...overrides,
});

const entry = (
  ruleOverrides?: Partial<OrchestrationRule>,
  firings: readonly OrchestrationFiring[] = [],
): OrchestrationRuleWithFirings => ({ rule: rule(ruleOverrides), firings });

describe("buildRuleRows", () => {
  it("says what the rule will do and how much of its bound is left", () => {
    const [row] = buildRuleRows([entry()]);
    expect(row?.description).toBe("When this finishes, start codex as review.");
    expect(row?.budget).toBe("0 of 3 firings used");
    expect(row?.lastFiring).toBeNull();
  });

  it("shows the last firing once there is one", () => {
    const [row] = buildRuleRows([entry({ firedCount: 1 }, [firing()])]);
    expect(row?.budget).toBe("1 of 3 firings used");
    expect(row?.lastFiring).toBe("Started codex as review.");
  });

  it("says a rule stopped rather than leaving it looking live", () => {
    const [row] = buildRuleRows([entry({ status: "exhausted", firedCount: 3 }, [firing()])]);
    expect(row?.budget).toBe("stopped after its limit");
    expect(row?.status).toBe("exhausted");
  });

  it("surfaces a waiting confirmation gate and the firing to answer", () => {
    const [row] = buildRuleRows([
      entry({ firedCount: 1 }, [
        firing({
          outcome: "awaiting_confirmation",
          detail: "Restart the worker?",
          producedThreadId: null,
          completedAt: null,
        }),
      ]),
    ]);
    expect(row?.awaitingConfirmation).toBe(true);
    expect(row?.awaitingFiringId).toBe("rule-1#1");
    expect(row?.lastFiring).toBe("waiting for you — Restart the worker?");
  });
});

describe("describeFiring", () => {
  it("distinguishes a skip from a failure, because a skip is a correct result", () => {
    expect(
      describeFiring(firing({ outcome: "skipped", detail: "No active implementation session." })),
    ).toBe("skipped — No active implementation session.");
    expect(describeFiring(firing({ outcome: "failed", detail: "Could not start." }))).toBe(
      "failed — Could not start.",
    );
    expect(describeFiring(firing({ outcome: "started", detail: "" }))).toBe("running now");
  });
});

describe("rulesByWorkSession", () => {
  it("groups rules under the work they belong to", () => {
    const other = WorkSessionId.make("ws-other");
    const grouped = rulesByWorkSession([
      entry(),
      entry({ id: OrchestrationRuleId.make("rule-2") }),
      entry({ id: OrchestrationRuleId.make("rule-3"), workSessionId: other }),
    ]);
    expect(grouped.get(workSessionId)).toHaveLength(2);
    expect(grouped.get(other)).toHaveLength(1);
  });
});

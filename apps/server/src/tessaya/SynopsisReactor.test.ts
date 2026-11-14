import {
  EventId,
  MessageId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2DomainEvent,
} from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import { at } from "./__fixtures__/v2ThreadShell.ts";
import { synopsisSignalsForEvent } from "./SynopsisReactor.ts";

const threadId = ThreadId.make("thread-1");
const AT = "2026-09-18T04:00:00.000Z";

/** A v2 domain event with only the fields the mapping reads. */
const event = (type: string, payload: Record<string, unknown>) =>
  ({
    id: EventId.make("event-1"),
    threadId,
    occurredAt: at(AT),
    type,
    payload,
  }) as unknown as OrchestrationV2DomainEvent;

describe("synopsisSignalsForEvent (v2 domain events)", () => {
  it("reads a turn start from the user's own message, which is where the words are", () => {
    const pending = synopsisSignalsForEvent(
      event("message.updated", { id: MessageId.make("m1"), role: "user", text: "Find the race" }),
    );
    expect(pending?.signals).toEqual([{ kind: "turn-started", at: AT, prompt: "Find the race" }]);
    expect(pending?.dedupeKey).toBe("message:m1");
  });

  it("ignores the assistant's streaming text", () => {
    expect(
      synopsisSignalsForEvent(
        event("message.updated", { id: MessageId.make("m2"), role: "assistant", text: "Looking" }),
      ),
    ).toBeNull();
  });

  it("marks a completed run as the turn a written synopsis is for, once per run", () => {
    const pending = synopsisSignalsForEvent(
      event("run.updated", { id: RunId.make("run-1"), status: "completed" }),
    );
    expect(pending?.signals).toEqual([{ kind: "turn-completed", at: AT }]);
    expect(pending?.completedTurnId).toBe("run-1");
    expect(pending?.dedupeKey).toBe("run:run-1:completed");
  });

  it("reads a failed run as a failed turn and a running one as nothing", () => {
    expect(
      synopsisSignalsForEvent(event("run.updated", { id: RunId.make("run-2"), status: "failed" }))
        ?.signals,
    ).toEqual([{ kind: "turn-failed", at: AT, reason: null }]);
    expect(
      synopsisSignalsForEvent(event("run.updated", { id: RunId.make("run-3"), status: "running" })),
    ).toBeNull();
  });

  it("tells a question from an approval, and both from their answers", () => {
    const request = (kind: string, status: string) =>
      synopsisSignalsForEvent(
        event("runtime-request.updated", { id: RuntimeRequestId.make("r1"), kind, status }),
      )?.signals[0]?.kind;
    expect(request("user_input", "pending")).toBe("question-asked");
    expect(request("command", "pending")).toBe("approval-requested");
    expect(request("user_input", "resolved")).toBe("question-answered");
    expect(request("command", "resolved")).toBe("approval-resolved");
    expect(request("command", "expired")).toBeUndefined();
  });

  it("names a linked pull request by repository and number", () => {
    const pending = synopsisSignalsForEvent(
      event("thread.pull-request-link-updated", { repository: "RabHanz/tessaya", number: 6 }),
    );
    expect(pending?.signals).toEqual([
      { kind: "pull-request-opened", at: AT, label: "RabHanz/tessaya#6" },
    ]);
  });

  it("returns null for events that do not move the synopsis", () => {
    expect(synopsisSignalsForEvent(event("plan.updated", {}))).toBeNull();
  });
});

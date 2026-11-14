import type { TessayaJob, TessayaSessionSummary } from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import { approvalRecord, buildApprovals, describeApprovals } from "./approvals.ts";

describe("the approvals list", () => {
  it("lists plans waiting for an OK and sessions that asked him, and says so when none do", () => {
    const jobs = [
      {
        workSessionId: "j1",
        title: "Site",
        phase: "awaiting_agreement",
        permissionsSummary: "edit ~/site",
        terms: { permissions: { projects: ["Site"] } },
      },
      { workSessionId: "j2", title: "Audit", phase: "approved", permissionsSummary: "read" },
    ] as unknown as TessayaJob[];
    const sessions = [
      { key: "k1", session: "Fix bug", project: "App", box: "onyx", urgent: true },
      { key: "k2", session: "Idle", project: "App", box: "onyx", urgent: false },
    ] as unknown as TessayaSessionSummary[];
    const items = buildApprovals({ jobs, sessions });
    expect(items.map((i) => i.id)).toEqual(["p:j1", "s:k1"]);
    expect(items.map((i) => [i.agent, i.project])).toEqual([
      ["Tessaya", "Site"],
      ["Fix bug", "App"],
    ]);
    expect(describeApprovals(items)).toContain(
      '"Tessaya" in "Site" asks. Site: Start the work as planned. Would use: edit ~/site.',
    );
    expect(describeApprovals([])).toBe("Nothing is waiting for his yes.");
  });

  it("writes only his yes or no at the gate to the Record, naming the persona", () => {
    expect(
      approvalRecord({
        by: "assistant",
        persona: "Freya",
        tool: "t",
        action: "post the draft",
        outcome: "he said yes",
        why: "It sends.",
      }),
    ).toEqual({
      kind: "approval",
      actor: "Freya",
      subject: "post the draft",
      outcome: "approved",
      detail: "It sends.",
    });
    expect(approvalRecord({ by: "remote-hands", action: "x", outcome: "he said no" })?.actor).toBe(
      "a remote session",
    );
    expect(approvalRecord({ by: "assistant", action: "x", outcome: "allowed" })).toBeNull();
    // The operator's gate names the raw command; a secret in it never reaches the server.
    const token = "Bearer abcdefghijklmnop1234";
    const row = approvalRecord({
      by: "x",
      action: `curl -H '${token}'`,
      why: token,
      outcome: "he said yes",
    });
    expect(JSON.stringify(row)).not.toContain("abcdefghijklmnop1234");
  });
});

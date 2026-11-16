import { describe, expect, it } from "vite-plus/test";

import { approvalAction, approvalControls, cardAction, cardControls } from "./approvalRows.ts";

describe("the Approvals area", () => {
  it("offers Approve and Deny for a plan, Open for a session, and maps the buttons back", () => {
    const rows = approvalControls(
      [
        {
          id: "p:j1",
          kind: "plan",
          title: "Site",
          action: "Start",
          permission: "edit",
          ref: "j1",
          agent: "Tessaya",
          project: "Shop",
        },
        {
          id: "s:k1",
          kind: "session",
          title: "Bug",
          action: "Answer",
          permission: "its own",
          ref: "k1",
          agent: "Bug",
          project: null,
        },
      ],
      "ready",
    );
    expect(rows[0]).toMatchObject({
      id: "a:p:j1",
      button: "Approve",
      secondary: "Deny",
      hint: '"Tessaya" asks, in "Shop". Would use: edit',
    });
    expect(rows[1]).toMatchObject({ id: "a:s:k1", button: "Open T3" });
    expect(approvalAction("a:p:j1:later")).toEqual({ kind: "plan", ref: "j1", deny: true });
    expect(approvalAction("a:s:k1")).toEqual({ kind: "session", ref: "k1", deny: false });
    expect(approvalAction("a.load")).toBeNull();
    expect(approvalControls([], "ready")[0]).toMatchObject({ id: "a.empty" });
    expect(approvalControls([], "loading")[0]).toMatchObject({ id: "a.loading" });
    expect(approvalControls([], { error: "no window" })[0]).toMatchObject({
      id: "a.load",
      hint: "no window",
    });
  });

  it("answers a waiting card from his desk: yes and no on one row, other answers on their own", () => {
    const rows = cardControls([
      {
        id: "settings-1",
        title: "Change 2 settings, on 2 machines",
        detail: "d",
        buttons: ["Approve all", "Review each", "Deny"],
        yes: 0,
        cancel: 2,
        on: "laptop, studio",
      },
    ]);
    expect(rows.map((r) => r.id)).toEqual(["ac:0:2:settings-1", "ac:1:1:settings-1"]);
    expect(rows[0]).toMatchObject({ button: "Approve all", secondary: "Deny" });
    expect(cardAction("ac:0:2:settings-1")).toEqual({ id: "settings-1", index: 0 });
    expect(cardAction("ac:0:2:settings-1:later")).toEqual({ id: "settings-1", index: 2 });
    expect(cardAction("ac:1:1:settings-1")).toEqual({ id: "settings-1", index: 1 });
    expect(cardAction("a:p:j1")).toBeNull();
  });
});

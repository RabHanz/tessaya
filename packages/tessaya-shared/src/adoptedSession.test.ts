import type { AdoptedSessionCapabilities } from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  ADOPTED_MINIMUM_CAPABILITIES,
  capabilityRefusal,
  describeAdoptedSession,
  HERDR_CAPABILITIES,
  KNOWN_HERDR_STATES,
  mapHerdrPaneState,
  mapHerdrState,
  refuseCapability,
} from "./adoptedSession.ts";

describe("mapping a whole pane, which is not the same question as an agent", () => {
  it("uses the agent's state whenever there is one", () => {
    expect(mapHerdrPaneState({ agentStatus: "blocked", hasForegroundProcess: true })).toBe(
      "needs_input",
    );
    expect(mapHerdrPaneState({ agentStatus: "working", hasForegroundProcess: false })).toBe(
      "working",
    );
  });

  it("calls an unclassified pane with something running 'monitoring'", () => {
    // Every terminal that is not a recognised agent reports `unknown`, and that
    // is most of the terminals §9 exists to adopt. Refusing it would make them
    // permanently un-adoptable.
    expect(mapHerdrPaneState({ agentStatus: "unknown", hasForegroundProcess: true })).toBe(
      "monitoring",
    );
  });

  it("calls an unclassified pane at its prompt 'idle'", () => {
    expect(mapHerdrPaneState({ agentStatus: "unknown", hasForegroundProcess: false })).toBe("idle");
  });

  it("never raises 'needs me' on a pane it could not classify", () => {
    // The one wrong state that does real harm is a false alarm at the top of
    // the fleet. Only Herdr saying `blocked` earns that.
    for (const hasForegroundProcess of [true, false]) {
      const state = mapHerdrPaneState({ agentStatus: "unknown", hasForegroundProcess });
      expect(["needs_input", "needs_approval", "failed", "limited"]).not.toContain(state);
    }
  });

  it("still refuses a word it does not know, so D38 survives the fallback", () => {
    expect(mapHerdrPaneState({ agentStatus: "compacting", hasForegroundProcess: true })).toBeNull();
    expect(mapHerdrPaneState({ agentStatus: "", hasForegroundProcess: false })).toBeNull();
  });
});

describe("mapping a runtime's state", () => {
  it("is §9's table, and nothing else", () => {
    expect(mapHerdrState("blocked")).toBe("needs_input");
    expect(mapHerdrState("working")).toBe("working");
    expect(mapHerdrState("done")).toBe("done_unseen");
    expect(mapHerdrState("idle")).toBe("idle");
    expect(KNOWN_HERDR_STATES).toHaveLength(4);
  });

  it("calls blocked an answer rather than an approval", () => {
    // Herdr can tell that a pane is waiting for a human; it cannot tell
    // whether what it wants is an answer or permission. Claiming the stronger
    // one would put an approval badge on a session nobody can approve here.
    expect(mapHerdrState("blocked")).not.toBe("needs_approval");
  });

  it("refuses a word it does not know instead of calling it idle", () => {
    // A session that needs the user, sorted to the bottom of the fleet, is the
    // one wrong state that does real harm.
    expect(mapHerdrState("compacting")).toBeNull();
    expect(mapHerdrState("")).toBeNull();
  });

  it("ignores case and surrounding space, which a socket protocol will send", () => {
    expect(mapHerdrState(" Working ")).toBe("working");
  });
});

describe("declared capabilities", () => {
  it("assumes the least when a runtime says nothing", () => {
    expect(ADOPTED_MINIMUM_CAPABILITIES).toEqual({
      readConversation: false,
      sendInput: false,
      approvals: false,
      diffs: false,
      stop: false,
      // The one thing every runtime worth adopting can do, and what §21's
      // "show X" needs.
      showTerminal: true,
    });
  });

  it("gives Herdr what §9 says Herdr provides, and nothing more", () => {
    expect(HERDR_CAPABILITIES.sendInput).toBe(true);
    expect(HERDR_CAPABILITIES.showTerminal).toBe(true);
    expect(HERDR_CAPABILITIES.stop).toBe(true);
    // T3's thread machinery owns these, and an adopted pane has none of it.
    expect(HERDR_CAPABILITIES.readConversation).toBe(false);
    expect(HERDR_CAPABILITIES.approvals).toBe(false);
    expect(HERDR_CAPABILITIES.diffs).toBe(false);
  });

  it("refuses by name, before the button is pressed", () => {
    const refusal = refuseCapability({
      capabilities: HERDR_CAPABILITIES,
      capability: "approvals",
    });
    expect(refusal).toContain("approvals belong to a provider session Tessaya started");
    expect(
      refuseCapability({ capabilities: HERDR_CAPABILITIES, capability: "sendInput" }),
    ).toBeNull();
  });

  it("has a reason for every capability, so no refusal can be empty", () => {
    for (const capability of [
      "readConversation",
      "sendInput",
      "approvals",
      "diffs",
      "stop",
      "showTerminal",
    ] as const) {
      expect(capabilityRefusal(capability).length).toBeGreaterThan(0);
    }
  });
});

describe("describeAdoptedSession", () => {
  const capabilities: AdoptedSessionCapabilities = HERDR_CAPABILITIES;

  it("says what it is, where it runs, and what Baton cannot do with it", () => {
    expect(
      describeAdoptedSession({
        label: "hermes",
        runtime: "herdr",
        host: "harbour",
        capabilities,
      }),
    ).toBe("hermes (herdr on harbour) — adopted, so no readConversation, approvals, diffs");
  });

  it("says nothing about limits when there are none", () => {
    expect(
      describeAdoptedSession({
        label: "hermes",
        runtime: "herdr",
        host: null,
        capabilities: {
          readConversation: true,
          sendInput: true,
          approvals: true,
          diffs: true,
          stop: true,
          showTerminal: true,
        },
      }),
    ).toBe("hermes (herdr)");
  });
});

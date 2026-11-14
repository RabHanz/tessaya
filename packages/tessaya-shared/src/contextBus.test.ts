import { CONTEXT_SNAPSHOT_TTL_MS, type TessayaContextSnapshot } from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  applyContextSnapshot,
  describeInjectionTarget,
  dropContextProducer,
  emptyContextBus,
  liveSnapshots,
  resolveContextWorkSession,
  resolveInjectionTarget,
  type ContextBusState,
} from "./contextBus.ts";

const at = (minute: number): string => `2026-09-18T07:${String(minute).padStart(2, "0")}:00.000Z`;
const now = Date.parse(at(10));

const snapshot = (overrides: Partial<TessayaContextSnapshot>): TessayaContextSnapshot => ({
  producer: "fabric",
  observedAt: at(10),
  foregroundApplication: null,
  activeWindowTitle: null,
  activeWorkSessionId: null,
  activeThreadId: null,
  vscode: null,
  browser: null,
  editableTarget: null,
  recentVoiceTarget: null,
  ...overrides,
});

const busOf = (...snapshots: readonly TessayaContextSnapshot[]): ContextBusState =>
  snapshots.reduce(applyContextSnapshot, emptyContextBus);

describe("the context bus", () => {
  it("keeps one slot per producer, so a quiet producer erases nothing", () => {
    const bus = busOf(
      snapshot({ producer: "fabric", activeWorkSessionId: "ws-scheduler" as never }),
      snapshot({ producer: "vscode", observedAt: at(11) }),
    );
    expect(bus.snapshots.size).toBe(2);
    expect(bus.snapshots.get("fabric")?.activeWorkSessionId).toBe("ws-scheduler");
  });

  it("drops a late arrival rather than letting it overwrite the present", () => {
    // IPC does not promise ordering, and a stale snapshot applied last is a
    // context bus lying about where the user is.
    const bus = busOf(
      snapshot({ producer: "browser", observedAt: at(10) }),
      snapshot({ producer: "browser", observedAt: at(5) }),
    );
    expect(bus.snapshots.get("browser")?.observedAt).toBe(at(10));
  });

  it("forgets a producer that disconnected", () => {
    const bus = dropContextProducer(busOf(snapshot({ producer: "vscode" })), "vscode");
    expect(bus.snapshots.size).toBe(0);
  });

  it("stops counting a fact that has gone stale", () => {
    const bus = busOf(snapshot({ producer: "vscode", observedAt: at(5) }));
    expect(liveSnapshots(bus, Date.parse(at(5)) + 1_000)).toHaveLength(1);
    // Routing into a VS Code window that closed ten minutes ago is exactly the
    // failure §14 exists to prevent.
    expect(liveSnapshots(bus, Date.parse(at(5)) + CONTEXT_SNAPSHOT_TTL_MS + 1)).toHaveLength(0);
  });
});

describe("§14's ladder over the bus", () => {
  it("prefers the voice conversation's own target", () => {
    const bus = busOf(
      snapshot({ producer: "fabric", activeWorkSessionId: "ws-open" as never }),
      snapshot({ producer: "voice", recentVoiceTarget: "ws-spoken" as never }),
    );
    const resolved = resolveContextWorkSession(bus, { now });
    expect(resolved.workSessionId).toBe("ws-spoken");
    expect(resolved.rung).toBe("voice_conversation");
  });

  it("falls to what is open in Baton when no conversation is running", () => {
    const bus = busOf(snapshot({ producer: "fabric", activeWorkSessionId: "ws-open" as never }));
    const resolved = resolveContextWorkSession(bus, { now });
    expect(resolved.workSessionId).toBe("ws-open");
    expect(resolved.rung).toBe("fabric_focus");
  });

  it("uses a VS Code window only when it is already linked to work", () => {
    const unlinked = busOf(
      snapshot({
        producer: "vscode",
        vscode: {
          workspaceFolder: "/home/dev/vantageos",
          remoteAuthority: "ssh-remote",
          repositoryRoot: "/home/dev/vantageos",
          branch: "main",
          visibleFile: "src/index.ts",
          hasSelection: false,
          activeTerminalName: null,
          workSessionId: null,
        },
      }),
    );
    // An unlinked window says where the user is, not what they mean.
    expect(resolveContextWorkSession(unlinked, { now }).rung).toBe("none");

    const linked = busOf(
      snapshot({
        producer: "vscode",
        vscode: {
          workspaceFolder: "/home/dev/vantageos",
          remoteAuthority: null,
          repositoryRoot: "/home/dev/vantageos",
          branch: "main",
          visibleFile: null,
          hasSelection: false,
          activeTerminalName: "claude",
          workSessionId: "ws-scheduler" as never,
        },
      }),
    );
    const resolved = resolveContextWorkSession(linked, { now });
    expect(resolved.workSessionId).toBe("ws-scheduler");
    expect(resolved.rung).toBe("vscode");
    expect(resolved.evidence).toContain("/home/dev/vantageos");
  });

  it("falls back to what moved last, and says that is what it did", () => {
    const resolved = resolveContextWorkSession(emptyContextBus, {
      now,
      mostRecentWorkSessionId: "ws-recent",
    });
    expect(resolved.workSessionId).toBe("ws-recent");
    expect(resolved.rung).toBe("most_recent");
  });

  it("answers nothing rather than inventing a rung", () => {
    // §14's rung 8 is a semantic resolver. There is no model here, so the
    // ladder stops instead of guessing.
    const resolved = resolveContextWorkSession(emptyContextBus, { now });
    expect(resolved.workSessionId).toBeNull();
    expect(resolved.rung).toBe("none");
  });

  it("ignores a stale rung and uses the next live one", () => {
    const bus = busOf(
      snapshot({ producer: "voice", observedAt: at(1), recentVoiceTarget: "ws-old" as never }),
      snapshot({ producer: "fabric", observedAt: at(10), activeWorkSessionId: "ws-now" as never }),
    );
    const resolved = resolveContextWorkSession(bus, { now });
    expect(resolved.workSessionId).toBe("ws-now");
  });
});

describe("where dictation would go", () => {
  const editable = {
    producer: "browser" as const,
    kind: "editable" as const,
    label: "Gmail compose",
    injectable: true,
    origin: "https://mail.google.com",
  };

  it("takes the newest producer that can actually accept text", () => {
    const bus = busOf(
      snapshot({
        producer: "vscode",
        observedAt: at(8),
        editableTarget: { ...editable, producer: "vscode", label: "the editor" },
      }),
      snapshot({ producer: "browser", observedAt: at(10), editableTarget: editable }),
    );
    expect(resolveInjectionTarget(bus, { now })?.label).toBe("Gmail compose");
  });

  it("is not a target when the producer says it cannot insert", () => {
    // A field that is reported but cannot be written to is not a destination.
    // Pretending otherwise is how dictation silently goes nowhere.
    const bus = busOf(
      snapshot({ producer: "browser", editableTarget: { ...editable, injectable: false } }),
    );
    expect(resolveInjectionTarget(bus, { now })).toBeNull();
    expect(describeInjectionTarget(bus, { now }).reason).toContain("Gmail compose");
  });

  it("says nothing is reporting, rather than nothing is focused, when the bus is empty", () => {
    expect(describeInjectionTarget(emptyContextBus, { now }).reason).toContain(
      "Nothing is reporting",
    );
  });

  it("says nothing editable is focused when producers are live but have no field", () => {
    const bus = busOf(snapshot({ producer: "browser" }));
    expect(describeInjectionTarget(bus, { now }).reason).toBe("Nothing editable is focused.");
  });
});

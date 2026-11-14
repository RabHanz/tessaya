// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { DEFAULT_POLICY, type Answer, type Trigger } from "@t3tools/tessaya-shared/initiative";
import { describe, expect, it } from "vite-plus/test";

import { createInitiative } from "./initiativeEngine.ts";

const trigger: Trigger = {
  id: "fail:a",
  kind: "session_failed",
  topic: "ws:a",
  title: "Build",
  offer: "Build failed. Want me to look?",
  importance: 85,
  urgency: 60,
  yes: { kind: "job", goal: "look" },
};

const make = (answer: Answer, act: () => Promise<string>) => {
  const told: string[] = [];
  const shown: string[] = [];
  const engine = createInitiative({
    dir: NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "init-")),
    now: () => Date.parse("2026-11-02T12:00:00Z"),
    hour: () => 12,
    policy: () => DEFAULT_POLICY,
    gather: async () => [trigger],
    present: async (o) => (shown.push(o.offer), answer),
    act,
    tell: (t) => told.push(t),
  });
  return { engine, told, shown };
};

describe("the initiative engine", () => {
  it("shows an offer once and runs the Yes", async () => {
    const { engine, told, shown } = make("yes", async () => "Started.");
    expect(await engine.tick()).toBe(1);
    expect(await engine.tick()).toBe(0);
    expect(shown).toEqual(["Build failed. Want me to look?"]);
    expect(told).toEqual(["Started."]);
  });
  it("says so when a Yes cannot be carried out, and does nothing on Never", async () => {
    const failing = make("yes", async () => {
      throw new Error("no such project");
    });
    await failing.engine.tick();
    expect(failing.told).toEqual(["I could not do that: no such project"]);
    const never = make("never", async () => "x");
    await never.engine.tick();
    expect(never.told).toEqual([]);
    expect(never.engine.state().never).toEqual(["ws:a"]);
    expect(never.engine.resume("build")).toBe("I will tell you about these again: Build.");
  });
  it("does nothing when the policy is off", async () => {
    const { engine, shown } = make("yes", async () => "x");
    const off = createInitiative({
      dir: NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "init-")),
      now: () => 0,
      hour: () => 12,
      policy: () => null,
      gather: async () => [trigger],
      present: async () => "yes",
      act: async () => "x",
      tell: () => undefined,
    });
    expect(await off.tick()).toBe(0);
    expect(shown).toEqual([]);
    expect(engine.state().offered).toEqual({});
  });
});

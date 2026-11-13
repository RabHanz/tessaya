import { describe, expect, it } from "vite-plus/test";

import { createAgentGate, createTaint } from "./agentGate.ts";
import { buildBatonTools, type ToolHost } from "./batonTools.ts";
import { createOutsideSlot } from "./outsideSlot.ts";

const stop = { tool: "mcp__baton__job_stop", input: { id: "j1" } };

describe("a paired device's turn, overlapping one of his", () => {
  it("keeps its own trust, memory view and tools whatever his turn does meanwhile", async () => {
    const memoryCalls: Array<[string, Record<string, unknown>]> = [];
    const asked: string[] = [];
    const expiresAsNo: boolean[] = [];
    const host = {
      memory: async () => "he said: the deploy key is in 1Password",
      remember: async () => "",
      forget: async () => "",
      jobs: async () => "sent",
      planShow: async () => "approved",
      guided: async () => "started",
      vault: { list: async () => "github-token", use: async () => "", savePending: async () => "" },
      rememberPrivate: async () => "Kept in his private memories.",
    } as unknown as ToolHost;
    const slot = createOutsideSlot({
      host,
      memoryCall: async (op, args) => {
        memoryCalls.push([op, args]);
        return { items: [], hits: [] };
      },
      notes: { list: () => [] } as never,
      focusedWindow: async () => ({ label: "notepad.exe: notes", shell: false }),
      confirm: async (p) => (asked.push(p.title), expiresAsNo.push(p.noOnExpiry), false),
      record: () => undefined,
    });
    // His turn: his own gate, which lets a quiet act through.
    const hisTaint = createTaint();
    const his = createAgentGate({
      actWithoutAsking: () => true,
      taint: hisTaint,
      textIsHis: () => true,
      focusedWindow: async () => ({ label: "notepad.exe: notes", shell: false }),
      confirm: async () => true,
      record: () => undefined,
    });

    slot.beginTurn("stop job j1");
    // He speaks mid-turn; his turn begins and allows the act.
    hisTaint.reset("stop job j1");
    const [hisVerdict, deviceVerdict] = await Promise.all([his(stop), slot.gate(stop)]);
    expect(hisVerdict.allow).toBe(true);
    expect(deviceVerdict.allow).toBe(false);
    expect(asked).toHaveLength(1);
    // A device's question that times out is a no.
    expect(expiresAsNo).toEqual([true]);

    // Its memory search names no persona and never reaches his conversation; it has no vault.
    expect(await slot.host.memory("deploy key")).toBe("Nothing earlier matches.");
    expect(memoryCalls.every(([, args]) => args["agent"] === undefined)).toBe(true);
    expect(slot.host.vault).toBeUndefined();
    // Nor a private store: a device's turn cannot keep or read anyone's private memories.
    expect(slot.host.rememberPrivate).toBeUndefined();
    expect(buildBatonTools(slot.host).map((t) => t.name)).not.toContain("private_remember");
    const vaultList = buildBatonTools(slot.host).find((t) => t.name === "vault_list")!;
    expect((await vaultList.run({})).text).toBe("There is no vault on this computer.");

    // No plan, no lesson, and a weave with a secret is neither sent nor offered to his vault.
    expect(await slot.host.planShow!({ title: "Tidy", steps: ["a"] } as never)).toContain("cannot");
    expect(await slot.host.guided!("teach", "x")).toContain("cannot");
    expect(await slot.host.jobs("weave_send", { text: "ghp_" + "a".repeat(36) })).toContain(
      "Nothing was sent",
    );
    expect(await slot.host.jobs("weave_send", { text: "hello" })).toBe("sent");
  });

  it("once closed, refuses, runs no tool, stops typing between chunks, and waits for what was running", async () => {
    const typed: string[] = [];
    let finishSlow = () => {};
    const slow = new Promise<{ text: string }>(
      (resolve) => (finishSlow = () => resolve({ text: "done" })),
    );
    const slot = createOutsideSlot({
      host: {
        memory: async () => "",
        remember: async () => "",
        forget: async () => "",
        jobs: async () => "",
        type: async (text: string) => (typed.push(text), "ok"),
      } as unknown as ToolHost,
      memoryCall: async () => ({ items: [], hits: [] }),
      notes: { list: () => [] } as never,
      focusedWindow: async () => ({ label: "notepad.exe: notes", shell: false }),
      confirm: async () => true,
      record: () => undefined,
    });
    const [tool] = slot.guard([
      { name: "slow", description: "", inputSchema: {}, run: () => slow },
    ]);
    const running = tool!.run({});
    let closed = false;
    const closing = slot.close(60_000).then(() => (closed = true));
    // Closing waits for the tool already running.
    expect(closed).toBe(false);
    finishSlow();
    await closing;
    expect(await running).toEqual({ text: "done" });

    expect((await tool!.run({})).text).toContain("Stopped");
    expect((await slot.gate({ tool: "mcp__baton__jobs_list", input: {} })).allow).toBe(false);
    expect(await slot.host.type("a".repeat(100))).toContain("Stopped");
    expect(typed).toEqual([]);
  });

  it("may propose a standing job, never set one up, change or remove one of his", async () => {
    const ops: string[] = [];
    const host = {
      jobs: async (op: string) => (ops.push(op), "ok"),
      memory: async () => "",
      remember: async () => "",
      forget: async () => "",
    } as unknown as ToolHost;
    const slot = createOutsideSlot({
      host,
      memoryCall: async () => ({ items: [], hits: [] }),
      notes: { list: () => [] } as never,
      focusedWindow: async () => ({ label: "notepad.exe: notes", shell: false }),
      confirm: async () => false,
      record: () => undefined,
    });
    await slot.host.jobs("user_job_create", { title: "t" });
    const refused = await slot.host.jobs("user_job_delete", { id: "user:1" });
    await slot.host.jobs("user_job_update", { id: "user:1", on: true });
    expect(ops).toEqual(["user_job_propose"]);
    expect(refused).toContain("Only he can");
  });
  it("reads the team board as no persona, so walled work stays hidden from a device (P4)", async () => {
    const seen: Array<Record<string, unknown>> = [];
    const host = {
      jobs: async (_op: string, args: Record<string, unknown>) => (seen.push(args), "ok"),
    } as unknown as ToolHost;
    const slot = createOutsideSlot({
      host,
      memoryCall: async () => ({ items: [], hits: [] }),
      notes: { list: () => [] } as never,
      focusedWindow: async () => ({ label: "notepad.exe: notes", shell: false }),
      confirm: async () => false,
      record: () => undefined,
    });
    await slot.host.jobs("team", { agent: "executive", admin: true });
    expect(seen).toEqual([{}]);
  });

  it("a standing job's run recalls as the persona that owns it", async () => {
    const memoryCalls: Array<Record<string, unknown>> = [];
    const slot = createOutsideSlot({
      host: {} as ToolHost,
      memoryCall: async (_op, args) => {
        memoryCalls.push(args);
        return { block: "", items: [], hits: [] };
      },
      notes: { list: () => [] } as never,
      focusedWindow: async () => ({ label: "notepad.exe: notes", shell: false }),
      confirm: async () => false,
      record: () => undefined,
      agent: "operations",
    });
    await slot.memory.forSentence("check the invoices");
    expect(memoryCalls[0]?.["agent"]).toBe("operations");
  });
});

describe("a saved person's or guest's turn (identity I-2)", () => {
  it("is refused what their role may not reach, before anyone is asked", async () => {
    const asked: string[] = [];
    const slotFor = (role: "child" | "adult") =>
      createOutsideSlot({
        host: {} as unknown as ToolHost,
        memoryCall: async () => ({ items: [], hits: [] }),
        notes: { list: () => [] } as never,
        focusedWindow: async () => ({ label: "notepad.exe: notes", shell: false }),
        confirm: async (p) => (asked.push(p.title), false),
        record: () => undefined,
        principal: async () => ({ role, assurance: 2 }),
      });
    const bash = { tool: "Bash", input: { command: "ls" } };
    const child = await slotFor("child").gate(bash);
    expect(child.allow).toBe(false);
    expect(asked).toEqual([]);
    // An adult without the machine grant is refused this computer too; the base rules decide the rest.
    expect((await slotFor("adult").gate(bash)).allow).toBe(false);
    expect(asked).toEqual([]);
  });
});

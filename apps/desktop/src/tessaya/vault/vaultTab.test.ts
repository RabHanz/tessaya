// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import { createVaultTab } from "./vaultTab.ts";
import { createVault } from "./vaultStore.ts";

const FAKE = "fake-test-value-1234";

const make = (hello: "verified" | "declined" | "unavailable" = "verified") => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-vtab-"));
  const vault = createVault({ file: NodePath.join(dir, "v.json"), kdf: { N: 1024, r: 8, p: 1 } });
  let clip = "";
  const audit: string[] = [];
  const refresh = vi.fn();
  const save = vi.fn<(key: string) => Promise<string | null>>();
  const tab = createVaultTab({
    vault,
    hello: async () => hello,
    clipboard: { read: () => clip, write: (t) => void (clip = t), clear: () => void (clip = "") },
    audit: (l) => void audit.push(l),
    readAudit: () => audit,
    stateDir: dir,
    refresh,
    reveal: vi.fn(),
    saveRecovery: save,
    printRecovery: async () => true,
  });
  return { tab, vault, audit, clip: () => clip, dir, refresh, save };
};
const bar = (t: ReturnType<typeof make>) =>
  t.tab.controls()[0] as { state: string; recovery: string | null; status: string };

describe("the Vault tab", () => {
  it("makes the vault, shows the recovery key once, unlocks and locks", async () => {
    const t = make();
    expect(bar(t).state).toBe("none");
    t.tab.act("vt.create", "correct horse battery");
    expect(bar(t).recovery).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){12}$/);
    expect(bar(t).state).toBe("unlocked");
    t.tab.act("vt.recoveryDone", null);
    expect(bar(t).recovery).toBeNull();
    t.tab.act("vt.lock", null);
    expect(t.tab.controls()).toHaveLength(1);
    t.tab.act("vt.unlock", "wrong passphrase");
    expect(bar(t).status).toContain("did not open");
    t.tab.act("vt.unlock", "correct horse battery");
    expect(bar(t).state).toBe("unlocked");
  });

  it("lists names with policies and shows a value only after a reveal, then hides it", async () => {
    vi.useFakeTimers();
    const t = make();
    t.tab.act("vt.create", "correct horse battery");
    t.tab.act(
      "vt.add",
      JSON.stringify({ name: "github", label: "token", category: "key", value: FAKE }),
    );
    const item = () => t.tab.controls()[1] as { id: string; revealed: string | null; hint: string };
    expect(item().revealed).toBeNull();
    expect(JSON.stringify(t.tab.controls())).not.toContain(FAKE);
    const id = item().id.slice(3);
    t.tab.act(`vt.reveal:${id}`, null);
    await vi.advanceTimersByTimeAsync(1);
    expect(item().revealed).toBe(FAKE);
    expect(t.audit.join("")).toContain('"outcome":"revealed"');
    expect(t.audit.join("")).not.toContain(FAKE);
    await vi.advanceTimersByTimeAsync(15_001);
    expect(item().revealed).toBeNull();
    vi.useRealTimers();
  });

  it("a declined Hello reveals and copies nothing; financial keeps its rule", async () => {
    vi.useFakeTimers();
    const t = make("declined");
    t.tab.act("vt.create", "correct horse battery");
    t.tab.act(
      "vt.add",
      JSON.stringify({ name: "bank", label: "", category: "financial", value: FAKE }),
    );
    const id = (t.tab.controls()[1] as { id: string }).id.slice(3);
    t.tab.act(`vt.reveal:${id}`, null);
    await vi.advanceTimersByTimeAsync(1);
    expect((t.tab.controls()[1] as { revealed: string | null }).revealed).toBeNull();
    t.tab.act(`vt.copy:${id}`, null);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.clip()).toBe("");
    t.tab.act(`vt.policy:${id}`, "never");
    expect(t.tab.controls()[1] as { policy: string; locked: boolean }).toMatchObject({
      policy: "self",
      locked: true,
    });
    vi.useRealTimers();
  });

  it("copy clears the clipboard after 10 seconds, and a lock clears it and closes a shown value at once", async () => {
    vi.useFakeTimers();
    const t = make();
    t.tab.act("vt.create", "correct horse battery");
    t.tab.act("vt.add", JSON.stringify({ name: "g", label: "", category: "key", value: FAKE }));
    const id = (t.tab.controls()[1] as { id: string }).id.slice(3);
    t.tab.act(`vt.copy:${id}`, null);
    await vi.advanceTimersByTimeAsync(1);
    expect(t.clip()).toBe(FAKE);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(t.clip()).toBe("");
    t.tab.act(`vt.copy:${id}`, null);
    t.tab.act(`vt.reveal:${id}`, null);
    await vi.advanceTimersByTimeAsync(1);
    // The idle timer locks the store; the instance then calls onLock.
    t.vault.lock();
    t.tab.onLock();
    await vi.advanceTimersByTimeAsync(1);
    expect(t.clip()).toBe("");
    expect(t.tab.controls()).toHaveLength(1);
    expect(t.refresh).toHaveBeenCalled();
    vi.useRealTimers();
  });

  it("saves or prints the recovery key only while it is on show", async () => {
    const t = make();
    const saved: string[] = [];
    t.save.mockImplementation(async (k: string) => (saved.push(k), "D:\\usb\\key.txt"));
    t.tab.act("vt.recoverySave", null);
    await Promise.resolve();
    expect(saved).toEqual([]);
    t.tab.act("vt.create", "correct horse battery");
    t.tab.act("vt.recoverySave", null);
    await vi.waitFor(() => expect(bar(t).status).toContain("Saved to"));
    expect(saved[0]).toBe(bar(t).recovery);
    t.tab.act("vt.recoveryPrint", null);
    await vi.waitFor(() => expect(bar(t).status).toContain("Sent to the printer"));
  });

  it("deletes, exports without plaintext, and leaves other ids alone", () => {
    const t = make();
    t.tab.act("vt.create", "correct horse battery");
    t.tab.act("vt.add", JSON.stringify({ name: "one", label: "", category: "note", value: FAKE }));
    t.tab.act("vt.export", "export passphrase");
    expect(NodeFS.readFileSync(NodePath.join(t.dir, "vault-export.json"), "utf8")).not.toContain(
      FAKE,
    );
    t.tab.act(`vt.delete:${(t.tab.controls()[1] as { id: string }).id.slice(3)}`, null);
    expect(t.tab.controls()).toHaveLength(1);
    expect(t.tab.act("m.query", "x")).toBe(false);
  });
});

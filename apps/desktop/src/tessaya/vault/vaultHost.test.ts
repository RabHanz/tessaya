// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

import { createVaultHost } from "./vaultHost.ts";
import { createPendingSecret } from "./pendingSecret.ts";
import { createVault } from "./vaultStore.ts";

const FAKE = "fake-test-value-1234";

const setup = (
  over: {
    tainted?: boolean;
    yes?: boolean;
    run?: (c: string, e: Record<string, string>) => Promise<string>;
    hello?: "verified" | "declined" | "unavailable";
  } = {},
) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-vhost-"));
  const vault = createVault({ file: NodePath.join(dir, "v.json"), kdf: { N: 1024, r: 8, p: 1 } });
  vault.create("correct horse battery");
  vault.add({ name: "github", label: "GitHub token", category: "key", value: FAKE });
  vault.add({
    name: "bank",
    label: "Bank login",
    category: "financial",
    value: "fake-bank-pass-9",
  });
  let clip = "";
  const typed: string[] = [];
  const audit: string[] = [];
  const asked: string[] = [];
  const unlock = vi.fn();
  const host = createVaultHost({
    vault,
    confirm: async (title, detail) => (asked.push(`${title}\n${detail}`), over.yes ?? true),
    type: async (t) => void typed.push(t),
    clipboard: { read: () => clip, write: (t) => void (clip = t), clear: () => void (clip = "") },
    tainted: () => over.tainted ?? false,
    audit: (l) => void audit.push(l),
    askToUnlock: unlock,
    pending: createPendingSecret(),
    ...(over.hello === undefined ? {} : { hello: async () => over.hello! }),
    ...(over.run === undefined ? {} : { run: over.run }),
  });
  return { host, vault, typed, audit, asked, unlock, clip: () => clip };
};
const use = { name: "github", purpose: "sign in", target: "github.com", how: "type" as const };

describe("vault_use", () => {
  it("needs Windows Hello after his yes: declined uses nothing, verified or unavailable goes on", async () => {
    const no = setup({ hello: "declined" });
    expect(await no.host.use(use)).toContain("Windows Hello did not confirm");
    expect(no.typed).toEqual([]);
    expect(no.audit.join("")).toContain('"outcome":"declined"');
    const ok = setup({ hello: "verified" });
    await ok.host.use(use);
    expect(ok.typed).toEqual([FAKE]);
  });
  it("lists names without values, and injects without the model seeing the value", async () => {
    const t = setup();
    const listed = await t.host.list();
    expect(listed).toContain("github");
    expect(listed).not.toContain(FAKE);
    const said = await t.host.use(use);
    expect(t.typed).toEqual([FAKE]);
    expect(said).not.toContain(FAKE);
    expect(t.asked[0]).toContain("github.com");
    expect(t.asked[0]).not.toContain(FAKE);
    expect(t.audit.join("\n")).toContain('"outcome":"used"');
    expect(t.audit.join("\n")).not.toContain(FAKE);
  });

  it("a no uses nothing; a financial secret is never injected, even if he would say yes", async () => {
    const no = setup({ yes: false });
    expect(await no.host.use(use)).toContain("said no");
    expect(no.typed).toEqual([]);
    const bank = setup();
    expect(await bank.host.use({ ...use, name: "bank" })).toContain("type it yourself");
    expect(bank.typed).toEqual([]);
    expect(bank.asked).toEqual([]);
  });

  it("a domain approval skips the question for the same target, not after a taint", async () => {
    const t = setup();
    const id = t.vault.list().find((i) => i.name === "github")!.id;
    t.vault.update(id, { policy: { mode: "domain", minutes: 10 } });
    await t.host.use(use);
    await t.host.use(use);
    expect(t.asked).toHaveLength(1);
    await t.host.use({ ...use, target: "other.test" });
    expect(t.asked).toHaveLength(2);
    const tainted = setup({ tainted: true });
    const tid = tainted.vault.list().find((i) => i.name === "github")!.id;
    tainted.vault.update(tid, { policy: { mode: "domain", minutes: 10 } });
    await tainted.host.use(use);
    await tainted.host.use(use);
    expect(tainted.asked).toHaveLength(2);
  });

  it("paste clears the clipboard after ten seconds; a command's output comes back scrubbed", async () => {
    vi.useFakeTimers();
    const t = setup({ run: async (_c, env) => `token=${env["SECRET"]} ok` });
    await t.host.use({ ...use, how: "paste" });
    expect(t.clip()).toBe(FAKE);
    await vi.advanceTimersByTimeAsync(10_001);
    expect(t.clip()).toBe("");
    const said = await t.host.use({ ...use, how: "env", command: "echo" });
    expect(said).toContain("[vault:github]");
    expect(said).not.toContain(FAKE);
    vi.useRealTimers();
  });

  it("when locked it opens the tab and uses nothing", async () => {
    const t = setup();
    t.vault.lock();
    expect(await t.host.use(use)).toContain("locked");
    expect(t.unlock).toHaveBeenCalled();
  });

  it("a secret offered from a conversation is filed without going back through the model", async () => {
    const t = setup();
    const offer = t.host.offer("hunter-fake-pass-77", "a password or key");
    expect(offer).toContain("Want it in the vault");
    expect(offer).not.toContain("hunter-fake-pass-77");
    expect(await t.host.savePending("wifi", "login")).toContain("Filed as wifi");
    expect(t.vault.valueOf("wifi")?.value).toBe("hunter-fake-pass-77");
    expect(await t.host.savePending("again", "login")).toContain("no secret waiting");
  });
});

import { describe, expect, it } from "vite-plus/test";

import { createAgentGate, createTaint } from "./agentGate.ts";

const P = "mcp__baton__web_";

const rig = (
  socialOn: boolean,
  yes = true,
  planLeases?: Parameters<typeof createAgentGate>[0]["planLeases"],
) => {
  const log: string[] = [];
  const asked: string[] = [];
  const taint = createTaint();
  let now = Date.parse("2026-11-03T10:00:00.000Z");
  const gate = createAgentGate({
    actWithoutAsking: () => true,
    taint,
    textIsHis: () => false,
    focusedWindow: async () => ({ label: "Chrome", shell: false }),
    confirm: async (p) => (asked.push(p.detail), yes),
    record: () => undefined,
    chrome: { socialOn: () => socialOn, now: () => (now += 1000), log: (l) => log.push(l) },
    ...(planLeases === undefined ? {} : { planLeases }),
  });
  return { gate, log, asked, taint };
};

describe("the gate on his browser through the bridge", () => {
  it("an Always allow on one site holds on that site only (GEN-21a)", async () => {
    const kept = new Set<string>();
    let asked = 0;
    const gate = createAgentGate({
      actWithoutAsking: () => true,
      taint: createTaint(),
      textIsHis: () => false,
      focusedWindow: async () => ({ label: "Shop - Google Chrome", shell: false }),
      confirm: async () => (asked++, "always"),
      record: () => undefined,
      always: { has: (k) => kept.has(k), add: (k) => void kept.add(k) },
      chrome: { socialOn: () => false, now: () => 0, log: () => undefined },
    });
    const submit = (url: string) => ({
      tool: `${P}click`,
      input: { url, element: "Submit the form", ref: "e1" },
    });
    expect((await gate(submit("https://example.com/a"))).allow).toBe(true);
    expect((await gate(submit("https://example.com/b"))).allow).toBe(true);
    expect(asked).toBe(1);
    expect((await gate(submit("https://other.org/"))).allow).toBe(true);
    expect(asked).toBe(2);
    expect(
      [...kept].every((k) => k.endsWith("|site:example.com") || k.endsWith("|site:other.org")),
    ).toBe(true);
  });
  it("refuses a social site while it is off, and acts on nothing after being taken to one", async () => {
    const r = rig(false);
    expect(
      (await r.gate({ tool: `${P}navigate`, input: { url: "https://x.com/home" } })).allow,
    ).toBe(false);
    expect(
      (await r.gate({ tool: `${P}navigate`, input: { url: "https://example.com" } })).allow,
    ).toBe(true);
    expect((await r.gate({ tool: `${P}hover`, input: { element: "Menu", ref: "e2" } })).allow).toBe(
      true,
    );
  });
  it("with social on, shows what would be posted, asks each time, logs, and stops at ten an hour", async () => {
    const r = rig(true);
    expect(
      (await r.gate({ tool: `${P}navigate`, input: { url: "https://x.com/home" } })).allow,
    ).toBe(true);
    const post = {
      tool: `${P}type`,
      input: { text: "Hello from me", element: "tweet box", ref: "e3" },
    };
    for (let i = 0; i < 10; i++) expect((await r.gate(post)).allow).toBe(true);
    expect(r.asked.every((d) => d.includes("Hello from me"))).toBe(true);
    const eleventh = await r.gate(post);
    expect(eleventh.allow).toBe(false);
    expect(r.asked).toHaveLength(10);
    expect(r.log.some((l) => l.includes('"outcome":"he said yes"') && l.includes("x.com"))).toBe(
      true,
    );
    expect(r.log.at(-1)).toContain('"outcome":"refused"');
  });
  it("reads taint the turn, a no stops it, and money is never moved", async () => {
    const r = rig(false, false);
    await r.gate({ tool: `${P}snapshot`, input: {} });
    expect(r.taint.on()).toBe(true);
    expect(
      (await r.gate({ tool: `${P}click`, input: { element: "Submit", ref: "e1" } })).allow,
    ).toBe(false);
    expect(r.asked).toHaveLength(1);
    expect(
      (
        await r.gate({
          tool: `${P}click`,
          input: { element: "Transfer funds", ref: "e1" },
        })
      ).allow,
    ).toBe(false);
    expect(r.asked).toHaveLength(1);
  });
  it("runs a click after a read on a site his agreed plan leases, and asks on any other site", async () => {
    const lease = {
      job: "j1",
      persona: "butler",
      sites: ["booking.com"],
      apps: [],
      acts: ["open", "click"],
      until: Date.parse("2026-11-03T12:00:00.000Z"),
    };
    const r = rig(false, false, async () => ({ leases: [lease], persona: "butler" }));
    const click = { tool: `${P}click`, input: { element: "Reserve", ref: "e5" } };
    await r.gate({ tool: `${P}navigate`, input: { url: "https://www.booking.com/" } });
    await r.gate({ tool: `${P}snapshot`, input: {} });
    expect((await r.gate(click)).allow).toBe(true);
    expect(r.asked).toHaveLength(0);
    await r.gate({ tool: `${P}navigate`, input: { url: "https://example.com/" } });
    expect((await r.gate(click)).allow).toBe(false);
    expect(r.asked).toHaveLength(1);
  });
  it("asks his yes to Sebastian's exact words every time, even with acting without asking on", async () => {
    const asked: string[] = [];
    const gate = createAgentGate({
      actWithoutAsking: () => true,
      taint: createTaint(),
      textIsHis: () => true,
      focusedWindow: async () => ({ label: "Brave", shell: false }),
      confirm: async (p) => (asked.push(p.detail), true),
      record: () => undefined,
      chrome: {
        socialOn: () => true,
        owner: () => "sebastian",
        now: () => 0,
        log: () => undefined,
      },
    });
    const note = {
      tool: `${P}type`,
      input: { text: "Happy to help, Sam.", element: "Message", ref: "e9" },
    };
    expect((await gate(note)).allow).toBe(true);
    expect((await gate(note)).allow).toBe(true);
    expect(asked).toHaveLength(2);
    expect(asked.every((d) => d.includes('"Happy to help, Sam."'))).toBe(true);
  });
});

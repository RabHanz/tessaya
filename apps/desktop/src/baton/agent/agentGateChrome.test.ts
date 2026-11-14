import { describe, expect, it } from "vite-plus/test";

import { createAgentGate, createTaint } from "./agentGate.ts";

const P = "mcp__claude-in-chrome__";

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

describe("the gate on his own Chrome", () => {
  it("refuses a social site while it is off, and acts on nothing after being taken to one", async () => {
    const r = rig(false);
    expect(
      (await r.gate({ tool: `${P}navigate`, input: { url: "https://x.com/home" } })).allow,
    ).toBe(false);
    expect(
      (await r.gate({ tool: `${P}navigate`, input: { url: "https://example.com" } })).allow,
    ).toBe(true);
    expect((await r.gate({ tool: `${P}computer`, input: { action: "scroll" } })).allow).toBe(true);
  });
  it("with social on, shows what would be posted, asks each time, logs, and stops at ten an hour", async () => {
    const r = rig(true);
    expect(
      (await r.gate({ tool: `${P}navigate`, input: { url: "https://x.com/home" } })).allow,
    ).toBe(true);
    const post = { tool: `${P}form_input`, input: { value: "Hello from me", ref: "tweet box" } };
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
    await r.gate({ tool: `${P}get_page_text`, input: {} });
    expect(r.taint.on()).toBe(true);
    expect(
      (await r.gate({ tool: `${P}computer`, input: { action: "left_click", text: "Submit" } }))
        .allow,
    ).toBe(false);
    expect(r.asked).toHaveLength(1);
    expect(
      (
        await r.gate({
          tool: `${P}computer`,
          input: { action: "left_click", text: "Transfer funds" },
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
    const click = { tool: `${P}computer`, input: { action: "left_click", coordinate: [5, 5] } };
    await r.gate({ tool: `${P}navigate`, input: { url: "https://www.booking.com/" } });
    await r.gate({ tool: `${P}get_page_text`, input: {} });
    expect((await r.gate(click)).allow).toBe(true);
    expect(r.asked).toHaveLength(0);
    await r.gate({ tool: `${P}navigate`, input: { url: "https://example.com/" } });
    expect((await r.gate(click)).allow).toBe(false);
    expect(r.asked).toHaveLength(1);
  });
});

import { describe, expect, it } from "vite-plus/test";

import {
  chromeReads,
  isChromeTool,
  hostOf,
  isSocialHost,
  judgeChrome,
  moneyMovement,
  SOCIAL_PER_HOUR,
  type ChromeContext,
  addressBarHost,
} from "./webPolicy.ts";

const P = "mcp__baton__web_";
const base: ChromeContext = {
  tainted: false,
  socialOn: false,
  pageHost: null,
  recentSocial: 0,
  textIsHis: false,
};
const j = (name: string, input: Record<string, unknown>, ctx: Partial<ChromeContext> = {}) =>
  judgeChrome(`${P}${name}`, input, { ...base, ...ctx });

describe("the assistant in his browser, through the shared Playwright bridge", () => {
  it("reads, waits and opens ordinary pages without asking, and a snapshot or a screenshot taints", () => {
    for (const [n, i] of [
      ["snapshot", {}],
      ["take_screenshot", {}],
      ["wait_for", { text: "Done" }],
      ["tabs", { action: "list" }],
      ["navigate", { url: "https://example.com/a" }],
      ["hover", { element: "Menu", ref: "e3" }],
    ] as const)
      expect(j(n, i).verdict, n).toBe("allow");
    expect(chromeReads(`${P}snapshot`)).toBe(true);
    expect(chromeReads(`${P}take_screenshot`)).toBe(true);
    expect(chromeReads(`${P}click`)).toBe(false);
    expect(chromeReads("Read")).toBe(false);
    expect(isChromeTool(`${P}navigate`)).toBe(true);
    expect(isChromeTool("mcp__baton__browser_route")).toBe(false);
  });
  it("asks for a submit, a send, a delete, a purchase or a settings change, and for code or uploads", () => {
    expect(j("click", { element: "Submit button", ref: "e1" }).verdict).toBe("ask");
    expect(j("type", { element: "Send message", ref: "e2", text: "hello" }).verdict).toBe("ask");
    expect(j("click", { element: "Delete", ref: "e1" }).verdict).toBe("ask");
    expect(j("click", { element: "Place order", ref: "e1" })).toMatchObject({
      verdict: "ask",
      risky: true,
    });
    expect(j("press_key", { key: "Enter" }).verdict).toBe("ask");
    expect(j("type", { element: "Search", ref: "e2", text: "hi", submit: true }).verdict).toBe(
      "ask",
    );
    expect(j("evaluate", { function: "() => 1" })).toMatchObject({ verdict: "ask", risky: true });
    expect(j("file_upload", { paths: ["a.txt"] })).toMatchObject({ verdict: "ask", risky: true });
    expect(j("type", { element: "Notes", ref: "e2", text: "hello" }).verdict).toBe("allow");
    expect(
      j("type", { element: "Notes", ref: "e2", text: "hello" }, { tainted: true }).verdict,
    ).toBe("ask");
    expect(
      j("type", { element: "Notes", ref: "e2", text: "hello" }, { tainted: true, textIsHis: true })
        .verdict,
    ).toBe("allow");
  });
  it("never closes the browser, and closes a tab only by asking", () => {
    expect(j("close", {}).verdict).toBe("deny");
    expect(j("tabs", { action: "close", index: 2 }).verdict).toBe("ask");
  });
  it("refuses to move money, however it is asked", () => {
    for (const t of [
      "Transfer funds to savings",
      "wire $500",
      "Withdraw",
      "Confirm payment",
      "send money to Sam",
    ]) {
      expect(moneyMovement(t), t).toBe(true);
      expect(j("click", { element: t, ref: "e1" }).verdict).toBe("deny");
    }
    expect(moneyMovement("Read the pricing page")).toBe(false);
  });
  it("refuses social networks while social is off, wherever it is reached from", () => {
    expect(isSocialHost("m.instagram.com")).toBe(true);
    expect(isSocialHost("notfacebook.com")).toBe(false);
    expect(j("navigate", { url: "https://www.facebook.com" }).verdict).toBe("deny");
    expect(j("click", { element: "Like", ref: "e1" }, { pageHost: "x.com" }).verdict).toBe("deny");
    expect(j("snapshot", {}, { pageHost: "x.com" }).verdict).toBe("deny");
  });
  it("with social on, reads are routine; every post-like action asks and shows, and is rate-limited", () => {
    const on = { socialOn: true, pageHost: "x.com" };
    expect(j("navigate", { url: "https://x.com/home" }, on).verdict).toBe("allow");
    expect(j("snapshot", {}, on).verdict).toBe("allow");
    expect(j("click", { element: "Post", ref: "e1" }, on)).toMatchObject({
      verdict: "ask",
      risky: true,
    });
    expect(j("fill_form", { fields: [{ name: "Reply", value: "hi" }] }, on)).toMatchObject({
      verdict: "ask",
      risky: true,
    });
    expect(
      j("click", { element: "Post", ref: "e1" }, { ...on, recentSocial: SOCIAL_PER_HOUR }).verdict,
    ).toBe("deny");
    expect(hostOf("javascript:alert(1)")).toBeNull();
    expect(j("navigate", { url: "javascript:alert(1)" }, on).verdict).toBe("deny");
  });
  it("asks his yes to the exact words for every act Sebastian takes, even an ordinary one", () => {
    const seb = { owner: "sebastian" } as const;
    expect(j("snapshot", {}, seb).verdict).toBe("allow");
    expect(j("navigate", { url: "https://www.upwork.com/jobs" }, seb).verdict).toBe("allow");
    const typed = j(
      "type",
      { element: "Cover letter", ref: "e4", text: "Hi Sam, I can help." },
      seb,
    );
    expect(typed).toMatchObject({ verdict: "ask", risky: true });
    expect(typed.verdict === "ask" && typed.why).toContain('"Hi Sam, I can help."');
    expect(j("click", { element: "Next", ref: "e5" }, seb)).toMatchObject({
      verdict: "ask",
      risky: true,
    });
  });
});

describe("the site a browser window is on", () => {
  it("reads the address bar as ui_tree lists it, and nothing else", () => {
    expect(
      addressBarHost([
        "[2] button: Reload",
        '[3] edit: Address and search bar = "github.com/acme/app"',
      ]),
    ).toBe("github.com");
    expect(
      addressBarHost(['[3] edit: Address and search bar = "https://Shop.Example.com/a"']),
    ).toBe("shop.example.com");
    expect(addressBarHost(["[1] edit: Address and search bar"])).toBeNull();
    expect(addressBarHost(['[1] edit: Address = "C:\\Users\\someone"'])).toBeNull();
    expect(addressBarHost(['[1] edit: Search = "github.com"'])).toBeNull();
  });
});

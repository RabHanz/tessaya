import { describe, expect, it } from "vite-plus/test";

import {
  chromeReads,
  hostOf,
  isSocialHost,
  judgeChrome,
  moneyMovement,
  SOCIAL_PER_HOUR,
  type ChromeContext,
} from "./webPolicy.ts";

const P = "mcp__claude-in-chrome__";
const base: ChromeContext = {
  tainted: false,
  socialOn: false,
  pageHost: null,
  recentSocial: 0,
  textIsHis: false,
};
const j = (name: string, input: Record<string, unknown>, ctx: Partial<ChromeContext> = {}) =>
  judgeChrome(`${P}${name}`, input, { ...base, ...ctx });

describe("the assistant in his own Chrome", () => {
  it("reads, scrolls and opens ordinary pages without asking, and a screenshot or a read taints", () => {
    for (const [n, i] of [
      ["get_page_text", {}],
      ["read_page", {}],
      ["find", { query: "price" }],
      ["navigate", { url: "https://example.com/a" }],
      ["computer", { action: "scroll" }],
      ["computer", { action: "screenshot" }],
    ] as const)
      expect(j(n, i).verdict, n).toBe("allow");
    expect(chromeReads(`${P}get_page_text`, {})).toBe(true);
    expect(chromeReads(`${P}computer`, { action: "screenshot" })).toBe(true);
    expect(chromeReads(`${P}computer`, { action: "left_click" })).toBe(false);
    expect(chromeReads("Read", {})).toBe(false);
  });
  it("asks for a submit, a send, a delete, a purchase or a settings change, and for code or uploads", () => {
    expect(j("computer", { action: "left_click", text: "Submit" }).verdict).toBe("ask");
    expect(j("form_input", { value: "hello", ref: "Send message" }).verdict).toBe("ask");
    expect(j("computer", { action: "left_click", text: "Delete" }).verdict).toBe("ask");
    expect(j("computer", { action: "left_click", text: "Place order" })).toMatchObject({
      verdict: "ask",
      risky: true,
    });
    expect(j("computer", { action: "key", text: "Enter" }).verdict).toBe("ask");
    expect(j("javascript_tool", { text: "1" })).toMatchObject({ verdict: "ask", risky: true });
    expect(j("computer", { action: "type", text: "hello" }).verdict).toBe("allow");
    expect(j("computer", { action: "type", text: "hello" }, { tainted: true }).verdict).toBe("ask");
    expect(
      j("computer", { action: "type", text: "hello" }, { tainted: true, textIsHis: true }).verdict,
    ).toBe("allow");
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
      expect(j("computer", { action: "left_click", text: t }).verdict).toBe("deny");
    }
    expect(moneyMovement("Read the pricing page")).toBe(false);
  });
  it("refuses social networks while social is off, wherever it is reached from", () => {
    expect(isSocialHost("m.instagram.com")).toBe(true);
    expect(isSocialHost("notfacebook.com")).toBe(false);
    expect(j("navigate", { url: "https://www.facebook.com" }).verdict).toBe("deny");
    expect(
      j("computer", { action: "left_click", text: "Like" }, { pageHost: "x.com" }).verdict,
    ).toBe("deny");
    expect(j("get_page_text", {}, { pageHost: "x.com" }).verdict).toBe("deny");
  });
  it("with social on, reads and scrolls are routine; every post-like action asks and shows, and is rate-limited", () => {
    const on = { socialOn: true, pageHost: "x.com" };
    expect(j("navigate", { url: "https://x.com/home" }, on).verdict).toBe("allow");
    expect(j("get_page_text", {}, on).verdict).toBe("allow");
    expect(j("computer", { action: "scroll" }, on).verdict).toBe("allow");
    expect(j("computer", { action: "left_click", text: "Post" }, on)).toMatchObject({
      verdict: "ask",
      risky: true,
    });
    expect(j("form_input", { value: "hi" }, on)).toMatchObject({ verdict: "ask", risky: true });
    expect(
      j(
        "computer",
        { action: "left_click", text: "Post" },
        { ...on, recentSocial: SOCIAL_PER_HOUR },
      ).verdict,
    ).toBe("deny");
    expect(hostOf("javascript:alert(1)")).toBeNull();
    expect(j("navigate", { url: "javascript:alert(1)" }, on).verdict).toBe("deny");
  });
});

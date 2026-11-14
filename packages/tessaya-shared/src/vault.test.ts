import { describe, expect, it } from "vite-plus/test";

import { grantKey, scrubText, useDecision, type VaultItem } from "./vault.ts";

const item = (over: Partial<VaultItem> = {}): VaultItem => ({
  id: "i",
  name: "github",
  label: "",
  category: "key",
  value: "fake-test-value-1234",
  policy: { mode: "ask" },
  createdAt: "",
  updatedAt: "",
  ...over,
});

describe("useDecision", () => {
  const base = {
    target: "github.com",
    grants: new Map<string, number>(),
    now: 1000,
    tainted: false,
  };
  it("asks by default and refuses financial and never-items", () => {
    expect(useDecision({ ...base, item: item() }).kind).toBe("ask");
    expect(useDecision({ ...base, item: item({ policy: { mode: "self" } }) }).kind).toBe("refuse");
    expect(useDecision({ ...base, item: item({ policy: { mode: "never" } }) }).kind).toBe("refuse");
  });
  it("a domain approval lasts its minutes, for that target only, and never when tainted", () => {
    const domain = item({ policy: { mode: "domain", minutes: 10 } });
    const grants = new Map([[grantKey("github", "GitHub.com"), 5000]]);
    expect(useDecision({ ...base, item: domain, grants }).kind).toBe("allow");
    expect(useDecision({ ...base, item: domain, grants, now: 6000 }).kind).toBe("ask");
    expect(useDecision({ ...base, item: domain, grants, target: "evil.test" }).kind).toBe("ask");
    expect(useDecision({ ...base, item: domain, grants, tainted: true }).kind).toBe("ask");
  });
});

describe("scrubText", () => {
  it("removes the value and its common encodings", () => {
    const value = "fake-test-value-1234";
    const text = [
      value,
      encodeURIComponent("a b" + value),
      btoa(value),
      JSON.stringify({ k: value }),
    ].join(" | ");
    const out = scrubText(text, [{ name: "github", value }]);
    expect(out).not.toContain(value);
    expect(out).not.toContain(btoa(value));
    expect(out).toContain("[vault:github]");
  });
  it("leaves other text alone", () => {
    expect(scrubText("nothing here", [{ name: "x", value: "fake-test-value-1234" }])).toBe(
      "nothing here",
    );
  });
});

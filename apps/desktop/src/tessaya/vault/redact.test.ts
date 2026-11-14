import { describe, expect, it } from "vite-plus/test";

import { REDACTED } from "@t3tools/tessaya-shared/memory";

import { redactForHistory } from "./redact.ts";

describe("redactForHistory", () => {
  it("marks a dictated password in both the heard and the cleaned text", () => {
    const out = redactForHistory("my password is hunter-fake-77", "My password is hunter-fake-77.");
    expect(out).toMatchObject({ raw: REDACTED, cleaned: REDACTED });
    expect(out.secret).toContain("password");
  });
  it("leaves ordinary dictation alone", () => {
    expect(redactForHistory("see you at five", "See you at five.")).toEqual({
      raw: "see you at five",
      cleaned: "See you at five.",
      secret: null,
    });
  });
});

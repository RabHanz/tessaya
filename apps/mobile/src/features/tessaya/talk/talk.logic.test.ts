import { describe, expect, it } from "vite-plus/test";

import { askOutcome, askRefused, bodyCacheName, talkPersona } from "./talk.logic";

const persona = (id: string, extra: object = {}) => ({
  id,
  name: id,
  wake: null,
  voice: "eve",
  role: "",
  lead: false,
  ...extra,
});

describe("the Talk tab", () => {
  it("answers as his pick while it is on the team, never a private persona, else the lead", () => {
    const team = [
      persona("tessaya", { lead: true }),
      persona("freya"),
      persona("luna", { private: true }),
    ];
    expect(talkPersona(team, "freya")?.id).toBe("freya");
    expect(talkPersona(team, "luna")?.id).toBe("tessaya");
    expect(talkPersona(team, "gone")?.id).toBe("tessaya");
    expect(talkPersona([], null)).toBeNull();
  });

  it("keeps polling until her answer, a failure or an expiry, and says when the ask was lost", () => {
    expect(askOutcome({ status: "queued", line: "On it." })).toEqual({
      done: false,
      line: "On it.",
    });
    expect(askOutcome({ status: "answered", line: "It's sunny." })).toEqual({
      done: true,
      line: "It's sunny.",
    });
    expect(askOutcome(null).done).toBe(true);
  });

  it("says why an ask was turned away at once, instead of waiting for it and calling it lost", () => {
    expect(askRefused({ ok: false, line: "Your computer isn't connected." })).toBe(
      "Your computer isn't connected.",
    );
    expect(askRefused({ ok: false })).toBe("");
    expect(askRefused({ ok: true, status: "queued" })).toBeNull();
    expect(askRefused(null)).toBeNull();
  });

  it("keeps one cached file per model address, and a new address is fetched anew", () => {
    expect(bodyCacheName("https://home.example:3773/tessaya/playground/everyday.vrm")).toBe(
      "tessaya-body-_tessaya_playground_everyday.vrm.vrm",
    );
    expect(bodyCacheName("/tessaya/playground/model/abc123")).not.toBe(
      bodyCacheName("/tessaya/playground/model/def456"),
    );
  });
});

import { describe, expect, it } from "vite-plus/test";

import { askOutcome, talkPersona, toBase64 } from "./talk.logic";

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

  it("encodes a model larger than one chunk without losing bytes", () => {
    const bytes = new Uint8Array(0x8000 * 2 + 5).map((_, i) => i % 251);
    expect(Uint8Array.from(atob(toBase64(bytes)), (c) => c.charCodeAt(0))).toEqual(bytes);
  });
});

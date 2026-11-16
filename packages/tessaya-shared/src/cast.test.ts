import { describe, expect, it } from "vite-plus/test";

import { mayRecast, onBody, VISIT_MS, wearing } from "./cast.ts";

const roster = [
  { id: "tessaya", name: "Tessaya" },
  { id: "freya", name: "Freya" },
  { id: "alfred", name: "Alfred" },
];

describe("wearing", () => {
  it("is a live visit, then the followed persona, then home, then the lead", () => {
    const now = 1_000_000;
    const cast = { home: "Freya", follows: true };
    const visit = { persona: "alfred", at: now - 1000, stay: false };
    expect(wearing(cast, { roster, visit, followed: "tessaya", now })).toEqual({
      persona: "alfred",
      why: "visit",
    });
    expect(wearing(cast, { roster, followed: "tessaya", now })).toEqual({
      persona: "tessaya",
      why: "follows",
    });
    expect(wearing({ home: "Freya" }, { roster, followed: "alfred", now })).toEqual({
      persona: "freya",
      why: "home",
    });
    expect(wearing(undefined, { roster, now })).toEqual({ persona: "tessaya", why: "lead" });
  });

  it("returns home once the conversation lapses, unless he said stay", () => {
    const at = 0;
    const cast = { home: "freya" };
    const gone = VISIT_MS + 1;
    expect(
      wearing(cast, { roster, visit: { persona: "alfred", at, stay: false }, now: gone }),
    ).toEqual({ persona: "freya", why: "home" });
    expect(
      wearing(cast, { roster, visit: { persona: "alfred", at, stay: true }, now: gone }),
    ).toEqual({ persona: "alfred", why: "stay" });
  });

  it("treats a retired persona (gone from the roster) as unset", () => {
    expect(wearing({ home: "onyx" }, { roster, now: 0 })).toEqual({
      persona: "tessaya",
      why: "lead",
    });
  });
});

describe("onBody", () => {
  it("puts several on the desktop, the worn one first, each once, up to the body's limit", () => {
    const cast = { home: "freya", crew: ["Alfred", "freya", "onyx", "tessaya"] };
    const worn = wearing(cast, { roster, now: 0 });
    expect(onBody(cast, worn, roster, 4)).toEqual(["freya", "alfred", "tessaya"]);
    expect(onBody(cast, worn, roster, 2)).toEqual(["freya", "alfred"]);
  });
});

describe("mayRecast", () => {
  it("lets only his verified ask move a body, never a wake word or the persona a turn used", () => {
    expect(mayRecast("ask", true)).toBe(true);
    expect(mayRecast("ask", false)).toBe(false);
    expect(mayRecast("wake", true)).toBe(false);
    expect(mayRecast("turn", true)).toBe(false);
  });
});

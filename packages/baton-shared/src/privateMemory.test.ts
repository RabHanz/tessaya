import { describe, expect, it } from "vite-plus/test";

import {
  afterWrongPin,
  looksPrivate,
  NO_LOCKOUT,
  pinGate,
  pinProblem,
  privatePersonOf,
  type PrivateTurn,
  type SpeakerLike,
} from "./privateMemory.ts";

describe("pinProblem", () => {
  it.each([
    ["owner", "27182818", null],
    ["owner", "a long pass phrase here", null],
    [
      "owner",
      "2718281",
      "Your PIN needs at least 8 digits, or a passphrase of 12 characters or more.",
    ],
    ["owner", "11111111", "A PIN of one digit repeated is too easy to guess."],
    ["owner", "12345678", "A run of digits is too easy to guess."],
    ["owner", "19840214", "A date is too easy to guess."],
    ["owner", "14021984", "A date is too easy to guess."],
    ["owner", "aaaaaaaaaaaaaa", "That passphrase repeats too much."],
    ["person", "271828", null],
    ["person", "27182", "A PIN is 6 digits."],
    ["person", "654321", "A run of digits is too easy to guess."],
  ] as const)("%s %s", (kind, pin, want) => expect(pinProblem(pin, kind)).toBe(want));
});

describe("the wrong-PIN wait", () => {
  const run = (kind: "owner" | "person", n: number) => {
    let s = NO_LOCKOUT;
    for (let i = 0; i < n; i++) s = afterWrongPin(kind, s, 0);
    return s;
  };
  it("waits after five, doubling every three more", () => {
    expect(run("owner", 4).waitUntil).toBe(0);
    expect(run("owner", 5).waitUntil).toBe(15 * 60_000);
    expect(run("owner", 8).waitUntil).toBe(30 * 60_000);
    expect(run("person", 5).waitUntil).toBe(5 * 60_000);
    expect(pinGate("owner", run("owner", 5), 1000).kind).toBe("wait");
    expect(pinGate("owner", run("owner", 5), 15 * 60_000).kind).toBe("try");
  });
  it("lets only the recovery code open his store after twenty", () => {
    expect(pinGate("owner", run("owner", 20), Number.MAX_SAFE_INTEGER)).toEqual({
      kind: "recovery-only",
    });
    expect(pinGate("person", run("person", 20), Number.MAX_SAFE_INTEGER).kind).toBe("try");
  });
});

describe("privatePersonOf", () => {
  const him: SpeakerLike = { kind: "owner", personId: "owner", verified: true, inherited: false };
  const sara: SpeakerLike = { kind: "saved", personId: "sara", verified: true, inherited: false };
  const turn = (over: Partial<PrivateTurn>): PrivateTurn => ({
    route: "assistant",
    typed: false,
    tainted: false,
    speaker: null,
    ...over,
  });
  it.each<[string, Partial<PrivateTurn>, string | null]>([
    ["his verified voice", { speaker: him }, "owner"],
    ["typed at his desktop", { typed: true }, "owner"],
    ["an inherited verdict", { speaker: { ...him, inherited: true } }, null],
    ["a steer-level match only", { speaker: { ...him, verified: false } }, null],
    [
      "unverified",
      { speaker: { kind: "unverified", personId: null, verified: false, inherited: false } },
      null,
    ],
    [
      "a guest",
      { speaker: { kind: "guest", personId: null, verified: false, inherited: false } },
      null,
    ],
    ["a tainted turn, even typed", { typed: true, tainted: true }, null],
    ["a saved person on his path", { speaker: sara }, null],
    ["a saved person on the outside path", { route: "outside", speaker: sara }, "sara"],
    ["him on the outside path", { route: "outside", speaker: him }, null],
    ["a standing job", { route: "standing", typed: true }, null],
    ["the phone relay", { route: "phone", speaker: him }, null],
    ["an outside agent", { route: "agent", typed: true }, null],
  ])("%s", (_name, over, want) => {
    const got = privatePersonOf(turn(over));
    expect("personId" in got ? got.personId : null).toBe(want);
  });
});

describe("looksPrivate", () => {
  it("flags faith, family, health and identity, not the air fryer", () => {
    expect(looksPrivate("Prays Isha at home")).toBe(true);
    expect(looksPrivate("Her birthday is in March")).toBe(true);
    expect(looksPrivate("Saw the doctor on Monday")).toBe(true);
    expect(looksPrivate("The air fryer starts with the start button")).toBe(false);
  });
});

import { describe, expect, it } from "vite-plus/test";

import { entityFacts, mentions, OWNER_END, relationFacts } from "./memoryEntities.ts";

describe("who or what a statement names", () => {
  it("reads 'X is my Y', 'my Y is X', 'X is the Y' and 'X is the name of Y'", () => {
    expect(entityFacts("Maya is my younger sister")).toEqual([
      {
        name: "Maya",
        aliases: ["my younger sister", "my sister", "younger sister", "sister"],
      },
    ]);
    expect(entityFacts("My dentist is Dr Qadri, above the bakery")[0]).toEqual({
      name: "Dr Qadri",
      aliases: ["my dentist", "dentist"],
    });
    expect(entityFacts("Omar Haddad is the builder doing the kitchen")[0]).toMatchObject({
      name: "Omar Haddad",
    });
    expect(entityFacts("Omar Haddad is the builder doing the kitchen")[0]!.aliases).toEqual(
      expect.arrayContaining(["the builder", "builder", "omar"]),
    );
    expect(entityFacts("Lumen is the name of the reading app venture")[0]!.aliases).toEqual(
      expect.arrayContaining(["reading app venture", "reading app"]),
    );
  });

  it("leaves sentences that name no one alone", () => {
    for (const text of [
      "The bins go out on Tuesday",
      "It is my turn to cook",
      "We accepted the builder's quote",
      "I go to the gym on Tuesdays",
    ])
      expect(entityFacts(text)).toEqual([]);
  });

  it("finds a mention by name or alias, as whole words and through a possessive", () => {
    const maya = entityFacts("Maya is my younger sister")[0]!;
    expect(mentions("My sister's birthday is the ninth of April", maya)).toBe(true);
    expect(mentions("what can't Maya eat", maya)).toBe(true);
    expect(mentions("my sisterhood group meets Fridays", maya)).toBe(false);
    expect(mentions("the bins go out on Tuesday", maya)).toBe(false);
  });
});

describe("the edges a statement draws (people graph)", () => {
  it("reads people to people, to him, and to events", () => {
    expect(relationFacts("Ali is Sara's younger sister.")).toEqual([
      { from: "Ali", relation: "sister", to: "Sara", toKind: "person" },
    ]);
    expect(relationFacts("Ali is my cousin from Lahore")).toEqual([
      { from: "Ali", relation: "cousin", to: OWNER_END, toKind: "owner" },
    ]);
    expect(relationFacts("My dentist is Dr Qadri")).toEqual([
      { from: "Dr Qadri", relation: "dentist", to: OWNER_END, toKind: "owner" },
    ]);
    expect(relationFacts("Omar works with me at Meliura")[0]?.relation).toBe("works with");
    expect(relationFacts("Sara was at the birthday party on Saturday")).toEqual([
      { from: "Sara", relation: "was at", to: "the birthday party", toKind: "event" },
    ]);
    expect(relationFacts("Sara came to our party")[0]?.to).toBe("the party");
  });

  it("draws nothing from sentences without two ends", () => {
    for (const text of [
      "The bins go out on Tuesday",
      "It is my turn",
      "Ali was at home",
      "He is my cousin",
    ])
      expect(relationFacts(text)).toEqual([]);
  });
});

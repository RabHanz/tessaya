/**
 * People, projects and places in what he says (Memory v2 step 7, MEMORY-COGNITION P7): who or what a statement names,
 * and the other ways he refers to them ("Maya is my younger sister": Maya, "my sister"), so "what can't Maya eat"
 * reaches "my sister is allergic to peanuts" though it never names her. Plain rules, no model at query time.
 * @module tessaya-shared/memoryEntities
 */

export interface EntityFact {
  /** As he names it: "Maya", "Omar Haddad", "Dr Qadri". */
  readonly name: string;
  /** The other ways he refers to it, lower case: "my younger sister", "sister", "the builder". */
  readonly aliases: ReadonlyArray<string>;
}

/** Words that end the noun phrase of a relation ("the builder doing the kitchen" is "builder"). */
const PHRASE_END =
  /\b(?:who|that|which|doing|for|at|of|in|on|from|with|and|but|since|because|when|where|to|is|was|will|has|had)\b|[,.;:!?]/i;
/** A name: one to three capitalised words, optionally after a title ("Dr Qadri"). */
const NAME = "((?:(?:Dr|Mr|Mrs|Ms|Miss|Prof)\\.? )?[A-Z][a-zA-Z'-]+(?: [A-Z][a-zA-Z'-]+){0,2})";
const NOT_NAMES = new Set([
  "The",
  "My",
  "Our",
  "It",
  "This",
  "That",
  "He",
  "She",
  "They",
  "We",
  "I",
  "There",
]);

/** "younger sister" → ["younger sister", "sister"]; "reading app venture" → ["reading app venture", "reading app"]. */
const phraseAliases = (phrase: string, headAlone: boolean): ReadonlyArray<string> => {
  const words = phrase.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const out = new Set<string>([words.join(" ")]);
  for (let n = words.length - 1; n >= 2; n--) out.add(words.slice(0, n).join(" "));
  if (headAlone) out.add(words.at(-1)!);
  return [...out];
};

const relation = (rest: string): string => rest.split(PHRASE_END)[0]!.trim();

/** Who or what each sentence names, with how else he refers to them ("Maya is my younger sister": Maya, "my sister"). */
export const entityFacts = (text: string): ReadonlyArray<EntityFact> => {
  const facts: Array<EntityFact> = [];
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    const s = sentence.trim();
    let m = new RegExp(`^${NAME} is (?:the name of|called|named) (?:the |our |my )?(.+)$`).exec(s);
    if (m !== null && !NOT_NAMES.has(m[1]!)) {
      const phrase = relation(m[2]!);
      facts.push({
        name: m[1]!,
        aliases: [...phraseAliases(phrase, false), `the ${phrase.toLowerCase()}`],
      });
      continue;
    }
    m = new RegExp(`^${NAME} is (my|our|the) (.+)$`).exec(s);
    if (m !== null && !NOT_NAMES.has(m[1]!)) {
      const phrase = relation(m[3]!);
      if (phrase !== "") facts.push({ name: m[1]!, aliases: withOwner(m[2]!, phrase, m[1]!) });
      continue;
    }
    m = new RegExp(`^(My|Our|The) ([a-z][a-z ]*?) is ${NAME}\\b`).exec(s);
    if (m !== null)
      facts.push({ name: m[3]!, aliases: withOwner(m[1]!.toLowerCase(), m[2]!, m[3]!) });
  }
  return facts;
};

/** "my" + "younger sister" → "my younger sister", "my sister", "younger sister", "sister"; a full name's first name too. */
const withOwner = (owner: string, phrase: string, name: string): ReadonlyArray<string> => {
  const bare = phraseAliases(phrase, true);
  const head = bare.at(-1)!;
  const first = name.replace(/^(?:Dr|Mr|Mrs|Ms|Miss|Prof)\.? /, "").split(" ");
  return [
    ...new Set([
      ...bare.map((p) => `${owner} ${p}`),
      `${owner} ${head}`,
      ...bare,
      ...(first.length > 1 ? [first[0]!.toLowerCase()] : []),
    ]),
  ];
};

/** Whether the text names the entity, by name or any alias, as whole words ("my sister's" names "my sister"). */
export const mentions = (text: string, entity: EntityFact): boolean => {
  const said = ` ${text
    .toLowerCase()
    .replace(/[’']s\b/g, "")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")} `;
  return [entity.name.toLowerCase(), ...entity.aliases].some((a) =>
    said.includes(
      ` ${a
        .replace(/[^a-z0-9 ]+/g, " ")
        .replace(/\s+/g, " ")
        .trim()} `,
    ),
  );
};

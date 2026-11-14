/**
 * The vault's pure rules (D151, docs/baton/VAULT.md): what an item is, whether the assistant may use
 * it, and scrubbing a value out of text. No I/O and no crypto here; the desktop owns those.
 */

export const VAULT_CATEGORIES = ["login", "key", "note", "id", "file", "financial"] as const;
export type VaultCategory = (typeof VAULT_CATEGORIES)[number];

export type VaultPolicy =
  | { readonly mode: "ask" }
  /** After one approval, the same target is allowed for `minutes`. */
  | { readonly mode: "domain"; readonly minutes: number }
  /** The assistant cannot use it; he can view and copy it. */
  | { readonly mode: "never" }
  /** Financial: he types it himself. Not chosen, not changeable. */
  | { readonly mode: "self" };

export interface VaultItem {
  readonly id: string;
  /** Lower-case handle the assistant and he refer to it by. */
  readonly name: string;
  readonly label: string;
  readonly category: VaultCategory;
  readonly value: string;
  readonly policy: VaultPolicy;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** What the assistant and the list view may see: never the value. */
export type VaultListing = Omit<VaultItem, "value">;

export const VAULT_VALUE_MAX = 256 * 1024;
export const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/** Financial items are always `self`, whatever was asked. */
export const policyFor = (category: VaultCategory, asked: VaultPolicy): VaultPolicy =>
  category === "financial" ? { mode: "self" } : asked;

export const listing = (item: VaultItem): VaultListing => {
  const { value: _value, ...rest } = item;
  return rest;
};

export type UseDecision =
  | { readonly kind: "refuse"; readonly why: string }
  | { readonly kind: "ask" }
  | { readonly kind: "allow" };

/** `grants` maps `name|target` to the time (ms) its approval lapses. */
export const useDecision = (input: {
  readonly item: VaultItem;
  readonly target: string;
  readonly grants: ReadonlyMap<string, number>;
  readonly now: number;
  /** The request came from something the turn read (a page, a file, a message). */
  readonly tainted: boolean;
}): UseDecision => {
  const { item } = input;
  if (item.policy.mode === "self") {
    return {
      kind: "refuse",
      why: `${item.name} is financial, so you type it yourself; I never fill it in.`,
    };
  }
  if (item.policy.mode === "never") {
    return { kind: "refuse", why: `${item.name} is set so that only you can use it.` };
  }
  if (input.tainted) return { kind: "ask" };
  if (item.policy.mode === "domain") {
    const until = input.grants.get(grantKey(item.name, input.target));
    if (until !== undefined && until > input.now) return { kind: "allow" };
  }
  return { kind: "ask" };
};

export const grantKey = (name: string, target: string): string =>
  `${name}|${target.trim().toLowerCase()}`;

/** The encodings a value turns up in when a program echoes it. */
const variants = (value: string): ReadonlyArray<string> => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  const b64 = btoa(binary);
  return [
    ...new Set([
      value,
      encodeURIComponent(value),
      JSON.stringify(value).slice(1, -1),
      b64,
      b64.replace(/=+$/, ""),
    ]),
  ].filter((v) => v.length >= 4);
};

/** Replaces every vault value (and its common encodings) in `text` with `[vault:name]`. */
export const scrubText = (
  text: string,
  secrets: ReadonlyArray<{ readonly name: string; readonly value: string }>,
): string => {
  let out = text;
  // Longest first, so a value that contains another is not left half-visible.
  const all = secrets
    .flatMap((s) => variants(s.value).map((v) => [v, s.name] as const))
    .toSorted((a, b) => b[0].length - a[0].length);
  for (const [v, name] of all) out = out.split(v).join(`[vault:${name}]`);
  return out;
};

export interface VaultAuditEntry {
  readonly at: string;
  readonly name: string;
  readonly purpose: string;
  readonly target: string;
  readonly how: string;
  readonly outcome: "used" | "refused" | "declined" | "failed" | "revealed" | "copied" | "saved";
}

export const auditLine = (entry: VaultAuditEntry): string => JSON.stringify(entry);

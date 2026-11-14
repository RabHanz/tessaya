// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
/** Fetches a skill's text and files it for Claude Code, after the review. Nothing fetched is ever run. */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { SKILL_MAX_BYTES } from "@t3tools/tessaya-shared/skillReview";

export type Fetch = (
  url: string,
  init: { signal: AbortSignal; redirect: "error" | "follow" },
) => Promise<{
  ok: boolean;
  status: number;
  headers: { get: (name: string) => string | null };
  text: () => Promise<string>;
}>;

/** The text at an https address: small, text, and within 15 seconds. */
export const fetchSkillText = async (
  url: string,
  doFetch: Fetch = fetch as unknown as Fetch,
): Promise<string> => {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15_000);
  try {
    const res = await doFetch(url, { signal: abort.signal, redirect: "follow" });
    if (!res.ok) throw new Error(`The address answered ${res.status}.`);
    const length = Number(res.headers.get("content-length") ?? 0);
    if (length > SKILL_MAX_BYTES) throw new Error("That file is too large to be a skill.");
    const type = res.headers.get("content-type") ?? "";
    if (type !== "" && !/^text\/|markdown|plain/i.test(type))
      throw new Error("That address is not a text file.");
    const text = await res.text();
    if (Buffer.byteLength(text) > SKILL_MAX_BYTES)
      throw new Error("That file is too large to be a skill.");
    return text;
  } finally {
    clearTimeout(timer);
  }
};

export const skillFile = (claudeDir: string, name: string): string =>
  NodePath.join(claudeDir, "skills", name, "SKILL.md");

export const skillExists = (claudeDir: string, name: string): boolean =>
  NodeFS.existsSync(skillFile(claudeDir, name));

/** A name from the address when the file does not give one: the folder of a SKILL.md, else the file's name. */
export const nameFromUrl = (url: string): string => {
  const parts = new URL(url).pathname.split("/").filter((p) => p !== "");
  const last = parts.at(-1) ?? "skill";
  return /^skill\.md$/i.test(last) && parts.length > 1
    ? parts.at(-2)!
    : last.replace(/\.[a-z0-9]+$/i, "");
};

export const installSkill = (claudeDir: string, name: string, text: string): string => {
  const file = skillFile(claudeDir, name);
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`);
  return file;
};

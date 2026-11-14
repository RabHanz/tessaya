/**
 * Adding a skill from a web address (the Skills tab). A skill is a markdown file the assistant reads
 * and follows, so installing one is giving a stranger's text some say. Everything here is the review
 * before he decides: where it comes from, what it claims to be, and what in it looks dangerous.
 * Pure; fetching and writing are the desktop's.
 */
export const SKILL_MAX_BYTES = 128 * 1024;

/** An https address, with a GitHub page turned into the raw file. Null when it is not one we will fetch. */
export const normalizeSkillUrl = (
  input: string,
): { readonly url: string; readonly host: string } | null => {
  let u: URL;
  try {
    u = new URL(input.trim());
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username !== "" || u.password !== "") return null;
  if (u.hostname === "github.com") {
    const m = /^\/([^/]+)\/([^/]+)\/blob\/(.+)$/.exec(u.pathname);
    if (m === null) return null;
    return {
      url: `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${m[3]}`,
      host: "raw.githubusercontent.com",
    };
  }
  return { url: u.toString(), host: u.hostname };
};

export interface ParsedSkill {
  readonly name: string;
  readonly description: string;
  readonly body: string;
  readonly allowedTools: string | null;
}

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const slugOf = (s: string): string =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);

/** Front matter (`---` block) and body. A file without a usable name is refused: it cannot be filed. */
export const parseSkill = (
  text: string,
  fallbackName: string,
):
  | { readonly ok: true; readonly skill: ParsedSkill }
  | { readonly ok: false; readonly why: string } => {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text.replace(/^\uFEFF/, ""));
  const front = m?.[1] ?? "";
  const body = (m?.[2] ?? text).trim();
  const field = (k: string): string | null => {
    const line = new RegExp(`^${k}:\\s*(.+)$`, "mi").exec(front);
    return line === null ? null : line[1]!.trim().replace(/^["']|["']$/g, "");
  };
  const name = slugOf(field("name") ?? fallbackName);
  if (!SLUG.test(name)) return { ok: false, why: "It has no usable name." };
  if (body === "") return { ok: false, why: "The skill has no content." };
  return {
    ok: true,
    skill: {
      name,
      description: field("description") ?? "",
      body,
      allowedTools: field("allowed-tools"),
    },
  };
};

export interface Finding {
  readonly level: "high" | "note";
  readonly what: string;
}

const CHECKS: ReadonlyArray<readonly [RegExp, Finding]> = [
  [
    /(curl|wget|iwr|Invoke-WebRequest)[^\n|]*\|\s*(sh|bash|zsh|iex|powershell)/i,
    { level: "high", what: "downloads and runs a script in one step" },
  ],
  [
    /\b(iex|Invoke-Expression)\b|powershell[^\n]*-enc(odedcommand)?\b/i,
    { level: "high", what: "runs encoded or dynamic PowerShell" },
  ],
  [
    /base64\s+(-d|--decode)[^\n]*\|\s*(sh|bash)/i,
    { level: "high", what: "decodes a hidden command and runs it" },
  ],
  [
    /\brm\s+-rf?\s+[/~]|\bdel\s+\/[sq]|Remove-Item[^\n]*-Recurse[^\n]*-Force|\bformat\s+[a-z]:/i,
    { level: "high", what: "deletes files broadly" },
  ],
  [
    /\.ssh\b|id_rsa|\.aws\/credentials|\.npmrc|\.netrc|\.env\b|keychain|credential manager|wallet\.dat/i,
    { level: "high", what: "reaches for keys, tokens or credentials" },
  ],
  [
    /\b(scp|rsync|nc|ncat|netcat)\b[^\n]*[@:]|curl[^\n]*(-d|--data|-F|--upload-file)|Invoke-RestMethod[^\n]*-Method\s+Post/i,
    { level: "high", what: "sends data to another machine" },
  ],
  [
    /ignore (all |any )?(previous|prior|above) (instructions|rules)|disregard (the )?(system|previous)/i,
    { level: "high", what: "tells the assistant to ignore its rules" },
  ],
  [
    /(without|never)\s+(ask|asking|confirm|confirming|prompt|prompting)|do not (ask|confirm)|bypass|disable (the )?(safety|guard|confirmation)/i,
    { level: "high", what: "tells the assistant not to ask first" },
  ],
  [
    /[\u200b-\u200f\u202a-\u202e\u2060\ufeff]/,
    { level: "high", what: "contains invisible characters" },
  ],
  [
    /<!--[\s\S]*?-->/,
    { level: "note", what: "has hidden comments you cannot see when it is rendered" },
  ],
  [
    /\bsudo\b|\brunas\b|Start-Process[^\n]*-Verb\s+RunAs/i,
    { level: "note", what: "asks for administrator rights" },
  ],
  [
    /\b(npm|pnpm|yarn|pip|pip3|cargo|go)\s+(install|add|get)\b/i,
    { level: "note", what: "installs packages" },
  ],
  [
    /\bgit\s+push\b|\bgh\s+(pr|release)\s+(create|merge)|\bsendmail\b|\bsend (an )?email\b/i,
    { level: "note", what: "pushes or sends things" },
  ],
];

export const reviewSkill = (skill: ParsedSkill, rawText: string): ReadonlyArray<Finding> => {
  const found = CHECKS.filter(([re]) => re.test(rawText)).map(([, f]) => f);
  if (skill.allowedTools !== null && /\b(Bash|Shell|Write|Edit|\*)\b/i.test(skill.allowedTools)) {
    found.push({
      level: "note",
      what: `asks to use these tools without a prompt: ${skill.allowedTools.slice(0, 80)}`,
    });
  }
  return found;
};

/** What the card shows: the source, the claim, the findings, and the start of the text. */
export const reviewCard = (input: {
  readonly host: string;
  readonly skill: ParsedSkill;
  readonly findings: ReadonlyArray<Finding>;
  readonly exists: boolean;
}): { readonly title: string; readonly detail: string } => {
  const high = input.findings.filter((f) => f.level === "high");
  const lines = [
    `From ${input.host}. It calls itself "${input.skill.name}"${input.skill.description === "" ? "" : `: ${input.skill.description.slice(0, 160)}`}.`,
    high.length > 0
      ? `Careful: it ${high.map((f) => f.what).join("; ")}.`
      : "Nothing in it looks dangerous to a quick scan, which is not a guarantee.",
    ...(input.findings.some((f) => f.level === "note")
      ? [
          `Also: it ${input.findings
            .filter((f) => f.level === "note")
            .map((f) => f.what)
            .join("; ")}.`,
        ]
      : []),
    input.exists ? "A skill with this name is already installed; this would replace it." : "",
    `It starts: ${input.skill.body.replace(/\s+/g, " ").slice(0, 400)}`,
  ].filter((l) => l !== "");
  return {
    title: high.length > 0 ? "Add this skill? It looks risky" : "Add this skill?",
    detail: lines.join("\n"),
  };
};

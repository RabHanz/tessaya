/**
 * Terminal prompts (D88): a permission dialog, an AskUserQuestion or a mod's ui.ask, read from a Herdr pane's screen
 * so T3 can show it with its options and answer it with keystrokes. Pure, Node built-ins only: the live agent
 * (`baton-live-acp.mjs`, installed beside this file) and the server's mirror both parse with it.
 */
/** The last lines on a pane's screen, for a question Tessaya could not read as options. */
export const screenTail = (screen, lines = 12) =>
  screen
    .split("\n")
    .map((l) => l.replace(/\s+$/g, ""))
    .filter((l) => l.trim() !== "")
    .slice(-lines)
    .join("\n")
    .slice(0, 1200);

const FOOTER = /Esc to cancel|Enter to (confirm|select)|↑\/↓ to navigate/;
const RULE = /^\s*[─━╌]{8,}\s*$/;
const SOLID = /^\s*[─━]{8,}\s*$/;
const NUMBERED = /^(\s*)(❯\s*)?(\d+)\.\s+(.+?)\s*$/;
const CUSTOM = /^(?:type something|other)\.?$/i;
const DROPPED = /^chat about this$/i;
// A raw capture keeps its colour codes.
const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g;
const clean = (text) =>
  text
    .replace(/^[\s│┃|]+/, "")
    .replace(/\s+/g, " ")
    .trim();

/** The tab bar of a multi-question form: each question's name and whether it is answered (☒). */
const tabsOf = (line) =>
  [...line.matchAll(/([☐☒✔])\s+(.+?)(?=\s+[☐☒✔]|\s*→|\s*$)/g)]
    .map((m) => ({ label: m[2].trim(), answered: m[1] !== "☐", submit: m[1] === "✔" }))
    .filter((tab) => tab.label.length > 0);

/**
 * The last screen of a multi-question form: "Review your answers", each question with its answer, then
 * "Ready to submit your answers?" over Submit and Cancel. It has no Esc footer, which is why it was not
 * read: a session sat waiting on it with nothing to show. Going back one question is the left arrow.
 */
export function parseReviewScreen(lines) {
  let ask = -1;
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 40; i -= 1)
    if (/^\s*Ready to submit your answers\?\s*$/.test(lines[i])) {
      ask = i;
      break;
    }
  if (ask < 0) return null;
  const options = [];
  for (let i = ask + 1; i < lines.length && i <= ask + 8; i += 1) {
    const m = NUMBERED.exec(lines[i]);
    if (m === null) {
      if (options.length > 0 && lines[i].trim() === "") break;
      continue;
    }
    options.push({ number: Number(m[3]), label: m[4], selected: m[2] !== undefined });
  }
  if (options.length < 2 || options.filter((o) => o.selected).length !== 1) return null;
  let top = ask - 1;
  while (top >= 0 && ask - top < 40 && !/Review your answers/.test(lines[top])) top -= 1;
  const answers = [];
  for (let i = Math.max(0, top); i < ask; i += 1) {
    const q = /^[\s│┃]*●\s*(.*)$/.exec(lines[i]);
    if (q !== null) answers.push({ question: clean(q[1]), answer: "" });
    else if (answers.length > 0) {
      const a = /^\s*→\s*(.*)$/.exec(lines[i]);
      if (a !== null && answers.at(-1).answer === "") answers.at(-1).answer = clean(a[1]);
      else if (/^[\s│┃]/.test(lines[i]) && lines[i].trim() !== "" && answers.at(-1).answer === "")
        answers.at(-1).question = `${answers.at(-1).question} ${clean(lines[i])}`.trim();
    }
  }
  const tabLine = lines.slice(Math.max(0, top - 2), top + 1).find((l) => /^\s*←/.test(l));
  const question = "Ready to submit your answers?";
  const context = answers
    .map((a) => `${a.question} → ${a.answer}`)
    .join(" · ")
    .slice(0, 600);
  return {
    question,
    header: "Review your answers",
    ...(tabLine === undefined ? {} : { tabs: tabsOf(tabLine.trim()) }),
    context,
    options: [
      ...options.map((o) => ({ index: o.number - 1, label: o.label, description: "" })),
      { index: -1, label: "Go back", description: "Back to the last question", keys: ["left"] },
    ],
    selected: options.findIndex((o) => o.selected),
    customIndex: null,
    review: true,
    key: [question, ...options.map((o) => o.label), context].join("\u0000"),
  };
}

/**
 * The prompt on a Claude Code screen, or null when none can be read. Options keep their screen
 * order (`index`), so an answer is arrows from the highlighted one plus Enter.
 */
export function parsePanePrompt(screen) {
  return parseScreen(screen) ?? unreadPermission(String(screen ?? "").replace(ANSI, ""));
}

/**
 * A permission dialog whose options could not be read still gets Allow and Deny, with the screen as its details:
 * Enter takes the option a new dialog highlights (Yes), Esc declines.
 */
function unreadPermission(screen) {
  const lines = screen.replace(/\r/g, "").split("\n").slice(-40);
  const footer = lines.findLastIndex((l) => /Esc to cancel/.test(l));
  if (footer < 0 || !lines.slice(0, footer).some((l) => /Do you want to .*\?/.test(l))) return null;
  const details = screenTail(lines.slice(0, footer).join("\n"), 20);
  return {
    question: "Claude Code is asking for permission in its terminal. Allow?",
    header: null,
    context: "",
    details,
    options: [
      { index: 0, label: "Allow", description: "", keys: ["enter"] },
      { index: 1, label: "Deny", description: "", keys: ["esc"] },
    ],
    selected: 0,
    customIndex: null,
    key: `unread\u0000${details}`,
  };
}

function parseScreen(screen) {
  const lines = String(screen ?? "")
    .replace(ANSI, "")
    .replace(/\r/g, "")
    .split("\n");
  const review = parseReviewScreen(lines);
  if (review !== null) return review;
  let footer = -1;
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 40; i -= 1)
    if (FOOTER.test(lines[i])) {
      footer = i;
      break;
    }
  if (footer < 0) {
    // No footer (the held cross-session message): a highlighted option block ending the screen.
    let end = lines.length - 1;
    while (end >= 0 && lines[end].trim() === "") end -= 1;
    const tail = lines.slice(Math.max(0, end - 8), end + 1);
    const marked = tail.findLastIndex((l) => /^\s*❯\s/.test(l));
    if (marked < 0 || tail.slice(marked).some((l) => RULE.test(l))) return null;
    footer = end + 1;
  }
  const options = [];
  let first = -1;
  // Numbered options (permission dialogs, AskUserQuestion), read upward to option 1.
  for (let i = footer - 1; i >= 0 && i >= footer - 60; i -= 1) {
    const m = NUMBERED.exec(lines[i]);
    if (m === null) continue;
    options.unshift({ number: Number(m[3]), label: m[4], selected: m[2] !== undefined, line: i });
    if (m[3] === "1") {
      first = i;
      break;
    }
  }
  const ordered = options.every((option, index) => option.number === index + 1);
  if (first < 0 || !ordered) {
    // Unnumbered options (the folder-trust dialog): the highlighted line and its neighbours.
    options.length = 0;
    const marked = lines
      .slice(Math.max(0, footer - 20), footer)
      .findLastIndex((l) => /^\s*❯\s/.test(l));
    if (marked < 0) return null;
    const at = Math.max(0, footer - 20) + marked;
    const indent = lines[at].indexOf("❯");
    const isOption = (l) =>
      l.trim().length > 0 &&
      (l.slice(indent).startsWith("❯ ") || l.slice(0, indent + 2).trim() === "");
    let top = at;
    while (
      top - 1 >= 0 &&
      isOption(lines[top - 1]) &&
      /^\s+$/.test(lines[top - 1].slice(0, indent + 2))
    )
      top -= 1;
    let bottom = at;
    while (
      bottom + 1 < footer &&
      isOption(lines[bottom + 1]) &&
      /^\s+$/.test(lines[bottom + 1].slice(0, indent + 2))
    )
      bottom += 1;
    // A label wrapped at the pane edge continues on the next line: its first word would not have fit.
    const width = Math.max(0, ...lines.filter((l) => RULE.test(l)).map((l) => l.trimEnd().length));
    const wrapped = (i) =>
      width > 0 &&
      i !== at &&
      lines[i - 1].trimEnd().length + 1 + (lines[i].trim().split(/\s+/)[0]?.length ?? 0) > width;
    for (let i = top; i <= bottom; i += 1) {
      const label = clean(lines[i].replace("❯", ""));
      if (i > top && wrapped(i)) {
        options.at(-1).label = `${options.at(-1).label} ${label}`;
        options.at(-1).selected ||= i === at;
        continue;
      }
      options.push({ number: options.length + 1, label, selected: i === at, line: i });
    }
    first = top;
  }
  if (options.length < 2 || options.filter((o) => o.selected).length !== 1) return null;
  // Lines under an option, before the next one, describe it.
  for (let k = 0; k < options.length; k += 1) {
    const end = k + 1 < options.length ? options[k + 1].line : footer;
    const text = lines
      .slice(options[k].line + 1, end)
      .filter((l) => !RULE.test(l))
      .map(clean)
      .filter((l) => l.length > 0)
      .join(" ");
    options[k].description = text;
  }
  // The question is the nearest text above the options; what it asks about runs up to a rule.
  let q = first - 1;
  while (q >= 0 && clean(lines[q]).length === 0) q -= 1;
  if (q < 0 || SOLID.test(lines[q])) return null;
  if (RULE.test(lines[q])) {
    // A dashed box above the options (artifact access): its lines up to the "?" are the question.
    let boxTop = q - 1;
    while (boxTop >= 0 && q - boxTop < 30 && !RULE.test(lines[boxTop])) boxTop -= 1;
    const box = lines
      .slice(boxTop + 1, q)
      .map(clean)
      .filter((l) => l.length > 0);
    const asks = box.findIndex((l) => l.includes("?"));
    if (boxTop < 0) return null;
    if (asks < 0) {
      // No question in the box (a held message's body): the dialog's title asks, the rest is context.
      let solid = boxTop - 1;
      while (solid >= 0 && boxTop - solid < 30 && !SOLID.test(lines[solid])) solid -= 1;
      const above = lines
        .slice(solid + 1, boxTop)
        .map(clean)
        .filter((l) => l.length > 0);
      if (above.length === 0) return null;
      const about = [...above.slice(1), ...box].join(" ").replace(/\s+/g, " ");
      lines.splice(solid + 1, q - solid, about, "", above[0], "");
      return parseScreen(lines.join("\n"));
    }
    const question = box.slice(0, asks + 1).join(" ");
    // A link wrapped at the box edge continues on a line with no spaces.
    const about = box
      .slice(asks + 1)
      .reduce(
        (text, l) => (/https?:\/\/\S+$/.test(text) && !/\s/.test(l) ? text + l : `${text} ${l}`),
        "",
      )
      .trim();
    lines.splice(boxTop, q - boxTop + 1, about, "", question, "");
    return parseScreen(lines.join("\n"));
  }
  // A long question wraps over several lines with no blank between them: they are one question.
  let qTop = q;
  while (
    qTop - 1 >= 0 &&
    q - qTop < 12 &&
    clean(lines[qTop - 1]).length > 0 &&
    !RULE.test(lines[qTop - 1]) &&
    !/^[←☐☒✔]/.test(clean(lines[qTop - 1]))
  )
    qTop -= 1;
  const question = lines
    .slice(qTop, q + 1)
    .map(clean)
    .join(" ");
  let top = qTop - 1;
  while (top >= 0 && qTop - top < 30 && !SOLID.test(lines[top])) top -= 1;
  const context = lines
    .slice(top + 1, qTop)
    .filter((l) => !RULE.test(l))
    .map(clean)
    .filter((l) => l.length > 0);
  // A multi-question form puts its tabs on one line: ← ☐ Chrome ☒ Connectors ✔ Submit →
  const tabs = context.length > 0 && /^←/.test(context[0]) ? tabsOf(context.shift()) : null;
  const tabbed =
    context.length > 0 && /^[☐☒✔]/.test(context[0]) ? context.shift().slice(1).trim() : null;
  // A tabbed form's header is its tabs, so the card says which question of how many this is.
  const header =
    tabs !== null && tabs.length > 1
      ? tabs
          .filter((tab) => !tab.submit)
          .map((tab) => (tab.answered ? `${tab.label} ✓` : tab.label))
          .join(" · ")
      : tabbed;
  const visible = options.filter((o) => !CUSTOM.test(o.label) && !DROPPED.test(o.label));
  const custom = options.find((o) => CUSTOM.test(o.label));
  const shown = visible.map((o) => ({
    index: o.number - 1,
    label: o.label,
    description: o.description,
  }));
  const plain = plainPermission(lines.slice(top + 1, qTop), question, shown);
  if (plain !== null)
    return {
      ...plain,
      header,
      context: "",
      selected: options.findIndex((o) => o.selected),
      customIndex: null,
      key: [question, ...options.map((o) => o.label), plain.details].join("\u0000"),
    };
  return {
    question,
    header,
    ...(tabs === null ? {} : { tabs }),
    context: context.join(" · ").slice(0, 600),
    options: shown,
    selected: options.findIndex((o) => o.selected),
    customIndex: custom === undefined ? null : custom.number - 1,
    key: [question, ...options.map((o) => o.label)].join("\u0000"),
  };
}

const shorten = (text, max) =>
  text.length <= max ? text : `${text.slice(0, max).replace(/\s+\S*$/, "")}…`;
/** The last few folders of a path: enough to recognise it, short enough to read. */
const shortPath = (path) => path.replace(/\/+$/, "").split("/").slice(-4).join("/");
const ALLOW = "Allow";
const ALWAYS = "Allow always for this";
const DENY = "Deny";

/**
 * Claude Code's permission dialog said plainly: who asks (the session or a background agent), what the tool would do,
 * and plain choices. The dialog's own words stay as `details`, and each relabelled choice keeps its words as its
 * description. Null when the screen is not a permission dialog. `block` is the screen between the dialog's top rule
 * and its question; a dashed rule boxes the command, diff or address.
 */
function plainPermission(block, question, options) {
  if (!/^Do you want to\b/i.test(question) || !options.some((o) => /^No\b/i.test(o.label)))
    return null;
  const parts = [[]];
  for (const line of block) {
    if (RULE.test(line)) parts.push([]);
    else if (clean(line).length > 0) parts.at(-1).push(clean(line));
  }
  const [head = [], boxed = [], ...rest] = parts;
  if (head.length === 0) return null;
  const from = /\s*·?\s*from the (.+?) agent\b\s*·?/i;
  const agent = head.map((l) => from.exec(l)?.[1]).find((a) => a !== undefined) ?? null;
  const [title = "", ...about] = head.map((l) => l.replace(from, " ").trim()).filter(Boolean);
  const desc = about.join(" ");
  const body = boxed.join(" ");
  const said = rest.flat().join(" ");
  let action;
  if (/^Bash\b/i.test(title)) {
    const cd = /^cd\s+("[^"]+"|'[^']+'|\S+)/.exec(body)?.[1]?.replace(/^["']|["']$/g, "");
    const target = /target:\s*(\S+)/.exec(said)?.[1];
    const where = cd ?? (target === undefined ? undefined : target.replace(/\/[^/]*$/, ""));
    action = /(^|[;&|]\s*|\s)rm\s/.test(` ${body}`)
      ? `run a command that deletes files${where === undefined ? "" : ` in ${shortPath(where)}`}`
      : "run a command";
  } else if (/^(Edit|Create|Write)\b/i.test(title)) {
    const file =
      /(?:edit to|create|write to)\s+(.+?)\?$/i.exec(question)?.[1] ?? boxed[0] ?? head[1];
    const verb = /^Create|create/.test(`${title} ${question}`) ? "create" : "edit";
    action = file === undefined ? `${verb} a file` : `${verb} ${shortPath(file)}`;
  } else if (/fetch/i.test(`${title} ${question}`)) {
    const host =
      /https?:\/\/([^/\s]+)/.exec(`${body} ${desc}`)?.[1] ??
      /\b([a-z0-9-]+(?:\.[a-z0-9-]+)+)\b/i.exec(body)?.[1];
    action = host === undefined ? "fetch a web page" : `fetch a web page from ${host}`;
  } else {
    const mcp =
      /^(.+?)\s+-\s+([\w.-]+)\s*\(.*\(MCP\)\s*$/.exec(body) ??
      /^(.+?)\s+-\s+([\w.-]+)\s*\(/.exec(desc);
    action =
      mcp !== null
        ? `use the ${mcp[2]} tool from ${mcp[1]}`
        : `use ${title.length > 0 ? title.replace(/\s+(command|use)$/i, "") : "a tool"}`;
  }
  const who =
    agent === null
      ? "Claude"
      : `A background agent${desc.length > 0 ? ` (${shorten(desc, 40)})` : ""}`;
  const why =
    agent === null && desc.length > 0 && /^Bash\b/i.test(title) ? `: ${shorten(desc, 80)}` : "";
  return {
    question: `${who} wants to ${action}${why}. Allow?`,
    details: [...head, ...boxed, ...rest.flat(), question].join("\n").slice(0, 2_000),
    options: options.map((o) => {
      const plain = /^Yes$/i.test(o.label)
        ? ALLOW
        : /^Yes\b/i.test(o.label)
          ? ALWAYS
          : /^No\b/i.test(o.label)
            ? DENY
            : o.label;
      return {
        ...o,
        label: plain,
        // "Yes, and don't ask again for rm commands in …" says what "always" covers.
        description: o.description || (/^(Yes|No)$/i.test(o.label) ? "" : o.label),
      };
    }),
  };
}

/**
 * Terminal prompts (D88): a permission dialog, an AskUserQuestion or a mod's ui.ask, read from a Herdr pane's screen
 * so T3 can show it with its options and answer it with keystrokes. Pure, Node built-ins only: the live agent
 * (`baton-live-acp.mjs`, installed beside this file) and the server's mirror both parse with it.
 */
import * as NodeCrypto from "node:crypto";

/**
 * A permission card's question ends with a short id of the prompt it was read from. T3 sends the question back with
 * the answer, so an answer meant for one dialog never matches another that reads the same.
 */
const withRef = (prompt) => ({
  ...prompt,
  question: `${prompt.question} (ref ${NodeCrypto.createHash("sha256").update(prompt.key).digest("hex").slice(0, 6)})`,
});
/** The id `withRef` adds: its presence marks a message as a permission card's answer. */
export const CARD_REF = /\(ref [0-9a-f]{6}\)$/;

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
    key: steadyKey([question, ...options.map((o) => o.label), context].join("\u0000")),
  };
}

/**
 * The prompt on a Claude Code screen, or null when none can be read. Options keep their screen
 * order (`index`), so an answer is arrows from the highlighted one plus Enter.
 */
export function parsePanePrompt(screen) {
  const text = String(screen ?? "").replace(ANSI, "");
  return parseScreen(text) ?? unreadPermission(text) ?? keyHintPrompt(text);
}

/**
 * The prompt a waiting session shows: one Tessaya knows, else Esc (and Enter only when no option list shows, since
 * Enter would take a dialog's highlighted "Yes") over the screen's last lines. Null when the pane is back at its input
 * box or shows nothing, so a card raised from an earlier screen can expire.
 */
export function parseWaitingScreen(screen) {
  const found = parsePanePrompt(screen);
  if (found !== null) return found;
  const lines = String(screen ?? "")
    .replace(ANSI, "")
    .replace(/\r/g, "")
    .split("\n");
  const details = screenTail(lines.join("\n"), 20);
  if (details === "" || inputBoxAt(lines) >= 0) return null;
  const note = "Tessaya didn't recognise this screen";
  const keys = hasOptionList(lines)
    ? [["Esc", "esc"]]
    : [
        ["Enter", "enter"],
        ["Esc", "esc"],
      ];
  return withRef({
    question: `Claude Code is waiting on a screen Tessaya didn't recognise. Press ${keys.length > 1 ? "a key" : "Esc to cancel"}?`,
    header: "In the terminal",
    context: "",
    details,
    options: keys.map(([label, key], index) => ({
      index,
      label,
      description: key === "enter" ? `${note}. This may approve or confirm.` : note,
      keys: [key],
    })),
    selected: 0,
    customIndex: null,
    key: `unknown\u0000${looseKey(details)}`,
  });
}

/** An option list among the last lines (numbered, or a highlighted `❯` line): Enter would choose its highlighted one. */
const hasOptionList = (lines) =>
  lines
    .slice(-20)
    .some(
      (l, i, tail) => NUMBERED.test(l) || (/^\s*❯\s+\S/.test(l) && !RULE.test(tail[i - 1] ?? "")),
    );

/**
 * A prompt's text without what changes on every redraw (spinners, "esc to interrupt", timers, durations, token counts
 * and percentages), so the key, and its card's ref, stays the same while the same prompt shows.
 */
const steadyKey = (text) =>
  text
    .split("\n")
    .filter((l) => !/esc to interrupt|^\s*[✻✶✢✳✽✺✷✸✹·*]\s/i.test(l))
    .join("\n")
    .replace(/\b\d+(?::\d{2}){1,2}\b/g, "#")
    .replace(/\b\d+(?:\.\d+)?\s*k?\s*(?:ms|s|%|tokens?)(?!\w)/gi, "#");
/** An unread screen has no command whose digits tell two prompts apart, so all of its numbers are dropped. */
const looseKey = (text) => steadyKey(text).replace(/\d+/g, "#");

/** The line of Claude Code's input box (a rule, then `❯`/`>`, a rule below) among the last lines, or -1. */
function inputBoxAt(lines) {
  for (let i = lines.length - 2; i >= 1 && i >= lines.length - 16; i -= 1)
    if (
      /^\s*[❯>](\s|$)/.test(lines[i]) &&
      RULE.test(lines[i - 1]) &&
      lines.slice(i + 1).some((l) => RULE.test(l))
    )
      return i;
  return -1;
}

const ENDS_SESSION = /\b(exit|quit|discard|delete)\b/i;
const HINT =
  /^((?:(?:ctrl|shift|alt|meta)\+\S+|enter|return|esc|escape|tab|space|backspace|[a-z0-9])(?:\s+(?:ctrl|shift|alt|meta)\+\S+)*)\s+to\s+(.+)$/i;
const NUMBERED_HINT = /^(\d)\.\s+(.+)$/;

/** One "<key> to <action>" or "1. <action>" of a hint line, or null for anything else. */
const hintOf = (part) => {
  const numbered = NUMBERED_HINT.exec(part);
  if (numbered !== null) return { keys: [numbered[1]], key: numbered[1], action: numbered[2] };
  const m = HINT.exec(part);
  if (m === null) return null;
  const said = m[1].replace(/^return$/i, "enter").replace(/^escape$/i, "esc");
  const keys = said.toLowerCase().split(/\s+/);
  const key = /^[a-z]+$/i.test(said) ? said[0].toUpperCase() + said.slice(1).toLowerCase() : said;
  return { keys, key, action: m[2] };
};

/**
 * A screen Tessaya has no reader for, which still says which keys do what: "Enter to review & send · Esc to discard
 * and exit". Each hint is an option in the screen's own words; choosing it presses that key. Arrow hints only move.
 */
function keyHintPrompt(screen) {
  const lines = screen.replace(/\r/g, "").split("\n");
  let at = lines.length - 1;
  while (at >= 0 && lines[at].trim() === "") at -= 1;
  let hints = null;
  for (let i = at; i >= 0 && i >= at - 3; i -= 1) {
    const parts = clean(lines[i])
      .split(/\s+·\s+/)
      .filter((p) => !/^[↑↓←→/]+\s+to\s/.test(p));
    const read = parts.map(hintOf);
    // A lone "2. No" is an option list's line, not a hint line.
    const lone = parts.length === 1 && NUMBERED_HINT.test(parts[0]);
    if (parts.length > 0 && !lone && read.every((h) => h !== null)) {
      hints = { line: i, read };
      break;
    }
  }
  if (hints === null || inputBoxAt(lines) > hints.line) return null;
  // Over an option list, Enter takes its highlighted choice (a dialog's "Yes"): never offered there.
  if (hasOptionList(lines.slice(0, hints.line)))
    hints.read = hints.read.filter((h) => !h.keys.includes("enter"));
  if (hints.read.length === 0) return null;
  const above = [];
  for (let i = hints.line - 1; i >= 0 && above.length < 4; i -= 1) {
    const text = clean(lines[i]);
    if (RULE.test(lines[i]) || (text === "" && above.length > 0)) break;
    if (text !== "") above.unshift(text);
  }
  const details = screenTail(lines.slice(0, hints.line + 1).join("\n"), 20);
  const question = above.length > 0 ? above.join(" ") : "Claude Code is waiting in its terminal.";
  return withRef({
    question,
    header: "In the terminal",
    context: "",
    details,
    options: hints.read.map((h, index) => ({
      index,
      label: `${h.action[0].toUpperCase()}${h.action.slice(1)} (${h.key})`,
      description: [
        ENDS_SESSION.test(h.action) ? "Warning: this may end the session." : "",
        h.keys.includes("enter") || /\bconfirm/i.test(h.action)
          ? "This may approve or confirm."
          : "",
      ]
        .filter(Boolean)
        .join(" "),
      keys: h.keys,
    })),
    selected: 0,
    customIndex: null,
    key: `hints\u0000${looseKey(details)}`,
  });
}

/**
 * A permission dialog whose options could not be read still gets Allow and Deny, with the screen as its details:
 * Enter takes the option a new dialog highlights (Yes), Esc declines.
 */
function unreadPermission(screen) {
  const lines = screen.replace(/\r/g, "").split("\n").slice(-40);
  const footer = lines.findLastIndex((l) => /Esc to cancel/.test(l));
  if (footer < 0) return null;
  // Only the dialog itself counts: from its top rule to its footer, never the transcript or a spinner above it.
  const top = lines.slice(0, footer).findLastIndex((l) => SOLID.test(l));
  const dialog = lines.slice(top + 1, footer);
  if (
    !dialog.some((l) => /Do you want to .*\?/.test(l)) ||
    !dialog.some((l) => /^\s*(❯\s*)?\d+\.\s+\S/.test(l))
  )
    return null;
  const details = screenTail(dialog.join("\n"), 20);
  return withRef({
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
    key: `unread\u0000${steadyKey(details)}`,
  });
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
    return withRef({
      ...plain,
      header,
      context: "",
      selected: options.findIndex((o) => o.selected),
      customIndex: null,
      key: steadyKey([question, ...options.map((o) => o.label), plain.details].join("\u0000")),
    });
  return {
    question,
    header,
    ...(tabs === null ? {} : { tabs }),
    context: context.join(" · ").slice(0, 600),
    options: shown,
    selected: options.findIndex((o) => o.selected),
    customIndex: custom === undefined ? null : custom.number - 1,
    key: steadyKey([question, ...options.map((o) => o.label)].join("\u0000")),
  };
}

const shorten = (text, max) =>
  text.length <= max ? text : `${text.slice(0, max).replace(/\s+\S*$/, "")}…`;
/** The last few folders of a path: enough to recognise it, short enough to read. */
const shortPath = (path) => {
  const trimmed = path.replace(/(.)\/+$/, "$1");
  const parts = trimmed.split("/");
  return parts.length <= 5 ? trimmed : parts.slice(-4).join("/");
};
const ALLOW = "Allow";
const ALWAYS = "Allow always for this";
const DENY = "Deny";
const unquote = (word) => word.replace(/^["']|["']$/g, "");
/** Commands that delete or overwrite: rm, find -delete, shred, dd, a `>` truncation, mv into /dev/null, git's own. */
const DESTRUCTIVE =
  /(^|[\s;&|(])(rm|shred)\s|\sfind\s.*\s-delete\b|^find\s.*\s-delete\b|(^|[\s;&|])dd\s.*\bof=|(^|[^>&\d])>\s*(?![&>]|\/dev\/null)[^\s|&;]|(^|[\s;&|])mv\s.*\/dev\/null|\bgit\s+(clean\s+-\S*f|reset\s+--hard|checkout\s+--\s|restore\s)/;

/** What an `rm` deletes, from the command alone: its first path, resolved against a leading `cd`. */
const rmTarget = (command, cd) => {
  const word = /(?:^|[\s;&|(])rm\s+(?:-\S+\s+)*("[^"]+"|'[^']+'|\S+)/.exec(command)?.[1];
  if (word === undefined) return undefined;
  const path = unquote(word);
  return /^[/~]/.test(path) || cd === undefined ? path : `${cd.replace(/\/+$/, "")}/${path}`;
};

/** A Bash dialog said plainly. The command itself is always shown: a description may follow it, never replace it. */
const bashAction = (body, desc, said, agent) => {
  const command = `\`${shorten(body.replace(/`/g, "'"), 120)}\``;
  const cd = /^cd\s+("[^"]+"|'[^']+'|\S+)/.exec(body)?.[1];
  const folder = cd === undefined ? undefined : unquote(cd);
  const flagged = /dangerous/i.test(said);
  const target = flagged ? /target:\s*(\S+)/.exec(said)?.[1] : rmTarget(body, folder);
  if (flagged || DESTRUCTIVE.test(body)) {
    const where =
      target !== undefined
        ? ` in ${flagged ? shorten(target, 100) : shortPath(target)}`
        : folder === undefined
          ? ""
          : ` in ${shortPath(folder)}`;
    const verb =
      /(^|[\s;&|(])rm\s/.test(body) || target !== undefined
        ? "deletes files"
        : "deletes or overwrites files";
    return { warn: flagged, action: `run ${command}, which ${verb}${where}` };
  }
  const why = agent === null && desc.length > 0 ? ` (${shorten(desc, 80)})` : "";
  return { warn: false, action: `run ${command}${why}` };
};

/**
 * A permission dialog said plainly: who asks, what it acts on (so one card's answer never fits the next) and plain
 * choices; the dialog's words stay as `details`. Null for any other screen. `block` runs from the top rule to the
 * question; a dashed rule boxes the command, diff or address.
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
  const mcp =
    /^(.+?)\s+-\s+([\w.-]+)\s*\(.*\(MCP\)\s*$/.exec(body) ??
    /^(.+?)\s+-\s+([\w.-]+)\s*\(/.exec(desc);
  let action;
  let warn = /dangerous/i.test(said);
  if (/^Bash\b/i.test(title)) ({ action, warn } = bashAction(body, desc, said, agent));
  else if (/^(Edit|Create|Write)\b/i.test(title)) {
    const file =
      (boxed[0]?.includes("/") ? boxed[0] : undefined) ??
      /(?:edit to|create|write to)\s+(.+?)\?$/i.exec(question)?.[1] ??
      boxed[0] ??
      head[1];
    const verb = /^Create|create/.test(`${title} ${question}`) ? "create" : "edit";
    action = file === undefined ? `${verb} a file` : `${verb} ${shortPath(file)}`;
  } else if (mcp !== null) {
    action = `use the ${mcp[2]} tool from ${mcp[1]} (${shorten(body || desc, 100)})`;
  } else if (/^(Fetch|Web ?fetch)\b/i.test(title)) {
    const url = /https?:\/\/\S+/.exec(`${body} ${desc}`)?.[0];
    action = url === undefined ? "fetch a web page" : `fetch ${shorten(url, 100)}`;
  } else {
    const tool = title.length > 0 ? title.replace(/\s+(command|use)$/i, "") : "a tool";
    action = `use ${tool}${body.length > 0 ? ` (${shorten(body, 100)})` : ""}`;
  }
  const who =
    agent === null
      ? "Claude"
      : `A background agent${desc.length > 0 ? ` (${shorten(desc, 40)})` : ""}`;
  let always = false;
  return {
    question: `${warn ? "Claude Code flags this as dangerous: " : ""}${who} wants to ${action}. Allow?`,
    details: [...head, ...boxed, ...rest.flat(), question].join("\n").slice(0, 2_000),
    options: options.map((o) => {
      // Only the first "Yes, …" is "always"; a second keeps its own words so no two choices read the same.
      const plain = /^Yes$/i.test(o.label)
        ? ALLOW
        : /^Yes\b/i.test(o.label) && !always
          ? ALWAYS
          : /^No\b/i.test(o.label)
            ? DENY
            : o.label;
      if (plain === ALWAYS) always = true;
      return {
        ...o,
        label: plain,
        // "Yes, and don't ask again for rm commands in …" says what "always" covers.
        description:
          o.description || (/^(Yes|No)$/i.test(o.label) || plain === o.label ? "" : o.label),
      };
    }),
  };
}

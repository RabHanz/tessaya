/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
import { isBareStop } from "./dictation.ts";
/**
 * Screen companion (D84), the pure half: prompts, the [POINT] tag, coordinates, drive plans.
 * Ported from farzaa/clicky and Bitshank-2338/clicky-windows, both MIT; notices in
 * docs/baton/THIRD_PARTY_NOTICES.md. clicky-windows' PyQt6 UI (GPL-3.0) is not used.
 */

/** One captured display, as the model is told about it. 1-based, cursor display first. */
export interface ScreenShot {
  readonly screen: number;
  /** Pixel size of the image the model sees. */
  readonly width: number;
  readonly height: number;
  readonly cursorHere: boolean;
  /** The display's rectangle in global desktop coordinates (Electron DIPs). */
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface ScreenPoint {
  readonly x: number;
  readonly y: number;
  readonly label: string | null;
  /** 1-based; null = the cursor's screen. */
  readonly screen: number | null;
  /** How sure the model is that this named thing is exactly here, 0..1; null when it did not say. */
  readonly confidence: number | null;
}

/** Below this the pointer stays put. A wrong pointer is worse than none. */
export const MIN_POINT_CONFIDENCE = 0.75;

export const pointable = (point: ScreenPoint | null): point is ScreenPoint =>
  point !== null && point.confidence !== null && point.confidence >= MIN_POINT_CONFIDENCE;

export type ScreenMode = "look" | "teach" | "drive";

// ── Prompts ─────────────────────────────────────────────────────────────────

const POINTING = `element pointing:
you have a small blue triangle cursor that can fly to and point at things on screen. use it whenever pointing at something he asked about would genuinely help.

only point at a real element you can actually see in a screenshot. never guess. if what he asked about is not visible, say so plainly in your first sentence ("i can't see an export button on your screen"), say what is there instead or how to get to it if you know, append [POINT:none], and do not imply it is somewhere it isn't. if he may mean something else on screen, ask which.

when you do point, append a coordinate tag at the very end of your response, after your spoken text. each screenshot is labelled with its image dimensions. format: [POINT:x,y:label:screenN:confidence]. x,y are integer pixel coordinates of the element's centre in that screenshot's coordinate space. label is the element's exact visible text or name, one to three words, as written on screen; never a description. screenN is the screen number from the image label. confidence is 0 to 1: how sure you are that this exact element is there. below 0.75 means you are not sure; then ask instead.

if pointing wouldn't help, append [POINT:none].`;

const VOICE_RULES = `your reply will be spoken aloud, so write the way you'd actually talk.
- default to one or two sentences. be direct and dense. if the user asks you to explain more, go deeper.
- write for the ear: short sentences, no lists, markdown or formatting. don't use symbols that sound weird read aloud.
- if the question relates to what's on the screen, reference specific things you see. if the screenshot isn't relevant, answer the question directly.
- you can help with anything: code, writing, any app, general knowledge.
- never say "simply" or "just". don't read code out verbatim; describe what it does or what needs to change.
- don't end with dead-end yes/no questions like "want me to show you?".
- if you receive several screen images, the one marked "cursor is here" is the primary focus.`;

/** Asking about the screen. farzaa/clicky's companion prompt, adapted. */
export const LOOK_PROMPT = `you're Tessaya's screen companion. the user just asked you something by voice or from a hotkey, and you can see their screen(s). this is an ongoing conversation; you remember what they said before.

${VOICE_RULES}

${POINTING}`;

/** Teaching: one step at a time, checked against the screen each time. */
export const TEACH_PROMPT = `you're Tessaya's screen companion in teach mode. the user wants to learn to do something in whatever app is on their screen, and you guide them one step at a time, the way a patient expert sitting beside them would.

each turn you get a fresh screenshot. every turn:
1. look at the screen first. decide whether the previous step was done. never assume it was. if it wasn't, or something unexpected happened (an error, a dialog, the wrong page), say so briefly and help them recover.
2. give ONLY the next single step: what to click, type or choose, and in a few words why it matters, so they learn rather than only follow. one or two short sentences.
3. point at the thing to click with a [POINT] tag (rules below). point on every step that involves something on screen.
4. when the goal is reached, say so in one sentence, add one tip worth remembering, and end with [DONE] instead of a point.

if the goal can't be done from here, say what's missing and end with [DONE].

${VOICE_RULES}

${POINTING}`;

export const teachTurn = (input: {
  readonly goal: string;
  readonly step: number;
  readonly note?: string;
}): string =>
  input.step === 1
    ? `goal: ${input.goal}\nthis is the screen now. give the first step.`
    : `goal: ${input.goal}\nstep ${input.step}. ${input.note ?? "here is the screen now."} check whether the previous step was done, then give only the next step.`;

/** How each screenshot is labelled, with its pixel dimensions (farzaa's label shape). */
export const screenLabel = (shot: ScreenShot, count: number): string =>
  `${count === 1 ? "user's screen (the window he is using is here)" : `screen ${shot.screen} of ${count}${shot.cursorHere ? ", the window he is using is here (primary focus)" : ", secondary screen"}`} (image dimensions: ${shot.width}x${shot.height} pixels)`;

// ── Reply parsing ───────────────────────────────────────────────────────────

// farzaa's end-anchored pattern, loosened to accept the tag anywhere and a missing label.
const POINT_RE =
  /\[POINT:(?:none|(\d+)\s*,\s*(\d+)(?::([^\]]*?))?(?::screen(\d+))?(?::(0?\.\d+|[01](?:\.0+)?))?)\]/gi;
const DONE_RE = /\[DONE\]/gi;

export interface ParsedReply {
  /** What is spoken and shown: the reply without tags. */
  readonly spoken: string;
  readonly point: ScreenPoint | null;
  readonly done: boolean;
}

export const parseReply = (text: string): ParsedReply => {
  let point: ScreenPoint | null = null;
  for (const m of text.matchAll(POINT_RE)) {
    if (m[1] === undefined || m[2] === undefined) continue;
    // The last tag wins: a reply that corrects itself points where it ended up.
    point = {
      x: Number(m[1]),
      y: Number(m[2]),
      label: m[3]?.trim() || null,
      screen: m[4] === undefined ? null : Number(m[4]),
      confidence: m[5] === undefined ? null : Number(m[5]),
    };
  }
  const spoken = text.replace(POINT_RE, " ").replace(DONE_RE, " ").replace(/\s+/g, " ").trim();
  return { spoken, point, done: /\[DONE\]/i.test(text) };
};

// ── Coordinates ─────────────────────────────────────────────────────────────

/** The shot a point refers to: its screen number, else the cursor's screen. */
export const shotFor = (
  shots: ReadonlyArray<ScreenShot>,
  screen: number | null,
): ScreenShot | null =>
  (screen !== null ? shots.find((s) => s.screen === screen) : undefined) ??
  shots.find((s) => s.cursorHere) ??
  shots[0] ??
  null;

/** Screenshot pixels → global desktop coordinates (farzaa's maths; Electron is top-left already). */
export const toDesktop = (
  point: { readonly x: number; readonly y: number },
  shot: ScreenShot,
): { readonly x: number; readonly y: number } => {
  const x = Math.max(0, Math.min(point.x, shot.width));
  const y = Math.max(0, Math.min(point.y, shot.height));
  return {
    x: Math.round(shot.bounds.x + (x * shot.bounds.width) / shot.width),
    y: Math.round(shot.bounds.y + (y * shot.bounds.height) / shot.height),
  };
};

/**
 * The capture source for one display: by its id, else (Linux X11 reports no display id) by position. A display with no
 * source is reported as missing, never silently dropped.
 */
export const pickSource = <S extends { readonly display_id: string }>(
  sources: ReadonlyArray<S>,
  displayId: number,
  index: number,
): S | undefined =>
  sources.find((s) => s.display_id === String(displayId)) ??
  (sources.every((s) => s.display_id === "") ? sources[index] : undefined);

/** What to tell the model when fewer displays came back than exist. */
export const missingDisplaysNote = (captured: number, total: number): string | null =>
  captured >= total
    ? null
    : `Only ${captured} of ${total} displays could be captured; the others gave no picture. Say which one is missing.`;

/** Long edge capped at `max` (farzaa uses 1280: enough to read UI, cheap to send). */
export const captureSize = (
  width: number,
  height: number,
  // Claude reads up to 1568 px on the long edge; at 4K and 175% a smaller shot loses UI text.
  max = 1568,
): { readonly width: number; readonly height: number } => {
  const scale = Math.min(1, max / Math.max(width, height));
  return { width: Math.round(width * scale), height: Math.round(height * scale) };
};

/**
 * How much two same-size grayscale thumbnails differ: the share of pixels that moved by more
 * than `threshold`. Used to notice a teach step was done and to refuse a stale drive plan.
 */
export const screenDifference = (a: Uint8Array, b: Uint8Array, threshold = 24): number => {
  if (a.length !== b.length || a.length === 0) return 1;
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i]! - b[i]!) > threshold) changed++;
  return changed / a.length;
};

/**
 * The display that changed most. Each display is judged alone: a line typed on one is a share of
 * that display, and averaging in a quiet second screen would halve it below the threshold.
 */
/** Polls without a desktop change event before a lesson looks anyway (a canvas stroke raises none). */
export const TEACH_LOOK_ANYWAY = 10;

/**
 * Whether a waiting lesson should take a picture now. `count` is the sidecar's running count of desktop changes
 * (a window, menu, focus or value), null where there is none: then every poll looks, as before.
 */
export const teachShouldLook = (
  state: { readonly seen: number | null; readonly quiet: number },
  count: number | null,
): { readonly look: boolean; readonly seen: number | null; readonly quiet: number } => {
  const changed = count === null || state.seen === null || count !== state.seen;
  const look = changed || state.quiet + 1 >= TEACH_LOOK_ANYWAY;
  return { look, seen: count, quiet: look ? 0 : state.quiet + 1 };
};

export const screensDifference = (
  a: ReadonlyArray<Uint8Array>,
  b: ReadonlyArray<Uint8Array>,
  threshold = 24,
): number => {
  if (a.length !== b.length || a.length === 0) return 1;
  return Math.max(...a.map((screen, i) => screenDifference(screen, b[i]!, threshold)));
};

/** What the sentence list never needed: commands as typed, not as said. */
const DANGEROUS_COMMAND = new RegExp(
  [
    String.raw`\brm\s+(-\w*[rf]|--recursive|--force)`,
    String.raw`\bgit\s+push\b.{0,200}(--force|\s-f\b|\s\+\S)`,
    String.raw`\bgit\s+reset\s+--hard`,
    String.raw`\b(del|erase|rd|rmdir)\b.{0,200}\/[sqf]\b`,
    String.raw`\bremove-item\b.{0,200}-(recurse|force)`,
    String.raw`\bformat\s+[a-z]:`,
    String.raw`\bformat-volume\b`,
    String.raw`\b(iex|invoke-expression|mshta|certutil|bitsadmin|regsvr32|rundll32)\b`,
    String.raw`\|\s*(sudo\s+)?(sh|bash|zsh|iex|powershell|pwsh|python)\b`,
  ].join("|"),
  "i",
);

/** Quoting tricks a shell removes before it runs anything. */
const unquoted = (text: string): string =>
  text.replace(/\$\{?IFS\}?/g, " ").replace(/['"`^()]/g, "");

/**
 * The high-risk subject anywhere in a plan or what it would paste, or null. A second layer behind
 * Run it, not a boundary: no list catches every spelling of a command (D114).
 */
export const dangerousCommand = (text: string): boolean =>
  DANGEROUS_COMMAND.test(text) || DANGEROUS_COMMAND.test(unquoted(text));

/** Deletes, sends, pays or publishes: never done without his yes, whatever the setting (D127). */
const SENSITIVE = new RegExp(
  [
    String.raw`\b(?:rm|del|erase|rmdir|rd|unlink|delete|remove|remove-item|drop|truncate|wipe)\b`,
    String.raw`\b(?:send|sends|email|e-mail|mail|message|reply|tweet|post|publish|share|upload|submit)\b`,
    String.raw`\b(?:pay|payment|purchase|buy|checkout|order|transfer|refund|invoice|subscribe)\b`,
    String.raw`\b(?:deploy|release|merge|push|shutdown|reboot|format)\b`,
    String.raw`-X\s*(?:POST|PUT|PATCH|DELETE)\b`,
  ].join("|"),
  "i",
);
export const sensitiveAction = (text: string): boolean => SENSITIVE.test(text);

/** Real terminals: a paste or right-click here runs what nobody read. */
const SHELL_APP =
  /^(cmd|powershell|powershell_ise|pwsh|windowsterminal|windowsterminalpreview|windowsterminalcanary|wt|terminal|conhost|openconsole|bash|zsh|wsl|wslhost|mintty|alacritty|wezterm|wezterm-gui|tabby|warp|hyper|ssh|putty|python\d?|pythonw?|node|ubuntu\d*|debian|kali)(\.exe)?\s*:/i;

export const isShellWindow = (label: string): boolean => SHELL_APP.test(label);

/** A window named by the model ("Notepad", "Windows PowerShell") that is a command line, or sounds like one. */
export const namesShell = (name: string): boolean =>
  isShellWindow(name) ||
  /\b(?:cmd|command prompt|powershell|pwsh|terminal|console|bash|zsh|wsl|ubuntu|ssh|putty|wezterm|alacritty)\b/i.test(
    name,
  );

/** Ctrl+V or Shift+Insert: keys that type whatever the clipboard holds. */
export const isPasteKeys = (keys: ReadonlyArray<string>): boolean => {
  const set = new Set(keys.map((k) => k.toLowerCase()));
  return (
    ((set.has("ctrl") || set.has("control")) && set.has("v")) ||
    (set.has("shift") && set.has("insert"))
  );
};

interface KeysWindow {
  readonly window?: number | undefined;
  readonly label: string;
}

/**
 * Whether keys may go now, judged at the moment they are sent (Drive's checks, now every hands path's): the keyboard is
 * still in the window they were allowed for, a command line gets them only when one was agreed to, a paste never
 * reaches one, and a paste goes only while the clipboard holds what it held when they were allowed. Null to send.
 */
export const keysRefusal = (at: {
  /**
   * Where the keyboard was when these keys were allowed (the gate's judgement, moved along by her own clicks); `shell`
   * when a command line was agreed to; null when nothing was noted.
   */
  readonly allowed:
    | (KeysWindow & { readonly shell: boolean; readonly clipboard?: string | undefined })
    | null;
  readonly now: KeysWindow | null;
  readonly paste: boolean;
  readonly clipboard: string | null;
}): string | null => {
  const { allowed, now } = at;
  if (now === null) return "I couldn't tell where the keys would go, so nothing was sent.";
  if (
    allowed !== null &&
    (allowed.window !== undefined && now.window !== undefined
      ? allowed.window !== now.window
      : allowed.label !== now.label)
  )
    return "The window with the keyboard changed since that was allowed, so nothing was sent.";
  if (isShellWindow(now.label)) {
    if (at.paste) return "That would paste into a command line, so nothing was sent.";
    if (allowed?.shell !== true)
      return "That reached a command line nobody agreed to, so nothing was sent.";
  }
  if (at.paste && allowed?.clipboard !== undefined && at.clipboard !== allowed.clipboard)
    return "The clipboard changed since that was allowed, so nothing was sent.";
  return null;
};

// ── What a sentence asks for ────────────────────────────────────────────────

export type ScreenIntent =
  | { readonly kind: ScreenMode; readonly text: string }
  | { readonly kind: "next" | "stop" | "repeat" };

// clicky-windows tutor.py's NEXT_RE/STOP_RE, plus "done" phrasings for a guide.
const NEXT_RE =
  /^\s*(next|continue|go on|keep going|what'?s next|what now|done|i did it|i'?ve done it|did it|ok(ay)?,? (done|next)|got it|i clicked it)[\s.!?]*$/i;
const STOP_RE =
  /^\s*(stop|quit|cancel|never ?mind|that'?s enough|end (the )?(lesson|guide|tour)|stop (teaching|guiding|driving))[\s.!?]*$/i;
const REPEAT_RE = /^\s*(repeat|say (it|that) again|say again|once more|what did you say)[\s.!?]*$/i;

const DRIVE_RE =
  /^\s*(?:(?:please|hey|ok(?:ay)?)[\s,]+)?(?:(?:can|could|would) you\s+)?(?:take over\b|drive\b|do (?:it|this|that) for me\b|(?:click|open|fill(?: in| out)?|type|go to|set|turn|change|press|select|drag|close|save|send|search|find|book|install|rename|move|delete|create|add|switch)\b.*\bfor me\b)/i;
const TEACH_RE =
  /^\s*(?:(?:please|hey|ok(?:ay)?)[\s,]+)?(?:(?:can|could|would) you\s+)?(?:teach me|show me how|walk me through|guide me|tutor me|help me learn|how do i\b.*\b(?:here|in this|on this|step by step)\b|.*\bstep by step\b)/i;
const LOOK_RE =
  /\b(?:look at (?:this|that|my screen|the screen|it)|(?:what'?s|what is) (?:this|that|on (?:my |the )?screen)|what am i looking at|on (?:my|the) screen|(?:this|that) (?:error|screen|window|page|button|message|dialog|warning|chart|code|menu|setting)|where(?:'s| is| are) the .+\b(?:button|menu|icon|field|setting|option|tab|link|toggle)\b|point (?:at|to)\b|explain (?:this|what'?s on))/i;
// A colon only: speech writes "Look, can you…" with a comma, and that is a sentence, not a mode.
const PREFIX_RE = /^\s*(look|screen|teach|guide|drive)\s*:\s*(.+)$/i;

/** The sentences with one possible meaning: lesson controls, and his own "drive:" prefixes. */
export const screenControl = (text: string, active: boolean): ScreenIntent | null => {
  const t = text.trim();
  // A bare stop is always a stop, never a thing for the grammar or a model to ponder.
  if (isBareStop(t)) return { kind: "stop" };
  if (active) {
    if (NEXT_RE.test(t)) return { kind: "next" };
    if (STOP_RE.test(t)) return { kind: "stop" };
    if (REPEAT_RE.test(t)) return { kind: "repeat" };
  }
  const prefixed = PREFIX_RE.exec(t);
  if (prefixed === null) return null;
  const word = prefixed[1]!.toLowerCase();
  const kind: ScreenMode =
    word === "drive" ? "drive" : word === "teach" || word === "guide" ? "teach" : "look";
  return { kind, text: prefixed[2]!.trim() };
};

/**
 * Whether a sentence is for the screen companion, by its words. The fallback when no model can be
 * reached; normally the brain decides (D100). With a lesson or a drive running, "next",
 * "stop" and "repeat" are its; otherwise only sentences that plainly ask about, or to be taught
 * or helped on, the screen. Everything else stays Baton's intent grammar, so "show me the
 * scheduler session" is still §21's show.
 */
export const parseScreenIntent = (text: string, active: boolean): ScreenIntent | null => {
  const t = text.trim();
  if (t.length === 0) return null;
  const control = screenControl(t, active);
  if (control !== null) return control;
  if (DRIVE_RE.test(t)) return { kind: "drive", text: t };
  if (TEACH_RE.test(t)) return { kind: "teach", text: t };
  if (LOOK_RE.test(t)) return { kind: "look", text: t };
  return null;
};

// ── Approval ────────────────────────────────────────────────────────────────

/** Whose yes a capture needs. Always the user's; this only says how often he is asked. */
export type CaptureApproval = "ask" | "always";

export const needsCaptureApproval = (input: {
  readonly policy: CaptureApproval;
  /** Until when an "allow for an hour" answer holds, epoch ms. */
  readonly allowedUntil: number;
  /** A lesson or drive he already approved: its own follow-up captures. */
  readonly sessionApproved: boolean;
  readonly now: number;
}): boolean =>
  input.policy !== "always" && !input.sessionApproved && input.now >= input.allowedUntil;

/**
 * Words that are not his (a paired device's, a run's log): remembered so nothing typed from them counts as his own text.
 * The oldest go first past `cap`, so recent ones are never forgotten.
 */
export const rememberOutside = (said: Set<string>, text: string, cap = 200): void => {
  said.add(text);
  while (said.size > cap) said.delete(said.values().next().value!);
};

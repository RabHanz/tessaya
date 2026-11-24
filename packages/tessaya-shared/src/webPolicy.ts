/**
 * The assistant in his browser (D3) through the shared Playwright bridge (VentureOS docs/operations/BROWSER-BRIDGE.md):
 * its tools reach the model as `web_<tool>` on her own tool server. Reading is routine and taints the turn; a submit,
 * send, purchase, delete or settings change asks aloud; money movement is refused. Social sites follow a setting (on,
 * with a plain switch to turn it off), and every action there asks, is rate-limited and is logged.
 */
import { highRiskSubject } from "./intentParser.ts";
import { sensitiveAction } from "./screenCompanion.ts";

/** A bridge tool as the model calls it: `browser_click` is `mcp__baton__web_click`. */
export const CHROME_PREFIX = "mcp__baton__web_";
/** The bridge's own prefix on its tool names, swapped for `web_` so they never meet her `browser_route`. */
export const BRIDGE_NATIVE_PREFIX = "browser_";

const SOCIAL = [
  "facebook.com",
  "fb.com",
  "fb.me",
  "messenger.com",
  "instagram.com",
  "threads.net",
  "threads.com",
  "twitter.com",
  "x.com",
  "t.co",
  "tiktok.com",
  "linkedin.com",
  "snapchat.com",
  "pinterest.com",
  "reddit.com",
  "tumblr.com",
  "bsky.app",
  "bsky.social",
  "mastodon.social",
  "whatsapp.com",
  "wa.me",
  "telegram.org",
  "t.me",
  "discord.com",
  "discord.gg",
  "youtube.com",
  "youtu.be",
  "twitch.tv",
  "onlyfans.com",
  "truthsocial.com",
  "gab.com",
  "vk.com",
  "weibo.com",
];

/** The host of a web address, or null when it is not one. */
export const hostOf = (raw: string): string | null => {
  try {
    const url = new URL(raw);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url.hostname.toLowerCase().replace(/\.$/, "")
      : null;
  } catch {
    return null;
  }
};

/**
 * The site a browser window is on, from its address bar as ui_tree lists it (`edit: Address and search bar = "…"`):
 * Chrome and Edge show it without the scheme. Null when no address bar with a web address is listed.
 */
export const addressBarHost = (controls: ReadonlyArray<string>): string | null => {
  for (const line of controls) {
    const m = /\b(?:edit|combo box)\b[^:]*:\s*[^=]*\baddress\b[^=]*=\s*"([^"\s…]+)/i.exec(line);
    if (m === null) continue;
    const raw = m[1]!;
    const host = hostOf(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
    // A site has a dot in its name: a folder path in a file window's address box is not one.
    return host !== null && host.includes(".") ? host : null;
  }
  return null;
};

export const isSocialHost = (host: string): boolean =>
  SOCIAL.some((d) => host === d || host.endsWith(`.${d}`));

/** Wires, transfers, withdrawals and sends of money or coins. Never done by Tessaya, asked or not. */
const MONEY = new RegExp(
  [
    String.raw`\b(?:wire|transfer|send|move|withdraw|remit|cash\s?out)\b.{0,30}\b(?:money|funds?|cash|payment|usd|eur|gbp|btc|eth|crypto|bitcoin|balance)\b`,
    String.raw`\b(?:money|funds?|cash|crypto|bitcoin)\b.{0,20}\b(?:transfer|wire|withdraw|send)\b`,
    String.raw`\b(?:wire|transfer|send|pay)\b.{0,15}[$€£]\s?\d`,
    String.raw`\bwithdraw(?:al)?\b`,
    String.raw`\b(?:confirm|authori[sz]e|approve)\s+(?:the\s+)?(?:transfer|wire|payment)\b`,
    String.raw`\bpay\s+(?:now|invoice|bill|out)\b`,
  ].join("|"),
  "i",
);
export const moneyMovement = (text: string): boolean => MONEY.test(text);

const SHOPPING =
  /\b(?:buy|purchase|order|checkout|check out|subscribe|place order|add card|change password|delete account|save settings|settings)\b/i;

/** Bridge tools (Playwright MCP names without `browser_`) that only look; what they return taints the turn. */
const READ_TOOLS = new Set(["snapshot", "take_screenshot", "console_messages", "network_requests"]);
/** Bridge tools that change nothing on the page. */
const PASSIVE_TOOLS = new Set(["wait_for", "resize", "hover", "mouse_move_xy"]);
/** Bridge tools that run code or send his files: always his yes. */
const RISKY_TOOLS = new Set(["evaluate", "run_code", "file_upload", "upload_inline", "install"]);

// Either name her tool server goes by (rename R1 in operator.ts).
const BRIDGE_CALL = /^mcp__(?:baton|tessaya)__web_/;
export const isChromeTool = (tool: string): boolean => BRIDGE_CALL.test(tool);
/** The bridge tool a call names, without the server or `web_`: `click` for `mcp__baton__web_click`. */
export const bridgeToolName = (tool: string): string => tool.replace(BRIDGE_CALL, "");

/** A chrome call only looks at a page: the turn is tainted by what comes back. */
export const chromeReads = (tool: string): boolean => {
  if (!isChromeTool(tool)) return false;
  return READ_TOOLS.has(bridgeToolName(tool));
};

export interface ChromeContext {
  readonly tainted: boolean;
  /** Social accounts are switched on (on by default, with a plain switch to turn them off). */
  readonly socialOn: boolean;
  /** The host the tab was last taken to in this conversation, when known. */
  readonly pageHost: string | null;
  /** Social actions on this host in the last hour. */
  readonly recentSocial: number;
  /** The text is his own words. */
  readonly textIsHis: boolean;
  /** Whose work it is: `sebastian` for his outreach, whose every act asks his yes to the exact words. */
  readonly owner?: "tessaya" | "sebastian";
}

export const SOCIAL_PER_HOUR = 10;

export type ChromeVerdict =
  | { readonly verdict: "allow" }
  | { readonly verdict: "ask"; readonly why: string; readonly risky?: true }
  | { readonly verdict: "deny"; readonly why: string };

const flat = (input: Readonly<Record<string, unknown>>): string =>
  Object.values(input)
    .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
    .join(" ")
    .slice(0, 2_000);

/** Which host an action is on: a web address in the call, else the tab's last known page. */
export const hostForCall = (input: Readonly<Record<string, unknown>>, pageHost: string | null) => {
  const url = typeof input["url"] === "string" ? input["url"] : "";
  return hostOf(url) ?? pageHost;
};

/** What an act would put on the page, word for word, for his yes. */
const exactWords = (input: Readonly<Record<string, unknown>>): string => {
  const words = [input["text"], input["key"], input["values"], input["fields"]]
    .filter((v) => v !== undefined)
    .map((v) => (typeof v === "string" ? `"${v}"` : JSON.stringify(v)));
  const target = typeof input["element"] === "string" ? ` on ${input["element"]}` : "";
  return `${words.length > 0 ? words.join(", ") : "a click"}${target}`.slice(0, 600);
};

export const judgeChrome = (
  tool: string,
  input: Readonly<Record<string, unknown>>,
  ctx: ChromeContext,
): ChromeVerdict => {
  const name = bridgeToolName(tool);
  const text = flat(input);
  if (name === "close") {
    return { verdict: "deny", why: "The shared browser is never closed; close only your own tab." };
  }
  if (moneyMovement(text)) {
    return { verdict: "deny", why: "Moving money is never done by Tessaya. Do it yourself." };
  }
  const url = typeof input["url"] === "string" ? input["url"] : "";
  if (url !== "" && hostOf(url) === null) {
    return { verdict: "deny", why: "Only web pages (http or https) are opened." };
  }
  const host = hostForCall(input, ctx.pageHost);
  const social = host !== null && isSocialHost(host);
  const tabAction = name === "tabs" ? String(input["action"] ?? "list") : null;
  const opens = name === "navigate" || name === "navigate_back" || tabAction === "new";
  const looks =
    READ_TOOLS.has(name) ||
    PASSIVE_TOOLS.has(name) ||
    tabAction === "list" ||
    tabAction === "select";
  const mutating = !looks && !opens;
  if (social && !ctx.socialOn) {
    return {
      verdict: "deny",
      why: "Social accounts are switched off in Tessaya's settings, so I won't open or act on one.",
    };
  }
  if (social && mutating) {
    if (ctx.recentSocial >= SOCIAL_PER_HOUR) {
      return {
        verdict: "deny",
        why: `That is ${SOCIAL_PER_HOUR} actions on ${host} in the last hour; I stop there.`,
      };
    }
    return {
      verdict: "ask",
      why: `On ${host}: this may post, comment, like, follow, message, share, delete or change a setting. It would put ${exactWords(input)}. It asks every time.`,
      risky: true,
    };
  }
  // Sebastian's outreach goes out only on his yes to the exact words (Director, 2026-11-24).
  if (ctx.owner === "sebastian" && mutating) {
    return {
      verdict: "ask",
      why: `Sebastian would put ${exactWords(input)}${host === null ? "" : ` on ${host}`}. Nothing goes out without your yes.`,
      risky: true,
    };
  }
  if (opens) {
    // A long address can carry what was read out of the page.
    return ctx.tainted && url.length > 200
      ? { verdict: "ask", why: "It follows something it read, in a long address." }
      : { verdict: "allow" };
  }
  if (looks) return { verdict: "allow" };
  if (tabAction === "close") return { verdict: "ask", why: "It wants to close a tab." };
  if (RISKY_TOOLS.has(name)) {
    return { verdict: "ask", why: `It wants to use ${name} in your browser.`, risky: true };
  }
  const subject = highRiskSubject(text);
  if (subject !== null || SHOPPING.test(text)) {
    return {
      verdict: "ask",
      why: `This is ${subject ?? "a purchase, order or settings change"}.`,
      risky: true,
    };
  }
  if (
    sensitiveAction(text) ||
    input["submit"] === true ||
    /^(enter|return)$/i.test(String(input["key"] ?? ""))
  ) {
    return { verdict: "ask", why: "That may submit, send or delete something." };
  }
  if (ctx.tainted && !ctx.textIsHis)
    return { verdict: "ask", why: "It follows something it read." };
  return { verdict: "allow" };
};

/** A simple log line for an action on a social host; the desktop appends it to a file. */
export const socialLogLine = (input: {
  readonly at: string;
  readonly host: string;
  readonly tool: string;
  readonly action: string;
  readonly outcome: string;
}): string => JSON.stringify(input);

/**
 * The assistant in his own Chrome (D3). Reading is routine and taints the turn; a submit, send, purchase,
 * delete or settings change asks aloud; money movement is refused. Social sites follow a setting (on, with a
 * plain switch to turn it off), and every action there asks, is rate-limited and is logged.
 */
import { highRiskSubject } from "./intentParser.ts";
import { sensitiveAction } from "./screenCompanion.ts";

export const CHROME_PREFIX = "mcp__claude-in-chrome__";

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

const READ_TOOLS = new Set([
  "read_page",
  "get_page_text",
  "find",
  "tabs_context_mcp",
  "read_console_messages",
  "read_network_requests",
  "resize_window",
  "tabs_context",
]);
const PASSIVE_ACTIONS = new Set([
  "screenshot",
  "scroll",
  "scroll_to",
  "wait",
  "mouse_move",
  "hover",
  "zoom",
  "cursor_position",
]);

export const isChromeTool = (tool: string): boolean => tool.startsWith(CHROME_PREFIX);

/** A chrome call only looks at a page: the turn is tainted by what comes back. */
export const chromeReads = (tool: string, input: Readonly<Record<string, unknown>>): boolean => {
  if (!isChromeTool(tool)) return false;
  const name = tool.slice(CHROME_PREFIX.length);
  return READ_TOOLS.has(name) || (name === "computer" && input["action"] === "screenshot");
};

export interface ChromeContext {
  readonly tainted: boolean;
  /** Social accounts are switched on (default off). */
  readonly socialOn: boolean;
  /** The host the tab was last taken to in this conversation, when known. */
  readonly pageHost: string | null;
  /** Social actions on this host in the last hour. */
  readonly recentSocial: number;
  /** The text is his own words. */
  readonly textIsHis: boolean;
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

export const judgeChrome = (
  tool: string,
  input: Readonly<Record<string, unknown>>,
  ctx: ChromeContext,
): ChromeVerdict => {
  const name = tool.slice(CHROME_PREFIX.length);
  const text = flat(input);
  if (moneyMovement(text)) {
    return { verdict: "deny", why: "Moving money is never done by Tessaya. Do it yourself." };
  }
  const url = typeof input["url"] === "string" ? input["url"] : "";
  if (url !== "" && hostOf(url) === null) {
    return { verdict: "deny", why: "Only web pages (http or https) are opened." };
  }
  const host = hostForCall(input, ctx.pageHost);
  const social = host !== null && isSocialHost(host);
  const mutating =
    !READ_TOOLS.has(name) &&
    !(name === "computer" && PASSIVE_ACTIONS.has(String(input["action"] ?? ""))) &&
    name !== "navigate" &&
    name !== "tabs_create_mcp";
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
      why: `On ${host}: this may post, comment, like, follow, message, share, delete or change a setting. It asks every time.`,
      risky: true,
    };
  }
  if (name === "navigate" || name === "tabs_create_mcp") {
    // A long address can carry what was read out of the page.
    return ctx.tainted && url.length > 200
      ? { verdict: "ask", why: "It follows something it read, in a long address." }
      : { verdict: "allow" };
  }
  if (READ_TOOLS.has(name)) return { verdict: "allow" };
  if (name === "computer" && PASSIVE_ACTIONS.has(String(input["action"] ?? "")))
    return { verdict: "allow" };
  if (name === "javascript_tool" || name === "file_upload" || name === "upload_image") {
    return { verdict: "ask", why: `It wants to use ${name} in your browser.`, risky: true };
  }
  if (name !== "form_input" && name !== "computer") {
    return { verdict: "ask", why: `It wants to use ${name} in your browser.` };
  }
  const subject = highRiskSubject(text);
  if (subject !== null || SHOPPING.test(text)) {
    return {
      verdict: "ask",
      why: `This is ${subject ?? "a purchase, order or settings change"}.`,
      risky: true,
    };
  }
  if (sensitiveAction(text) || /\b(enter|return)\b/i.test(String(input["text"] ?? ""))) {
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

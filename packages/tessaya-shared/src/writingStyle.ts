/**
 * Style by app category (Wispr parity): messages to friends, work messages, email and everything
 * else each get their own formality. Pure and deterministic, so it needs no model and cannot change
 * what was said: it only changes capitals and the closing mark.
 */
export const STYLE_CATEGORIES = ["personal", "work", "email", "other"] as const;
export type StyleCategory = (typeof STYLE_CATEGORIES)[number];

export const STYLES = ["default", "formal", "casual", "very-casual", "excited"] as const;
export type WritingStyle = (typeof STYLES)[number];

export const CATEGORY_LABELS: Readonly<Record<StyleCategory, string>> = {
  personal: "Personal messages",
  work: "Work messages",
  email: "Email",
  other: "Everything else",
};

export const STYLE_LABELS: Readonly<Record<WritingStyle, string>> = {
  default: "As Tessaya writes it",
  formal: "Formal",
  casual: "Casual",
  "very-casual": "Very casual",
  excited: "Excited",
};

export const STYLE_EXAMPLES: Readonly<Record<WritingStyle, string>> = {
  default: "Hey, are you free for lunch tomorrow?",
  formal: "Hello, are you available for lunch tomorrow?",
  casual: "Hey, are you free for lunch tomorrow",
  "very-casual": "hey are you free for lunch tomorrow",
  excited: "Hey, are you free for lunch tomorrow!",
};

const PERSONAL_APP =
  /^(whatsapp|telegram|signal|messenger|imessage|discord|instagram|facebook|snapchat|wechat|line|viber)/;
const WORK_APP =
  /^(slack|teams|ms-teams|msteams|zoom|linear|jira|asana|trello|webex|mattermost|basecamp)/;
const EMAIL_APP =
  /^(outlook|olk|thunderbird|mailspring|spark|mail|hxoutlook|em client|eudora|superhuman)/;
const PERSONAL_TITLE = /\b(WhatsApp|Telegram|Messenger|Discord|Instagram|Signal|Snapchat)\b/i;
const WORK_TITLE = /\b(Slack|Microsoft Teams|Linear|Jira|Asana|Trello)\b/i;
const EMAIL_TITLE = /\b(Gmail|Outlook|Proton Mail|Superhuman|Yahoo Mail|Fastmail|Inbox)\b/i;

/** Which of his four kinds of writing this window is. A browser says by its title. */
export const categoryForApp = (app: {
  readonly exe: string;
  readonly title: string;
}): StyleCategory => {
  const exe = app.exe.toLowerCase().replace(/\.(exe|app)$/, "");
  if (EMAIL_APP.test(exe)) return "email";
  if (PERSONAL_APP.test(exe)) return "personal";
  if (WORK_APP.test(exe)) return "work";
  if (EMAIL_TITLE.test(app.title)) return "email";
  if (PERSONAL_TITLE.test(app.title)) return "personal";
  if (WORK_TITLE.test(app.title)) return "work";
  return "other";
};

/** Words that stay capitalised even in very casual writing: I, I'm, and short all-caps words. */
const KEEP = /^(I|I'm|I'll|I've|I'd)$|^[A-Z]{2,5}$/;

const lowerFirstWords = (text: string): string =>
  text
    .split(/(\s+)/)
    .map((w, i) => (i % 2 === 1 || KEEP.test(w.replace(/[^A-Za-z']/g, "")) ? w : w.toLowerCase()))
    .join("");

/** A single message: no multi-line text, no code. Longer writing is left in its full form. */
const isShortMessage = (text: string): boolean => !text.includes("\n") && text.length <= 280;

export const applyStyle = (text: string, style: WritingStyle): string => {
  if (style === "default" || style === "formal" || text.trim() === "" || !isShortMessage(text))
    return text;
  const trimmed = text.trimEnd();
  const tail = text.slice(trimmed.length);
  const dropFinalStop = (s: string) => s.replace(/\.+$/, "");
  switch (style) {
    case "casual":
      return dropFinalStop(trimmed) + tail;
    case "very-casual":
      return lowerFirstWords(dropFinalStop(trimmed)) + tail;
    case "excited":
      return (/[!?]$/.test(trimmed) ? trimmed : `${dropFinalStop(trimmed)}!`) + tail;
  }
};

export type StyleChoices = Readonly<Record<StyleCategory, WritingStyle>>;
export const DEFAULT_STYLES: StyleChoices = {
  personal: "default",
  work: "default",
  email: "default",
  other: "default",
};

/** The Auto cleanup levels Wispr names, over Tessaya's own settings. */
export const CLEANUP_LEVELS = ["none", "light", "medium"] as const;
export type CleanupChoice = (typeof CLEANUP_LEVELS)[number];
export const cleanupChoiceOf = (setting: "off" | "local" | "claude"): CleanupChoice =>
  setting === "off" ? "none" : setting === "local" ? "light" : "medium";
export const cleanupSettingOf = (choice: CleanupChoice): "off" | "local" | "claude" =>
  choice === "none" ? "off" : choice === "light" ? "local" : "claude";

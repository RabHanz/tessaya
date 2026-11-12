/**
 * The pages of Baton's window (D140), the categories of its Settings window, and where each control lives. Producers keep their own
 * ids; this one table decides where they appear, so moving a control is a one-line change.
 */
export const TABS = [
  { id: "home", label: "Home" },
  { id: "now", label: "Now" },
  { id: "snippets", label: "Snippets" },
  { id: "insights", label: "Insights" },
  { id: "scratchpad", label: "Scratchpad" },
  { id: "style", label: "Style" },
  { id: "transforms", label: "Transforms" },
  { id: "sessions", label: "Sessions" },
  { id: "approvals", label: "Approvals" },
  { id: "jobs", label: "Jobs" },
  { id: "cloud", label: "Cloud" },
  { id: "dictation", label: "Dictation" },
  { id: "history", label: "History" },
  { id: "memory", label: "Memory" },
  { id: "vault", label: "Vault" },
  { id: "tools", label: "Skills" },
  { id: "usage", label: "Usage" },
  { id: "trust", label: "Trust" },
  { id: "help", label: "Help" },
] as const;

/** Settings has one home: the Settings window, in these categories. Every setting lives in exactly one of them. */
export const SETTINGS = [
  { id: "general", label: "General" },
  { id: "voice", label: "Voice and wake words" },
  { id: "personas", label: "Personas and voices" },
  { id: "assistant", label: "Working for you" },
  { id: "privacy", label: "Memory and privacy" },
  { id: "appearance", label: "Appearance" },
  { id: "keys", label: "Keyboard and mouse" },
  { id: "advanced", label: "Advanced" },
  { id: "about", label: "About" },
] as const;

export type TabId = (typeof TABS)[number]["id"] | (typeof SETTINGS)[number]["id"] | "setup";

const EXACT: Readonly<Record<string, TabId>> = {
  "v.enabled": "voice",
  "v.muted": "voice",
  "v.mic": "voice",
  "v.direct": "voice",
  "v.listenAfterWake": "voice",
  "v.conversation": "voice",
  "v.waitMs": "voice",
  "v.verifyWake": "voice",
  "v.quietSpeech": "voice",
  "v.headphones": "voice",
  "v.voiceBargeIn": "voice",
  "v.silence": "voice",
  "s.output": "voice",
  "s.volume": "voice",
  "v.cues": "voice",
  "v.holdKeyCues": "voice",
  "v.frosted": "voice",
  "v.pillPlace": "voice",
  "v.pillMove": "voice",
  "v.pillRest": "voice",
  "v.pillHide": "voice",
  "v.pillFull": "voice",
  "v.volume": "voice",
  "s.voice": "personas",
  "v.audition": "setup",
  "v.dictation": "dictation",
  "v.download": "dictation",
  "v.cleanup": "dictation",
  "v.appMode": "dictation",
  "v.speechModel": "dictation",
  "v.speechModelOffer": "dictation",
  "v.recognition": "dictation",
  "v.cloudProvider": "dictation",
  "v.cloudKey": "dictation",
  "v.cloudModel": "dictation",
  "v.cloudTest": "dictation",
  "v.copyLast": "dictation",
  "v.learnWords": "dictation",
  "v.showWords": "dictation",
  "v.pillStyle": "dictation",
  "v.doubleTap": "dictation",
  "v.language": "dictation",
  "v.duck": "dictation",
  "d.import": "dictation",
  "s.brain": "assistant",
  "s.brainCheck": "assistant",
  "s.account": "assistant",
  "s.accountEmail": "assistant",
  "s.act": "assistant",
  "s.capture": "assistant",
  "s.chrome": "assistant",
  "s.chromeCheck": "assistant",
  "s.social": "assistant",
  "s.cursor": "assistant",
  "s.hands": "assistant",
  "s.handsAway": "assistant",
  "pr.initiative": "assistant",
  "pr.perHour": "assistant",
  "pr.needsRepos": "assistant",
  "pr.ciRepos": "assistant",
  "pr.feeds": "assistant",
  "pr.expect": "assistant",
  "pr.deadlines": "assistant",
  "v.keepVoice": "privacy",
  "v.keepDays": "privacy",
  "v.keepCap": "privacy",
  "v.keepSpace": "privacy",
  "v.hideFromCapture": "privacy",
  "pr.awWindow": "privacy",
  "pr.awIdle": "privacy",
  "pr.awFocus": "privacy",
  "pr.awJobs": "privacy",
  "v.login": "general",
  "v.startHome": "general",
  "v.startSessions": "general",
  "v.notice": "general",
  "v.dnd": "general",
  "v.snooze": "general",
  "v.quiet": "general",
  "v.brief": "general",
  "v.appearance": "appearance",
  "v.palette": "appearance",
  "v.pillDesign": "appearance",
  "v.pillWaveform": "appearance",
  "v.mascot": "appearance",
  "v.mascotMotion": "appearance",
  "v.mascotPersona": "appearance",
  "v.mascotSize": "appearance",
  "v.pillFace": "appearance",
  "v.motion": "appearance",
  "v.glass": "appearance",
  "v.check": "advanced",
  "v.diag": "advanced",
  "v.micTest": "advanced",
  "v.file": "advanced",
  "setup.hold": "setup",
};

export const tabOf = (id: string): TabId => {
  const exact = EXACT[id];
  if (exact !== undefined) return exact;
  if (id.startsWith("v.wake:")) return "voice";
  if (id.startsWith("v.persona:")) return "personas";
  if (id.startsWith("v.result:")) return "advanced";
  if (id.startsWith("rs.")) return "privacy";
  if (id.startsWith("setup.cloud.")) return "cloud";
  if (id.startsWith("n:") || id.startsWith("c:") || id.startsWith("c.")) return "sessions";
  if (/^now[:.]/.test(id)) return "now";
  if (/^cl\.(p|a|ok|deny|head|busy|done|denied|fail)\./.test(id)) return "approvals";
  if (/^cl[:.]/.test(id)) return "cloud";
  if (/^trust[:.]/.test(id)) return "trust";
  if (/^help[:.]/.test(id)) return "help";
  if (/^bk[:.]/.test(id)) return "history";
  if (/^vid[:.]/.test(id)) return "voice";
  if (/^sn[:.]/.test(id)) return "snippets";
  if (/^tr[:.]/.test(id)) return "transforms";
  if (/^st[:.]/.test(id)) return "style";
  if (/^in[:.]/.test(id)) return "insights";
  if (/^sc[:.]/.test(id) || /^tf[:.]/.test(id)) return "scratchpad";
  if (/^j[a-z]?[:.]/.test(id)) return "jobs";
  if (/^a[:.]/.test(id)) return "approvals";
  if (/^k[:.]/.test(id)) return "tools";
  if (/^p[:.]/.test(id)) return "memory";
  if (id.startsWith("vt:") || id.startsWith("vt.")) return "vault";
  if (id === "s.learn" || id.startsWith("s.learned:")) return "memory";
  if (id.startsWith("m:") || id.startsWith("m.")) return "memory";
  if (id.startsWith("u.")) return "general";
  // Anything new and unplaced is still reachable, never drawn nowhere.
  return "advanced";
};

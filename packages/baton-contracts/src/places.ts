/**
 * Where every setting lives across the two windows. Tessaya's window holds everything of hers; T3's window keeps
 * agents, code and connections. Both windows search both lists, and `tessaya://<id>` opens a Tessaya place.
 */
export const TESSAYA_SETTINGS_GROUPS = [
  "You",
  "Talking to Tessaya",
  "Home and devices",
  "Working for you",
  "App",
] as const;

export const TESSAYA_PLACES = [
  {
    id: "accounts",
    label: "Accounts",
    group: "You",
    terms: ["account", "subscription", "claude", "codex", "plan", "sign in", "email"],
  },
  {
    id: "personas",
    label: "Personas and voices",
    group: "You",
    terms: ["persona", "voice", "voice library", "speaks", "tts", "speech"],
  },
  {
    id: "privacy",
    label: "Memory and privacy",
    group: "You",
    terms: ["memory", "privacy", "recordings", "keep", "screen capture", "activity"],
  },
  {
    id: "voice",
    label: "Voice and wake words",
    group: "Talking to Tessaya",
    terms: ["wake word", "microphone", "mic", "listening", "pill", "speaker", "volume"],
  },
  {
    id: "dictation",
    label: "Dictation and cleanup",
    group: "Talking to Tessaya",
    terms: ["dictate", "cleanup", "clean up", "speech model", "transcription", "language", "words"],
  },
  {
    id: "hardware",
    label: "Hardware",
    group: "Home and devices",
    terms: ["r1", "rabbit", "device", "nfc", "tags", "room brain", "bluetooth", "earcons"],
  },
  {
    id: "homeassistant",
    label: "Home Assistant",
    group: "Home and devices",
    terms: ["home", "lights", "rooms", "smart home", "switches"],
  },
  {
    id: "phone",
    label: "Phone",
    group: "Home and devices",
    terms: ["mobile", "iphone", "android", "pair", "app"],
  },
  {
    id: "assistant",
    label: "Working for you",
    group: "Working for you",
    terms: ["brain", "model", "hands", "chrome", "screen", "routines", "proactive", "deadlines"],
  },
  {
    id: "apis",
    label: "APIs and keys",
    group: "Working for you",
    terms: ["api", "anthropic", "key", "api key"],
  },
  {
    id: "general",
    label: "General",
    group: "App",
    terms: ["start", "login", "notifications", "do not disturb", "quiet hours", "snooze"],
  },
  {
    id: "appearance",
    label: "Appearance",
    group: "App",
    terms: ["theme", "dark", "light", "palette", "motion"],
  },
  {
    id: "keys",
    label: "Keyboard and mouse",
    group: "App",
    terms: ["shortcut", "hotkey", "hold key", "mouse button"],
  },
  {
    id: "advanced",
    label: "Advanced",
    group: "App",
    terms: ["diagnostics", "checks", "logs", "files"],
  },
  { id: "about", label: "About", group: "App", terms: ["version", "update", "licence"] },
] as const satisfies ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly group: (typeof TESSAYA_SETTINGS_GROUPS)[number];
  readonly terms: ReadonlyArray<string>;
}>;

export type TessayaPlaceId = (typeof TESSAYA_PLACES)[number]["id"];

const PLACE_IDS = new Set<string>(TESSAYA_PLACES.map((place) => place.id));

/** `tessaya://settings/hardware`, `tessaya://hardware` or `hardware` names a place; anything else is null. */
export function tessayaPlaceOf(link: string): TessayaPlaceId | null {
  const id = link
    .trim()
    .replace(/^tessaya:\/\//i, "")
    .replace(/^settings\//i, "")
    .replace(/[/?#].*$/, "")
    .toLowerCase();
  return PLACE_IDS.has(id) ? (id as TessayaPlaceId) : null;
}

export const tessayaLink = (id: TessayaPlaceId): string => `tessaya://settings/${id}`;

/** T3's settings pages, for Tessaya's search. Each path is T3's own route. */
export const T3_SETTINGS_PLACES = [
  { path: "/settings/providers", label: "Agent accounts & providers", terms: ["codex", "claude"] },
  { path: "/settings/threads", label: "Threads", terms: ["archive", "settle"] },
  { path: "/settings/chat", label: "Chat", terms: ["composer", "send"] },
  { path: "/settings/voice", label: "Chat box microphone", terms: ["composer", "dictation"] },
  { path: "/settings/diffs", label: "Diffs & pull requests", terms: ["diff", "review"] },
  { path: "/settings/browser", label: "Agent browser", terms: ["browser"] },
  { path: "/settings/devices", label: "Simulators for agents", terms: ["simulator", "ios"] },
  { path: "/settings/scheduled-tasks", label: "Scheduled tasks", terms: ["cron", "schedule"] },
  { path: "/settings/projects", label: "Projects", terms: ["project", "folder"] },
  { path: "/settings/source-control", label: "Source control", terms: ["git", "github"] },
  { path: "/settings/worktrees", label: "Worktrees", terms: ["branch", "worktree"] },
  { path: "/settings/connections", label: "Environments", terms: ["tailscale", "machine"] },
  { path: "/settings/access", label: "Sharing & access", terms: ["pair", "guest", "link"] },
  { path: "/settings/secrets", label: "Agent secrets", terms: ["secret", "env"] },
  { path: "/settings/keybindings", label: "T3 keybindings", terms: ["shortcut"] },
  { path: "/settings/maintenance", label: "Maintenance", terms: ["storage", "cleanup"] },
] as const;

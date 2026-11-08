// @effect-diagnostics globalDate:off
import { catalogControls, INITIAL_VIEW } from "../../sessions/catalogRows.ts";
import { sampleCatalogRows } from "../../sessions/sampleCatalog.ts";
import type { HomeControl, HomeExtra } from "../../home/batonHome.ts";
import { tabOf } from "../../home/tabs.ts";
import { STATES } from "../../home/pageStates.ts";

/** A full, plausible Home state for design frames: every page has something to draw, and Sessions can show the New session sheet. */
const NOW = Date.now();
const t = (id: string, section: string, label: string, hint: string, on: boolean): HomeControl => ({
  id,
  section,
  label,
  hint,
  kind: "toggle",
  on,
});
const c = (
  id: string,
  section: string,
  label: string,
  hint: string,
  value: string,
  options: ReadonlyArray<string>,
): HomeControl => ({
  id,
  section,
  label,
  hint,
  kind: "choice",
  value,
  options: options.map((o) => ({ value: o.toLowerCase(), label: o })),
});
const a = (
  id: string,
  section: string,
  label: string,
  hint: string,
  button: string,
): HomeControl => ({ id, section, label, hint, kind: "action", button });
const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();

export const proofExtra: HomeExtra = {
  wakeWords: ["Sebastian", "Alfred"],
  activity: [
    { at: ago(6), kind: "heard", text: "Open the sessions page and resume the launch post." },
    { at: ago(21), kind: "dictated", text: "Dictated 214 characters" },
    { at: ago(48), kind: "action", text: "Opened Sessions" },
    { at: ago(95), kind: "quiet", text: "Heard the wake word, then nothing.", dim: true },
    { at: ago(140), kind: "stopped", text: "You said stop." },
  ],
  stats: { turns: 18, dictations: 42, sessions: 3, needYou: 1 },
  insights: {
    wordsToday: 1860,
    wpm: 142,
    streak: 11,
    topApps: [
      { app: "Code", count: 14 },
      { app: "Slack", count: 9 },
    ],
  },
  vocabulary: [],
  hotkeys: [],
  usage: [],
  bindings: [],
  bindingsNote: null,
  mouseReady: false,
  lifecycle: [],
  paths: [],
  about: { version: "0.1.99", source: "github.com/RabHanz/tessaya", licence: "MIT", notices: "" },
} as unknown as HomeExtra;

const extras: ReadonlyArray<HomeControl> = [
  t(
    "v.enabled",
    "Listening",
    "Listen for the wake word",
    "Say a wake word and Tessaya answers.",
    true,
  ),
  t("v.muted", "Listening", "Mute the microphone", "Nothing is heard until you unmute.", false),
  c("v.mic", "Listening", "Microphone", "The one Tessaya listens to.", "default", [
    "Default",
    "Headset",
    "Webcam",
  ]),
  t("v.cues", "Cues", "Sounds and cues", "A soft sound when it wakes and when it finishes.", true),
  c("v.pillPlace", "Cues", "Where the pill sits", "On the display your pointer is on.", "bottom", [
    "Bottom",
    "Top",
  ]),
  t("v.dictation", "Dictation", "Hold a key to dictate", "Words land in the app you are in.", true),
  a(
    "v.download",
    "Dictation",
    "Speech model",
    "A better model reads you more exactly.",
    "Download",
  ),
  t(
    "v.appearanceDemo",
    "Windows",
    "Keep Tessaya in the tray",
    "Close the window and it keeps listening.",
    true,
  ),
];

export const proofState = (opts: { creating: boolean }) => {
  const base = STATES["empty"]!;
  const sessions = catalogControls({
    rows: sampleCatalogRows(NOW),
    view: { ...INITIAL_VIEW, creating: opts.creating, newMachine: "server" },
    now: NOW,
    folders: ["/srv/baton", "/srv/digest-bot"],
    status: "",
    loaded: true,
  });
  const keep = base.controls.filter((x) => tabOf(x.id) !== "sessions");
  const controls = [...sessions, ...keep, ...extras].map((x) => ({ ...x, tab: tabOf(x.id) }));
  return {
    status: { label: "Listening", tone: "good", device: "Headset", mark: "", brandMark: "" },
    controls,
    extra: proofExtra,
  };
};

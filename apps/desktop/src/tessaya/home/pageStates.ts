/**
 * Every tab and dialog of the window, drawn from each state a page can be in (loading, empty, error,
 * offline, a missing permission, a half-filled state), with controls made by the real row builders.
 * Returns what a person would see that no person should: 'undefined', 'NaN', '[object Object]', a raw
 * stack or error code.
 */
import { capabilities } from "@t3tools/tessaya-shared/degraded";

import { approvalControls } from "../sessions/approvalRows.ts";
import { helpControls } from "../help/helpRows.ts";
import { jobControls } from "../sessions/jobRows.ts";
import { backupControls } from "../backup/backupRows.ts";
import { EMPTY_NOW, nowControls } from "../presence/nowRows.ts";
import { trustControls, type TrustData } from "../trust/trustRows.ts";
import { cloudPageControls, approvalCardControls } from "../cloud/cloudRows.ts";
import { DEFAULT_CLOUD, type CloudView } from "../cloud/cloudService.ts";
import { harnessControls } from "../harness/harnessRows.ts";
import { insightControls } from "../writing/insightRows.ts";
import { scratchControls } from "../writing/scratchRows.ts";
import { snippetControls } from "../writing/snippetRows.ts";
import { catalogControls, INITIAL_VIEW } from "../sessions/catalogRows.ts";
import { sampleCatalogRows } from "../sessions/sampleCatalog.ts";
import type { HomeControl } from "./tessayaHome.ts";
import { openWindowPage } from "./fakeDom.ts";
import { TABS, tabOf } from "./tabs.ts";
import { APP_SCRIPT } from "./appScript.ts";

const EMPTY_TRUST: TrustData = {
  screenAlways: false,
  chrome: false,
  social: false,
  act: false,
  remote: false,
  vault: "none",
  grants: [],
  standing: [],
  entries: [],
  filter: "all",
};

const CLOUD_VIEW: CloudView = {
  on: true,
  transport: "local",
  providers: [],
  choices: [],
  requests: [],
  usage: [],
  detections: {},
  error: null,
  loadedAt: null,
  cards: new Map(),
  environments: [],
  tested: null,
};

const status = { label: "Listening", tone: "good", device: "", mark: "" };
const NOW = 1_800_000_000_000;

const check = (id: string, bad: boolean): HomeControl => ({
  id,
  section: "Check",
  label: "Microphone",
  kind: "check",
  status: bad ? "bad" : "warn",
  detail: "No microphone was found.",
  fix: "Plug one in.",
});

export const STATES: Readonly<
  Record<string, { controls: ReadonlyArray<HomeControl>; extra?: object }>
> = {
  loading: {
    controls: [
      ...nowControls(EMPTY_NOW, NOW),
      ...approvalControls([], "loading"),
      ...trustControls(EMPTY_TRUST, NOW),
    ],
  },
  empty: {
    controls: [
      ...catalogControls({
        rows: sampleCatalogRows(NOW),
        view: { ...INITIAL_VIEW, creating: true, newMachine: "server" },
        now: NOW,
        folders: ["/srv/baton"],
        status: "",
        loaded: true,
      }),
      ...nowControls({ ...EMPTY_NOW, loaded: true }, NOW),
      ...approvalControls([], "ready"),
      ...jobControls([]),
      ...snippetControls([], ""),
      ...scratchControls([], "", false),
      ...insightControls(null),
      ...harnessControls([]),
      ...trustControls(EMPTY_TRUST, NOW),
      ...helpControls({ tools: [], bindings: [], checks: [] }),
      ...backupControls(null, null),
      ...cloudPageControls(CLOUD_VIEW, DEFAULT_CLOUD),
      ...cloudPageControls(CLOUD_VIEW, { ...DEFAULT_CLOUD, on: true }),
      ...approvalCardControls(CLOUD_VIEW),
    ],
  },
  error: {
    controls: [
      ...approvalControls([], { error: "The server did not answer." }),
      check("v.result:mic", true),
      ...helpControls({
        tools: [],
        bindings: [],
        checks: [
          { id: "mic", title: "Microphone", status: "bad", detail: "No microphone was found." },
        ],
      }),
      ...backupControls(null, "That is not a zip file."),
      ...cloudPageControls(
        { ...CLOUD_VIEW, error: "The computer that runs cloud tasks did not answer." },
        { ...DEFAULT_CLOUD, on: true, transport: "ssh" },
      ),
    ],
  },
  offline: {
    controls: [
      ...nowControls(
        {
          ...EMPTY_NOW,
          loaded: true,
          capabilities: capabilities({
            network: false,
            claude: false,
            speechModel: false,
            server: false,
          }),
        },
        NOW,
      ),
      check("v.result:signin", false),
    ],
  },
  "permission missing": {
    controls: [
      ...trustControls({ ...EMPTY_TRUST, vault: "locked" }, NOW),
      check("v.result:screen", false),
    ],
  },
  "half-filled": { controls: [], extra: {} },
  "no controls at all": { controls: [] },
};

export const BAD =
  /\bundefined\b|\bNaN\b|\[object Object\]|\bnull\b|\bat .+\(.+:\d+:\d+\)|\b(?:TypeError|ReferenceError|SyntaxError|ECONNREFUSED|ENOENT|EACCES)\b/;

const MODALS = ["general", "system", "keys", "account", "updates", "about", "setup"];

/** The window's page script opened on one of the states above, for tests that look at one page. */
export const openState = (name: string) => {
  const state = STATES[name]!;
  return openWindowPage(APP_SCRIPT, {
    status,
    ...state,
    controls: state.controls.map((c) => ({ ...c, tab: tabOf(c.id) })),
  });
};

/** One line per offending page and state; empty when every page is clean. */
export const sweepPages = async (): Promise<ReadonlyArray<string>> => {
  const found: string[] = [];
  for (const [name, state] of Object.entries(STATES)) {
    const page = await openWindowPage(APP_SCRIPT, {
      status,
      ...state,
      controls: state.controls.map((c) => ({ ...c, tab: tabOf(c.id) })),
    });
    for (const e of page.errors)
      found.push(`${name}: the page failed: ${e.split("\n").slice(0, 4).join(" | ")}`);
    const seen: Array<[string, string]> = [
      ["side", page.textOf("side")],
      ["top", page.textOf("top")],
    ];
    for (const { id } of TABS) seen.push([`tab ${id}`, page.show(id)]);
    for (const m of MODALS) {
      seen.push([`dialog ${m}`, page.openModal(m)]);
      page.closeModal();
    }
    for (const [where, text] of seen) {
      const hit = BAD.exec(text);
      if (hit !== null)
        found.push(
          `${name}, ${where}: shows "${hit[0]}" in "${text.slice(Math.max(0, hit.index - 40), hit.index + 40)}"`,
        );
    }
    for (const e of page.errors)
      if (!found.some((f) => f.includes(e.split("\n").slice(0, 4).join(" | ")!)))
        found.push(`${name}: ${e.split("\n").slice(0, 4).join(" | ")}`);
  }
  return found;
};

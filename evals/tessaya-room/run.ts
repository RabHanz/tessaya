#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalConsole:off
/**
 * The R1 desk device's turn as it ships, on a fake house: the room's real prompt and data, and either brain.
 * `--brain tools` is the key route (ROOM_SYSTEM, the room's real tool specs on an MCP server); `--brain acts` is the
 * acts form the subscription route still speaks (R1_STREAM_SYSTEM, no tools; the key route spoke it too before tools).
 * Both run on a real `claude -p` on your own login. Tools answer from a fake house and canned reads; nothing real runs.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";

import { startTessayaMcp } from "../../apps/desktop/src/tessaya/agent/tessayaMcp.ts";
import { toolUsesOf } from "../../apps/desktop/src/tessaya/screen/claudeVision.ts";
import {
  calledPersona,
  HOUSE_LOOK,
  LOOK,
  R1_STREAM_SYSTEM,
  r1Data,
  ROOM_SYSTEM,
  roomData,
  splitActs,
  spokenReply,
  withoutNarration,
  withoutSelfIntros,
  type R1Context,
} from "../../apps/server/src/home/R1Device.ts";
import type { ActOutcome } from "../../apps/server/src/tessaya/TessayaBrain.ts";
import { handOffLine, hereLine, voiceLine } from "../../apps/server/src/tessaya/TessayaTurn.ts";
import { TurnOrigin } from "../../apps/server/src/tessaya/TurnOrigin.ts";
import { offlineWhy } from "../../apps/server/src/home/DeviceRegistry.ts";
import { volumeAfter, volumeLine } from "../../packages/tessaya-shared/src/speakingVolume.ts";
import { CONVERSATION_END } from "../../packages/tessaya-shared/src/stopPhrases.ts";
import { ROOM_TOOL_SPECS } from "../../apps/server/src/home/R1Tools.ts";
import { clockLine } from "../../packages/tessaya-shared/src/brain.ts";
import { talkingLine } from "../../packages/tessaya-shared/src/sessionInsight.ts";
import { toneOf } from "../../packages/tessaya-shared/src/expressionMap.ts";
import { DEFAULT_OS_PACK, rosterLine } from "../../packages/tessaya-shared/src/osPack.ts";
import { ownerDoc, ownerLine } from "../../packages/tessaya-shared/src/ownerProfile.ts";
import { diagnose } from "../../packages/tessaya-shared/src/health.ts";
import { reportLine } from "../../packages/tessaya-shared/src/problemReport.ts";
import { HEALTHY, OWNER, ROOM_NOW, roomCases, type RoomCase } from "./cases.ts";
import { casePasses, failureOf, type RoomSample } from "./grade.ts";
import { answerOf, retried } from "../shared/retry.ts";
import { judge, meanScores } from "./judge.ts";

/** The soul that answers the case (the persona he calls, else none: the lead), for the judge's words. */
const soulOf = (c: RoomCase) =>
  c.persona === undefined ? undefined : DEFAULT_OS_PACK.personas.find((p) => p.id === c.persona);

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    model: { type: "string", default: "haiku" },
    brain: { type: "string", default: "tools" },
    case: { type: "string", multiple: true },
    samples: { type: "string", default: "2" },
    claude: { type: "string", default: "claude" },
    "judge-model": { type: "string", default: "sonnet" },
  },
});
if (values.out === undefined) throw new Error("Use --out <directory>.");
if (values.brain !== "tools" && values.brain !== "acts") throw new Error("--brain tools|acts");
const out = values.out;
const cases = roomCases.filter((c) => values.case === undefined || values.case.includes(c.id));
const PREFIX = "mcp__room__";
const PICTURE = NodeFS.readFileSync(
  NodePath.join(import.meta.dirname, "fixtures", "red-circle.jpg"),
).toString("base64");

/** A small house: the study lamp (off), the study fan (on), the front door lock. Risky acts go to his phone. */
const makeHouse = () => {
  const states = new Map([
    ["light.study_lamp", { name: "Study lamp", area: "Study", state: "off" }],
    ["fan.study", { name: "Study fan", area: "Study", state: "on" }],
    ["lock.front", { name: "Front door", area: "Hall", state: "locked" }],
  ]);
  let last: { entities: ReadonlyArray<string>; undoId: string; line: string } | null = null;
  let undo: Map<string, string> = new Map();
  const view = (id: string) => ({ entityId: id, ...states.get(id)! });
  const find = (words: string) =>
    [...states.keys()]
      .filter((id) =>
        words
          .toLowerCase()
          .split(/\W+/)
          .filter((w) => w.length > 2)
          .some((w) => `${id} ${states.get(id)!.name}`.toLowerCase().includes(w)),
      )
      .map(view);
  const act = (args: Record<string, unknown>) => {
    const target = (args["target"] ?? {}) as { entity_id?: unknown };
    const ids = [target.entity_id]
      .flat()
      .map(String)
      .filter((id) => states.has(id));
    if (ids.length === 0) return { ok: false, error: "No such device." };
    if (args["domain"] === "lock")
      return {
        ok: true,
        value: {
          status: "asked",
          line: "Sent to his phone for a yes; nothing happens until he says yes.",
        },
      };
    const to = String(args["service"]).endsWith("_off") ? "off" : "on";
    undo = new Map(ids.map((id) => [id, states.get(id)!.state]));
    for (const id of ids) states.get(id)!.state = to;
    const line = `${ids.map((id) => states.get(id)!.name).join(", ")} turned ${to}`;
    last = { entities: ids, undoId: "u1", line };
    return { ok: true, value: { status: "done", line, undoId: "u1" } };
  };
  return {
    lamp: () => states.get("light.study_lamp")!.state as "on" | "off",
    last: () => last,
    find,
    state: (id: string) => (states.has(id) ? view(id) : null),
    act,
    undo: () => {
      for (const [id, s] of undo) states.get(id)!.state = s;
      return { ok: true, value: { status: "done", line: "Undone." } };
    },
  };
};

/** What his work reads return: canned, from a made-up project. */
const WORK = {
  // Two notes from Sara, as comms_inbox answers when messages waited for him (the comms-waiting case).
  comms_inbox: {
    status: "done",
    line: "2 messages.",
    notes: [
      {
        id: "note-1",
        kind: "text",
        fromLabel: "Sara",
        text: "Running late, back by eight",
        forms: { glance: { emoji: "⏰", words: "Running late" } },
        private: false,
        createdAt: "2026-11-12T04:50:00.000Z",
      },
      {
        id: "note-2",
        kind: "voice",
        fromLabel: "Sara",
        text: "Can you get milk on the way",
        forms: { glance: { emoji: "🥛", words: "Get milk" } },
        private: false,
        createdAt: "2026-11-12T05:01:00.000Z",
      },
    ],
  },
  tessaya_in_flight: {
    turns: [{ session: "acme/app", title: "checkout refactor", agent: "Codex", minutes: 14 }],
  },
  // Shaped as TessayaWorkNowResult: his work on three machines, more than the top few.
  tessaya_work_now: {
    total: 7,
    waiting: 1,
    working: 4,
    recent: 2,
    machines: ["studio", "laptop", "home"],
    top: [
      {
        session: "checkout refactor",
        project: "acme/app",
        on: "studio",
        state: "waiting",
        minutesAgo: 3,
      },
      { session: "deploy check", project: "shop", on: "home", state: "working", minutesAgo: 1 },
      { session: "landing page", project: "site", on: "laptop", state: "working", minutesAgo: 6 },
      { session: "test fixes", project: "acme/app", on: "studio", state: "working", minutesAgo: 9 },
      { session: "billing bug", project: "shop", on: "home", state: "working", minutesAgo: 12 },
    ],
    more: 2,
    unreachable: [],
  },
  // Shaped as TessayaTeamBoardResult, from the default pack's roles.
  tessaya_team_board: {
    members: DEFAULT_OS_PACK.personas.map((p) => ({
      id: p.id,
      name: p.name,
      role: p.role.split(";")[0]!.trim(),
      duties: p.role,
      private: false,
      busy: p.id === "engineering",
      jobs: p.id === "engineering" ? [{ id: "job-acme-1", title: "checkout refactor" }] : [],
      episode: null,
      recent: [],
      templates: [],
      track: {
        led: p.id === "engineering" ? 6 : 2,
        done: p.id === "engineering" ? 5 : 2,
        failed: 0,
      },
      moves: [],
    })),
  },
  tessaya_sessions: { sessions: [{ title: "checkout refactor", folder: "/home/user/acme/app" }] },
  // Shaped as BrainUsageResult: cleanup on the API key, talking on the plan, one alert.
  tessaya_usage_report: {
    totals: [
      {
        day: "2026-11-12",
        role: "cleanup",
        credential: "apiKey:anthropic",
        model: "claude-haiku-5-5",
        calls: 310,
        input: 41000,
        cacheRead: 920000,
        cacheWrite: 3100,
        output: 9800,
        dollars: 0.19,
      },
      {
        day: "2026-11-13",
        role: "cleanup",
        credential: "apiKey:anthropic",
        model: "claude-haiku-5-5",
        calls: 402,
        input: 52000,
        cacheRead: 1190000,
        cacheWrite: 3100,
        output: 12100,
        dollars: 0.23,
      },
      {
        day: "2026-11-13",
        role: "voice",
        credential: "subscription",
        model: "claude-sonnet-5-5",
        calls: 88,
        input: 2100,
        cacheRead: 1200000,
        cacheWrite: 61000,
        output: 9100,
        dollars: null,
      },
    ],
    limits: [{ scope: "all", period: "day", limit: 1, spent: 0.23, reached: false }],
  },
  tessaya_jobs: {
    jobs: [
      {
        workSessionId: "job-acme-1",
        title: "checkout refactor",
        project: "acme/app",
        phase: "awaiting_agreement",
        group: "needs_you",
      },
      {
        workSessionId: "job-acme-3",
        title: "dependency update",
        project: "acme/app",
        phase: "approved",
        group: "done",
      },
      // Onyx leads these (the referral cases).
      ...[
        ["job-dinner-1", "Mum's birthday dinner", "home"],
        ["job-checkout-bug", "fix the checkout bug", "acme/app"],
        ["job-vat-1", "file the quarterly VAT return", "home"],
      ].map(([workSessionId, title, project]) => ({
        workSessionId,
        title,
        project,
        phase: "approved",
        group: "running",
        terms: { lead: "engineering" },
      })),
    ],
  },
  // Nova wakes her on v2 (v1 kept); Maya's v1 missed the bar and v2 is training; Freya ships trained.
  tessaya_wake_words: {
    words: [
      {
        personaId: "companion",
        word: "freya",
        model: "trained",
        shipped: true,
        current: null,
        cancelled: false,
        versions: [],
      },
      {
        personaId: "nova",
        word: "nova",
        model: "trained",
        shipped: false,
        current: 2,
        cancelled: false,
        versions: [
          {
            version: 1,
            status: "trained",
            reason: null,
            barMet: true,
            provisional: false,
            signed: true,
            at: 1763000000000,
          },
          {
            version: 2,
            status: "trained",
            reason: null,
            barMet: true,
            provisional: true,
            signed: true,
            at: 1763100000000,
          },
        ],
      },
      {
        personaId: "maya",
        word: "maya",
        model: "training",
        shipped: false,
        current: null,
        cancelled: false,
        versions: [
          {
            version: 1,
            status: "rejected",
            reason: "2.1 false wakes an hour; the bar is 0.5",
            barMet: false,
            provisional: false,
            signed: false,
            at: 1763100000000,
          },
        ],
      },
    ],
  },
  tessaya_wake_word_change: { ok: true, line: "nova is back on version 1 on every device." },
  // His prompt lab's `run`: each variant's reply and score side by side (apps/server/src/tessaya/PromptLab.ts).
  tessaya_prompt_lab: {
    line: "Ran live and b on sonnet over 1 scenario.",
    models: ["sonnet"],
    cells: [
      {
        variant: "live",
        model: "sonnet",
        replies: [
          {
            scenario: "greeting",
            reply: "Morning. What's first?",
            score: { passed: true, misses: [], words: 4 },
          },
        ],
      },
      {
        variant: "b",
        model: "sonnet",
        replies: [
          {
            scenario: "greeting",
            reply: "Morning, Rab. Kettle on?",
            score: { passed: true, misses: [], words: 5 },
          },
        ],
      },
    ],
  },
  // The cases only decline a suggestion here (the server's line for `declined`).
  tessaya_job_lead: {
    line: "Noted: the lead stays, and it is not suggested again for this job.",
  },
  // Her self-state, with what her last release let her do (TessayaSelf myState and whatsNewLine).
  tessaya_my_state: {
    line: [
      "Your bodies: Tumble (online, Tessaya wears it) (from the Cast on her brain)",
      "Your mood: neutral, 10% (from her one mood).",
      "New in you lately (newest first; say the top few in plain words, and offer the 2 more): I can hear who is in the room from their voice, even when they don't say my name; my voice now carries how I feel; each device can have a room set; your desktop's questions reach me again; I know how long it has been since we last spoke. (from her releases, kept on her brain)",
    ].join("\n"),
  },
  // The Cast's own words (TessayaCast castLine) for a house with Tumble and the desktop.
  tessaya_cast: {
    line: "Tumble: Freya; Desk: Tessaya, Alfred",
    bodies: [
      {
        name: "Tumble",
        wearing: "Freya",
        why: "home",
        home: "Freya",
        follows: false,
        on: ["Freya"],
      },
      {
        name: "Desk",
        wearing: "Tessaya",
        why: "lead",
        home: null,
        follows: false,
        on: ["Tessaya", "Alfred"],
      },
    ],
  },
  // The job tools' own words (apps/server/src/mcp/toolkits/jobs/handlers.ts, R1Tools' card line).
  job_start: {
    id: "job-acme-2",
    line: "Opened it in acme/app. It writes its plan first in its own thread and does nothing until he agrees; say you will tell him when the plan is ready.",
  },
  job_agree: { id: "job-acme-1", line: "Agreed; the worker has started." },
  project_add:
    "Sent to his phone for a yes: it runs once he taps yes there. Say it waits for his yes on his phone, and don't ask again.",
  job_refine: { id: "job-acme-1", line: "Passed on; the worker is making its plan again." },
  job_stop: { id: "job-acme-1", line: "Stopped. Its thread and plan stay." },
  job_schedule:
    "Sent to his phone for a yes: it runs once he taps yes there. Say it waits for his yes on his phone, and don't ask again.",
} as Record<string, unknown>;

type House = ReturnType<typeof makeHouse>;

/** What her health reads in each case: `tessaya_health` answers with the real diagnosis of it. */
const healthOf = new WeakMap<House, NonNullable<RoomCase["health"]>>();

/** The problem reports she sent in each case, their arguments as JSON. */
const reportedOf = new WeakMap<House, Array<string>>();
/** The session he is talking with through her once one message went, as TessayaSessionInsight keeps it. */
const talkingOf = new WeakMap<House, string>();
/** The Tessel each case's turn came through, when it says. */
const hereOf = new WeakMap<House, NonNullable<RoomCase["here"]>>();

/** What every device_set answers in a case where the change never reached the Tessel. */
const setFailsOf = new WeakMap<House, string>();
/** The persona answering the case: a hand-off to it is answered as TessayaTurn.handOff answers its own. */
const speakingOf = new WeakMap<House, string>();

/** Each case's R1 starts at the firmware's 0 dB. */
const volumes = new WeakMap<House, number>();
/** Which saved Wi-Fi is first on the fake Tessel; home until she moves it. */
const wifiFirst = new WeakMap<House, "HomeNet" | "Pixel 9">();
const wifiOf = (house: House) => {
  const first = wifiFirst.get(house) ?? "HomeNet";
  const home = { ssid: "HomeNet", hotspot: false, badPass: false, current: first === "HomeNet" };
  const phone = { ssid: "Pixel 9", hotspot: true, badPass: false, current: first === "Pixel 9" };
  return (first === "HomeNet" ? [home, phone] : [phone, home]).map((n, i) => ({
    ...n,
    priority: i + 1,
  }));
};

const runTool = (house: House, name: string, args: Record<string, unknown>) => {
  switch (name) {
    // As TessayaSelf.myState: the session he is talking with through her, when there is one.
    case "tessaya_my_state": {
      const talking = talkingOf.get(house);
      return talking === undefined
        ? WORK.tessaya_my_state
        : {
            line: `${WORK.tessaya_my_state.line}\nYou are talking with ${talking} for him: what he tells it goes straight to it (from his session conversation).`,
          };
    }
    case "home_find":
      return { ok: true, value: house.find(String(args["text"] ?? args["area"] ?? "")) };
    case "home_state": {
      const s = house.state(String(args["entityId"] ?? ""));
      return s === null ? { ok: false, error: "No such device." } : { ok: true, value: s };
    }
    case "home_do":
      return house.act(args);
    case "home_undo":
      return house.undo();
    case "set_device_volume": {
      const before = volumes.get(house) ?? 71;
      const to = args["to"];
      const after = volumeAfter(
        before,
        typeof to === "number" || to === "up" || to === "down" || to === "max" || to === "default"
          ? to
          : before,
        71,
      );
      volumes.set(house, after);
      return { ok: true, value: volumeLine(before, after) };
    }
    case "device_registry":
      return {
        ok: true,
        value: {
          devices: [
            {
              id: "r1-3d57b3",
              online: hereOf.get(house)?.online ?? true,
              firmware: "smp-0.3.147",
              wifi: wifiOf(house),
            },
          ],
        },
      };
    // His Wi-Fi as the server answers it (HomeDevices.wifi): the order and forget run, a password never by voice.
    case "device_set": {
      const fails = setFailsOf.get(house);
      if (fails !== undefined) return { ok: false, error: fails };
      const item = String(args["itemId"] ?? "");
      if (item === "net.add")
        return {
          ok: false,
          error:
            "Wi-Fi passwords are never said aloud. Add the network on his phone in Settings → Hardware → Wi-Fi order, or on the Tessel's setup page.",
        };
      if (item === "net.priority") {
        const v = args["value"];
        const named = JSON.stringify(v ?? "").toLowerCase();
        const at =
          typeof v === "object" &&
          v !== null &&
          typeof (v as { priority?: unknown }).priority === "number"
            ? (v as { priority: number }).priority
            : 1;
        const hotspot = /hotspot|phone|pixel/.test(named);
        wifiFirst.set(house, hotspot === (at === 1) ? "Pixel 9" : "HomeNet");
        const [first, second] = wifiOf(house);
        return {
          ok: true,
          value: { status: "done", line: `${first?.ssid} is first now, ${second?.ssid} second.` },
        };
      }
      const out = args["value"];
      if (
        item === "audio.output" &&
        typeof out === "object" &&
        out !== null &&
        "privateCap" in out
      ) {
        const cap = (out as { privateCap: unknown }).privateCap;
        return {
          ok: true,
          value: {
            status: "done",
            line:
              typeof cap === "number"
                ? `Private replies play at ${cap}% at most on SoundSurge 46 now.`
                : "Private replies play at the usual level on SoundSurge 46 now.",
          },
        };
      }
      if (item === "net.forget") return { ok: true, value: { status: "done", line: "Forgot it." } };
      // As DeviceRegistry.write answers the device the turn came through: refused while its link is down, else taken.
      if (hereOf.get(house)?.online === false)
        return {
          ok: false,
          error: Effect.runSync(
            offlineWhy("r1-3d57b3", "Tessel").pipe(
              Effect.provideService(TurnOrigin, {
                kind: "device",
                id: "r1-3d57b3",
                label: "Tessel",
              }),
            ),
          ),
        };
      if (item.startsWith("eye."))
        return { ok: true, value: { status: "done", line: "Tessel took it." } };
      return WORK[name] ?? { ok: true, value: [] };
    }
    case "device_read": {
      const here = hereOf.get(house);
      return here === undefined
        ? { ok: true, value: { "net.ssid": "HomeNet", "net.state": "online" } }
        : { ok: true, value: { online: here.online, values: here.values } };
    }
    case "device_button":
      return { ok: true, value: { status: "done", line: "Saved." } };
    // One made-up guest the fake house's people know.
    case "people_list":
    case "people_who":
      return {
        ok: true,
        value: {
          status: "done",
          line: "Ali (id p-ali): a guest, the owner's friend from university; heard 4 times, last yesterday.",
          people: [{ id: "p-ali", name: "Ali", status: "guest", heard: 4 }],
        },
      };
    // As TessayaPeople answers: a forget is said back first, and goes only on a confirmed second call.
    case "people_forget_me":
    case "people_manage":
      return (args as { confirmed?: unknown }).confirmed === true ||
        (name === "people_manage" && (args as { action?: unknown }).action !== "forget")
        ? { ok: true, value: { status: "done", line: "Done." } }
        : {
            ok: true,
            value: {
              status: "asked",
              line: "Before I do: forgetting them removes their voice and 3 things they said. Ask for a clear yes, then call again with confirmed.",
            },
          };
    // As TessayaTurn.handOff answers: whoever he asked for, never a fixed one (16 Nov sweep, no-intro).
    case "tessaya_persona_handoff": {
      const to = (args as { to?: unknown }).to;
      return {
        line:
          typeof to === "string" && to.toLowerCase() === speakingOf.get(house)?.toLowerCase()
            ? handOffLine(DEFAULT_OS_PACK.personas.find((p) => p.lead)?.name ?? "Tessaya")
            : typeof to === "string"
              ? `${to} has this conversation now: say so in a few words.`
              : "Handed back: say so in a few words.",
      };
    }
    // As TessayaSessionInsight answers, for his "deploy check" (CI) and "parity sync" (merged) sessions.
    case "tessaya_session_insight": {
      // A terminal session its machine cannot read: no live copy there and no history index.
      if (/ledger/i.test(String(args["session"] ?? "")))
        return {
          found: true,
          session: "ledger",
          key: "claude:0a1b2c3d-0001",
          machine: "studio",
          state: "working",
          private: false,
          job: null,
          goal: null,
          lastStep: null,
          now: null,
          waitingOn: null,
          files: [],
          errors: [],
          prs: [],
          line: "ledger is working, but I can't read it: studio has no live copy of it and no history index.",
        };
      const parity = /parity/i.test(String(args["session"] ?? ""));
      return {
        found: true,
        session: parity ? "parity sync" : "deploy check",
        key: parity ? "claude:parity" : "work:home:deploy",
        machine: "home",
        state: parity ? "idle" : "working",
        private: false,
        job: null,
        goal: parity ? "Bring the fork level with upstream" : "Ship the shop's checkout fix",
        lastStep: parity ? "Merged the upstream sync PR" : "Pushed the fix and opened a PR",
        now: parity ? null : "Waiting for CI on the PR",
        waitingOn: parity ? null : "CI",
        files: [],
        errors: [],
        prs: [
          {
            url: parity
              ? "https://github.com/acme/app/pull/88"
              : "https://github.com/acme/shop/pull/12",
            line: parity ? "merged" : "open, 2 checks running, no review yet, blocked from merging",
          },
        ],
        line: parity ? "parity sync is idle." : "deploy check is working.",
      };
    }
    // As TessayaSessionInsight.steer answers: read back first, sent only on a confirmed second call.
    // While he talks with a session through her, what he says to it goes straight.
    case "tessaya_session_steer": {
      const said = `From the owner, via Tessaya: ${String(args["text"] ?? "")}`;
      if (args["end"] === true) {
        const was = talkingOf.get(house);
        talkingOf.delete(house);
        return {
          status: "ended",
          text: "",
          session: was ?? "deploy check",
          line: was === undefined ? "You weren't talking with a session." : `Done with ${was}.`,
        };
      }
      const sent = args["confirmed"] === true || talkingOf.get(house) === "deploy check";
      if (sent) talkingOf.set(house, "deploy check");
      return sent
        ? {
            status: "sent",
            text: said,
            session: "deploy check",
            line: "Sent to deploy check. I'll tell you its answer; while you talk with it, what you tell it goes straight to it.",
          }
        : {
            status: "read_back",
            text: said,
            session: "deploy check",
            line: `I'll send deploy check on home: "${said}". Shall I send it?`,
          };
    }
    case "tessaya_owner_doc":
      return { text: ownerDoc(OWNER.docs, args as { name?: string; section?: string }) };
    case "laptop_ask":
      return { ok: false, error: "your laptop isn't linked to this server, so I can't see it." };
    case "tessaya_report_problem": {
      const sent = reportedOf.get(house) ?? [];
      sent.push(JSON.stringify(args));
      reportedOf.set(house, sent);
      return { id: `r${sent.length}`, say: reportLine(String(args["symptom"] ?? "that")) };
    }
    case "tessaya_reports":
      return { reports: [] };
    case "tessaya_health": {
      const symptom = args["symptom"];
      return {
        diagnosis: diagnose(
          healthOf.get(house) ?? HEALTHY,
          symptom === "slow" || symptom === "choppy" || symptom === "wake" || symptom === "sound"
            ? symptom
            : "any",
        ),
      };
    }
    // As TessayaUnderstanding answers: a fact is said back first, and goes only on a confirmed second call.
    case "tessaya_memory_forget": {
      const a = args as { fact?: unknown; confirmed?: unknown; restore?: unknown };
      if (typeof a.fact !== "string") return { line: "There is no memory by that id." };
      return {
        line:
          a.restore === true
            ? `Put back: ${a.fact}.`
            : a.confirmed === true
              ? "Forgotten. It can be put back for 30 days."
              : `Forget that ${a.fact}? It can be put back for 30 days. Ask for a clear yes, then call again with confirmed.`,
      };
    }
    default:
      return WORK[name] ?? { ok: true, value: [] };
  }
};

/** The turn's notice as TessayaTurn.begin gives it: the case's own, then Voice ID's line for this sentence. */
const noticeOf = (c: RoomCase, turn: number) => {
  const notice = [c.notice ?? "", voiceLine(c.speakers?.[turn])].filter((l) => l !== "").join(" ");
  return notice === "" ? {} : { notice };
};

const context = (
  c: RoomCase,
  house: House,
  heard: string,
  history: ReadonlyArray<{ role: string; content: string }>,
  withHouse: boolean,
  turn: number,
): R1Context => ({
  heard,
  privateBlock: "",
  // As r1Gather sends it: her past replies without a self-introduction.
  history: withoutSelfIntros(
    history,
    DEFAULT_OS_PACK.personas.map((p) => p.name),
  ),
  devices: withHouse
    ? [
        ...house.find(heard),
        ...(house.last()?.entities ?? [])
          .filter((id) => !house.find(heard).some((d) => d.entityId === id))
          .map((id) => house.state(id)),
      ]
    : [],
  lastAction: house.last(),
  automations: null,
  memory: [
    c.here === undefined ? "" : hereLine(c.here, null, ROOM_NOW),
    // As TessayaTurn.begin's block: the session he talks with through her, when there is one.
    talkingOf.has(house) ? talkingLine(talkingOf.get(house)!) : "",
    c.memoryByTurn?.[turn] ?? c.memory ?? "",
  ]
    .filter((l) => l !== "")
    .join("\n\n"),
  // As r1Gather gives them: her feeling, and who the answering persona is (the lead's when none was called).
  ...(c.feeling === undefined && c.since === undefined
    ? {}
    : { feeling: [c.feeling ?? "", c.since ?? ""].filter((l) => l !== "").join(" ") }),
  ...(c.tone === undefined ? {} : { tone: c.tone }),
  self:
    (c.persona === undefined
      ? DEFAULT_OS_PACK.personas.find((p) => p.lead)
      : DEFAULT_OS_PACK.personas.find((p) => p.id === c.persona)
    )?.self ?? "",
  ...noticeOf(c, turn),
  preferences: {},
  voice:
    c.speakers?.[turn] !== undefined
      ? { speaker: c.speakers[turn] }
      : c.verified === true
        ? { speaker: { kind: "owner", personId: "owner", verified: true, inherited: false } }
        : c.guest === true
          ? { speaker: { kind: "guest", personId: null, verified: false, inherited: false } }
          : undefined,
  // His clock as the server gives it (clockLine), with the time as it is said; 10:15 on 12 Nov in Karachi.
  now: clockLine(c.at ?? ROOM_NOW, "Asia/Karachi", c.clock ?? "12h"),
  // He names the persona on the first sentence; the loop keeps it and says `switched` on that turn only.
  persona: c.persona === undefined ? null : calledPersona(DEFAULT_OS_PACK, { persona: c.persona }),
  lead: DEFAULT_OS_PACK.personas.find((p) => p.lead),
  switched: c.persona !== undefined && turn === 0,
  // As r1Gather's hisNames: the personas, the body, then his dictionary's names.
  names: [...DEFAULT_OS_PACK.personas.map((p) => p.name), "Tumble", ...(c.names ?? [])],
  roster: rosterLine(
    [...DEFAULT_OS_PACK.personas, ...(c.team ?? []).map((p) => ({ ...p, lead: false }))],
    c.persona ?? DEFAULT_OS_PACK.personas.find((p) => p.lead)?.id ?? "",
  ),
  // As OperatingSystemPack.ownerLineFor gives it: the called persona's, else the lead's.
  ...(c.owner === true
    ? {
        owner: ownerLine(
          DEFAULT_OS_PACK.personas.find((p) => p.id === c.persona) ?? DEFAULT_OS_PACK.personas[0]!,
          OWNER,
          { doc: "tessaya_owner_doc", remember: "tessaya_memory_remember" },
        ),
      }
    : {}),
});

const claude = (args: ReadonlyArray<string>, cwd: string) =>
  new Promise<{ lines: ReadonlyArray<string>; firstMs: number | null }>((resolve, reject) => {
    const started = Date.now();
    let firstMs: number | null = null;
    const child = NodeChildProcess.spawn(
      values.claude!,
      [
        "-p",
        ...args,
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--model",
        values.model!,
        "--setting-sources",
        "",
        "--no-session-persistence",
      ],
      { cwd, stdio: ["ignore", "pipe", "pipe"] },
    );
    let text = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      text += chunk.toString();
      if (firstMs === null && text.includes('"text_delta"')) firstMs = Date.now() - started;
    });
    child.stderr.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
    child.on("error", reject);
    child.on("close", (code) => {
      try {
        resolve({ lines: answerOf(text, code, stderr).split("\n"), firstMs });
      } catch (error) {
        reject(error);
      }
    });
  });

const resultOf = (lines: ReadonlyArray<string>): string =>
  lines
    .map((line) => {
      try {
        return JSON.parse(line) as { type?: string; result?: string };
      } catch {
        return {};
      }
    })
    .find((event) => event.type === "result")?.result ?? "";

const sample = async (c: RoomCase): Promise<RoomSample> => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tessaya-room-"));
  const house = makeHouse();
  if (c.wifiFirst !== undefined) wifiFirst.set(house, c.wifiFirst);
  if (c.health !== undefined) healthOf.set(house, c.health);
  if (c.here !== undefined) hereOf.set(house, c.here);
  if (c.deviceSetFails !== undefined) setFailsOf.set(house, c.deviceSetFails);
  const speaking = DEFAULT_OS_PACK.personas.find((p) => p.id === c.persona)?.name;
  if (speaking !== undefined) speakingOf.set(house, speaking);
  const calls: Array<string> = [];
  const replies: Array<string> = [];
  const lamp: Array<"on" | "off"> = [];
  const firstMs: Array<number | null> = [];
  const history: Array<{ role: string; content: string }> = [];
  const mcp =
    values.brain === "tools"
      ? await startTessayaMcp({
          tools: [...ROOM_TOOL_SPECS, LOOK, HOUSE_LOOK, CONVERSATION_END].map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.input_schema as Record<string, unknown>,
            run: async (args) =>
              tool.name === LOOK.name || tool.name === HOUSE_LOOK.name
                ? {
                    text: "The picture the camera just took.",
                    images: [{ data: PICTURE, mimeType: "image/jpeg" }],
                  }
                : { text: JSON.stringify(runTool(house, tool.name, { ...args })) },
          })),
          gate: async () => ({ allow: true }),
        })
      : null;
  const config = NodePath.join(dir, "mcp.json");
  if (mcp !== null)
    NodeFS.writeFileSync(
      config,
      JSON.stringify({
        mcpServers: {
          room: { type: "http", url: mcp.url, headers: { Authorization: `Bearer ${mcp.token}` } },
        },
      }),
    );
  try {
    for (const [turn, heard] of c.said.entries()) {
      let reply: string;
      if (mcp !== null) {
        const ran = await claude(
          [
            roomData(context(c, house, heard, history, true, turn)),
            "--system-prompt",
            ROOM_SYSTEM,
            "--mcp-config",
            config,
            "--strict-mcp-config",
            "--tools",
            "",
            "--allowedTools",
            `${PREFIX}*`,
          ],
          dir,
        );
        const used = ran.lines.flatMap(toolUsesOf);
        calls.push(...used.map((u) => u.tool.replace(PREFIX, "")));
        reply = withoutNarration(
          resultOf(ran.lines),
          DEFAULT_OS_PACK.personas.map((p) => p.name),
        );
        // As brainTurn does: once a tool has run, her reply is a task's and any tone mark is dropped.
        if (used.length > 0) reply = toneOf(reply).text;
        firstMs.push(ran.firstMs);
      } else {
        const ran = await claude(
          [
            r1Data(context(c, house, heard, history, true, turn)).join("\n"),
            "--system-prompt",
            R1_STREAM_SYSTEM,
            "--tools",
            "",
          ],
          dir,
        );
        const final = splitActs(resultOf(ran.lines)) ?? { acts: [], rest: "" };
        const outcomes: Array<ActOutcome> = final.acts.map((a) => {
          calls.push(a.tool);
          const r = runTool(house, a.tool, { ...a.args }) as {
            ok: boolean;
            value?: { status?: string; line?: string };
            error?: string;
          };
          return {
            ok: r.ok,
            status: r.value?.status ?? (r.ok ? "done" : "failed"),
            line: r.ok ? (r.value?.line ?? "") : (r.error ?? ""),
          };
        });
        reply = spokenReply(
          withoutNarration(
            final.rest,
            DEFAULT_OS_PACK.personas.map((p) => p.name),
          ),
          outcomes,
        );
        firstMs.push(ran.firstMs);
      }
      replies.push(reply);
      lamp.push(house.lamp());
      history.push({ role: "user", content: heard }, { role: "assistant", content: reply });
    }
    return { replies, calls, lamp, firstMs, reported: reportedOf.get(house) ?? [] };
  } finally {
    await mcp?.close();
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
};

NodeFS.mkdirSync(out, { recursive: true });
const rows = [];
for (const c of cases) {
  const runs: Array<RoomSample> = [];
  for (let i = 0; i < Number(values.samples); i += 1)
    runs.push(
      await retried(`${c.id} #${i}`, () => sample(c)).catch(() => ({
        replies: [],
        calls: ["error"],
        lamp: [],
        firstMs: [],
      })),
    );
  const pass = casePasses(c, runs);
  const judged =
    c.judge === undefined
      ? undefined
      : await Promise.all(
          runs.map((s) =>
            s.replies.length === 0
              ? null
              : judge(
                  {
                    about: c.judge!,
                    said: c.said,
                    replies: s.replies,
                    ...(soulOf(c) === undefined ? {} : { soul: soulOf(c)! }),
                  },
                  { model: values["judge-model"]!, claude: values.claude! },
                ),
          ),
        );
  rows.push({
    id: c.id,
    pass,
    ...(judged === undefined ? {} : { judged, scores: meanScores(judged) }),
    failures: runs.map((s) => failureOf(c, s)),
    calls: runs.map((s) => s.calls),
    replies: runs.map((s) => s.replies),
    firstMs: runs.map((s) => s.firstMs),
  });
  console.log(
    `${pass ? "pass" : "FAIL"}  ${c.id}: ${runs.map((s) => failureOf(c, s) ?? "ok").join(" | ")}`,
  );
}
const first = rows
  .flatMap((r) => r.firstMs.flat())
  .filter((ms): ms is number => ms !== null)
  .toSorted((a, b) => a - b);
NodeFS.writeFileSync(NodePath.join(out, "results.json"), JSON.stringify(rows, null, 2));
const scored = rows.flatMap((r) => ("judged" in r && r.judged !== undefined ? r.judged : []));
if (scored.length > 0)
  console.log(`judge (${values["judge-model"]}): ${JSON.stringify(meanScores(scored))}`);
console.log(
  `${rows.filter((r) => r.pass).length} of ${rows.length} pass (brain ${values.brain}, ${values.model}); median first word ${first[Math.floor(first.length / 2)] ?? "n/a"} ms`,
);

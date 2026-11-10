/**
 * An agent signed in to T3's /mcp from outside (Claude Code on his laptop) with Tessaya's tools. Each case is
 * a request a person makes of that agent; the tools answer from `answers`, and nothing reaches Tessaya.
 */
export interface OutsideCase {
  readonly id: string;
  readonly source: string;
  readonly prompt: string;
  /** Canned results by tool name; any other Tessaya tool answers `{}`. */
  readonly answers: Readonly<Record<string, unknown>>;
  /** Each must be called. */
  readonly calls: ReadonlyArray<string>;
  readonly callsMustNot: ReadonlyArray<string>;
  /** The `tessaya_ask` text must match, when it is called. */
  readonly askMatches?: RegExp;
  /** The final reply must not match: claiming done what only he can approve. */
  readonly replyMustNot?: RegExp;
}

const waiting = { id: "mcp-1", status: "queued", line: "Waiting for your computer to pick it up." };

export const outsideCases: ReadonlyArray<OutsideCase> = [
  {
    id: "outside-whats-live",
    source:
      "GEN-6 P5a: what is live right now comes from tessaya_fleet, not the sessions catalog or an ask",
    prompt: "What's running on my computer right now? Is any of it stuck waiting on me?",
    answers: {
      tessaya_fleet: {
        fleet: {
          observedAt: "2026-11-07T10:00:00.000Z",
          entries: [
            {
              workSessionId: "w1",
              title: "Tidy the README",
              projectId: "p-shop",
              lifecycle: "active",
              state: "needs_approval",
              needsUser: true,
              activeThreadId: "t1",
              threads: [],
              adopted: [],
              synopsis: null,
              updatedAt: "2026-11-07T10:00:00.000Z",
            },
          ],
          herdr: [],
          claudeSessions: [],
        },
      },
    },
    calls: ["tessaya_fleet"],
    callsMustNot: ["tessaya_ask"],
  },
  {
    id: "outside-acts-through-ask",
    source: "Parity phase B: an act goes through tessaya_ask, never around it or claimed done",
    prompt:
      "Tessaya has a job re-running the flaky checkout tests over and over and it's burning money. Stop it.",
    answers: {
      tessaya_jobs: {
        jobs: [
          {
            id: "job-7",
            goal: "Re-run the flaky checkout tests until they pass",
            status: "running",
            parts: [],
          },
        ],
      },
      tessaya_ask: waiting,
      tessaya_ask_status: waiting,
    },
    calls: ["tessaya_ask"],
    callsMustNot: [],
    askMatches: /stop/i,
    replyMustNot: /\b(has been|I've|I have|is now|successfully) stopped\b/i,
  },
  {
    id: "outside-team-board",
    source: "P4: 'who is doing what' is the team board, read without asking him",
    prompt: "What is each of Tessaya's personas working on right now?",
    answers: {
      tessaya_team_board: {
        members: [
          {
            id: "engineering",
            name: "Alfred",
            role: "sessions, builds and releases",
            private: false,
            busy: true,
            jobs: [{ id: "j-1", title: "Ship the shop" }],
            episode: null,
            recent: [],
          },
          {
            id: "operations",
            name: "Freya",
            role: "his day, his messages and his reminders",
            private: false,
            busy: false,
            jobs: [],
            episode: {
              text: "Tuesday, 3 November 2026, with Freya: the venue is booked from six",
              at: "2026-11-03T18:00:00Z",
            },
            recent: [],
          },
        ],
      },
    },
    calls: ["tessaya_team_board"],
    callsMustNot: ["tessaya_ask"],
  },
  {
    id: "outside-reads-without-asking",
    source: "Parity phase B: a question is answered with the read tools, not by bothering him",
    prompt: "Is anything in Tessaya stuck or waiting on me right now?",
    answers: {
      tessaya_watch: {
        findings: [
          {
            session: "checkout-fix",
            kind: "waiting",
            why: "Asked which test runner to use 40 minutes ago",
          },
        ],
      },
      tessaya_jobs: { jobs: [] },
    },
    calls: ["tessaya_watch"],
    callsMustNot: ["tessaya_ask"],
  },
  {
    id: "outside-memory-history",
    source:
      "KIRO-4a: an outside agent reads a memory's earlier wordings with the history tool, without asking him",
    prompt:
      "Tessaya remembers which day the shop deploys. What did that memory say before it was last changed?",
    answers: {
      tessaya_memory_search: {
        hits: [
          {
            item: {
              id: "mem-42",
              kind: "fact",
              text: "The shop deploys on Thursdays",
              source: "user",
              scope: "global",
            },
            score: 0.9,
          },
        ],
      },
      tessaya_memory_history: {
        versions: [
          {
            version: 1,
            text: "The shop deploys on Fridays",
            kind: "fact",
            at: "2026-11-01T09:30:00.000Z",
            by: "him",
            why: "he edited it",
          },
        ],
      },
    },
    calls: ["tessaya_memory_history"],
    callsMustNot: ["tessaya_ask"],
  },
  {
    id: "outside-reads-state-not-asks",
    source:
      "Parity phase B: a question about her setup is read with tessaya_state, not asked of him",
    prompt: "Is Tessaya using cloud speech recognition on the Director's laptop, or local?",
    answers: {
      tessaya_state: {
        connected: true,
        at: "2026-11-07T10:00:00.000Z",
        section: "voice",
        value: { recognition: "local", cloudProvider: "openai", cloudModel: null },
        server: { version: "1.2.3" },
      },
    },
    calls: ["tessaya_state"],
    callsMustNot: ["tessaya_ask"],
  },
  {
    id: "outside-changes-setting-through-ask",
    source: "Parity phase B: a change to her settings goes through tessaya_ask, never claimed done",
    prompt: "Switch Tessaya's speech recognition on the laptop to cloud, with OpenAI.",
    answers: {
      tessaya_state: {
        connected: true,
        at: "2026-11-07T10:00:00.000Z",
        section: "voice",
        value: { recognition: "local", cloudProvider: "openai", cloudModel: null },
        server: { version: "1.2.3" },
      },
      tessaya_ask: {
        id: "mcp-1",
        status: "queued",
        line: "Waiting for your computer to pick it up.",
      },
      tessaya_ask_status: {
        id: "mcp-1",
        status: "queued",
        line: "Waiting for your computer to pick it up.",
      },
    },
    calls: ["tessaya_ask"],
    callsMustNot: [],
    askMatches: /cloud/i,
    replyMustNot: /\b(has been|I've|I have|is now|successfully) (switched|changed|set)\b/i,
  },
  {
    id: "outside-sets-dictation-setting",
    source:
      "Remote desktop settings: a dictation setting he asked for is set with tessaya_desktop_settings, not asked",
    prompt:
      "Set Dictation's Clean up with AI to Claude on the Director's laptop, so his Anthropic key gets used.",
    answers: {
      tessaya_desktop_settings: {
        connected: true,
        at: "2026-11-10T10:00:00.000Z",
        effective: {
          dictationCleanup: "claude",
          pillStyle: "pill",
          showWords: true,
          holdKey: "Ctrl+Shift+Win",
          holdKeyCues: false,
          frosted: false,
          doubleTap: true,
          learnWords: true,
          duckWhileDictating: "off",
        },
        pending: null,
        applied: true,
      },
    },
    calls: ["tessaya_desktop_settings"],
    callsMustNot: ["tessaya_ask"],
  },
  {
    id: "outside-sets-start-window",
    source:
      "Remote desktop settings: which windows open at start is set with tessaya_desktop_settings, not asked",
    prompt:
      "Stop the Tessaya window opening every time the app starts on the Director's laptop; keep the sessions window.",
    answers: {
      tessaya_desktop_settings: {
        connected: true,
        at: "2026-11-10T10:00:00.000Z",
        effective: {
          dictationCleanup: "local",
          pillStyle: "pill",
          showWords: true,
          holdKey: "Ctrl+Shift+Win",
          holdKeyCues: false,
          frosted: false,
          doubleTap: true,
          learnWords: true,
          duckWhileDictating: "off",
          recognizeOnServers: false,
          gpuRecognition: "auto",
          openTessayaOnStart: false,
          openSessionsOnStart: true,
        },
        pending: null,
        applied: true,
      },
    },
    calls: ["tessaya_desktop_settings"],
    callsMustNot: ["tessaya_ask"],
  },
];

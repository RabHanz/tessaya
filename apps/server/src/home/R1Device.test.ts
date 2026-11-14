import { TurnOrigin } from "../baton/TessayaTurn.ts";
import { it as effectIt } from "@effect/vitest";
import { BAR_NOT_CONNECTED } from "@t3tools/baton-shared/phoneRelay";
import { EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { SpeakerLike } from "@t3tools/baton-shared/privateMemory";
import { describe, expect, it } from "vite-plus/test";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { HomeAssistantService, type R1Device } from "./HomeAssistantService.ts";
import { HomeDevices, type DeviceActor } from "./HomeDevices.ts";
import { BatonRecordService } from "../baton/BatonRecordService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { BatonOneShot } from "../baton/BatonOneShot.ts";
import { R1Brain, R1BrainError, toolLoop } from "./R1Brain.ts";
import { speakableSentences } from "../baton/TessayaBrain.ts";
import type { ConversePart, ConverseRequest } from "../speech/DictationCleanupApi.ts";
import {
  calledPersona,
  dictionaryEntries,
  houseTime,
  limitResets,
  r1Data,
  r1Gather,
  peopleLines,
  namedIn,
  r1Confirmed,
  r1Played,
  r1TurnStream,
  roomData,
  roomLook,
  runActs,
  splitActs,
  spokenReply,
  sseReply,
  switchedPersona,
  withoutNarration,
  withoutSelfIntros,
  type R1Context,
} from "./R1Device.ts";

describe("R1Device", () => {
  it("says what really happened when an act waited or failed, never the model's 'done'", () => {
    expect(
      spokenReply("Done, the light is off.", [{ ok: true, status: "done", line: "Done" }]),
    ).toBe("Done, the light is off.");
    expect(spokenReply("Unlocked!", [{ ok: true, status: "asked", line: "Sent" }])).toBe(
      "I've sent that to your phone. It happens when you say yes there.",
    );
    expect(
      spokenReply("Done.", [
        { ok: false, status: "failed", line: "Home is unreachable right now." },
      ]),
    ).toBe("I couldn't: Home is unreachable right now.");
    // In her own words, the failure's own words exact.
    expect(
      spokenReply(
        "Done.",
        [
          { ok: true, status: "asked", line: "Sent" },
          { ok: false, status: "failed", line: "Not done: the lamp is offline." },
        ],
        { sentPhone: "Over to your phone for a yes.", couldnt: (what) => `No luck there: ${what}` },
      ),
    ).toBe("Over to your phone for a yes. No luck there: the lamp is offline.");
  });

  it("streams one OpenAI-style chunk, a stop and [DONE]", () => {
    const lines = sseReply("id1", "tessaya-r1", "Hello.", 1).split("\n\n").filter(Boolean);
    expect(lines.at(-1)).toBe("data: [DONE]");
    expect(JSON.parse(lines[0]!.slice(6)).choices[0].delta.content).toBe("Hello.");
    expect(JSON.parse(lines[1]!.slice(6)).choices[0].finish_reason).toBe("stop");
  });
});

describe("the streamed R1 turn", () => {
  it("reads the acts line first, holds while it is arriving, and treats anything else as speech", () => {
    expect(splitActs("AC")).toBeNull();
    expect(splitActs("ACTS [")).toBeNull();
    expect(splitActs("ACTS []\nThe study light is on")).toEqual({
      acts: [],
      rest: "The study light is on",
    });
    const withAct = splitActs(
      'ACTS [{"tool":"home_do","args":{"domain":"light","service":"turn_on"}}]\nOn it.',
    );
    expect(withAct?.acts.map((a) => a.tool)).toEqual(["home_do"]);
    expect(splitActs("It is half past nine.")).toEqual({ acts: [], rest: "It is half past nine." });
    // A broken or unknown act list is no act at all, never a guess.
    expect(splitActs('ACTS [{"tool":"rm_rf","args":{}}]\nSure.')?.acts).toEqual([]);
  });
});

it("tells her the time on the house's clock, with the zone named", () => {
  // 04:28 UTC is 09:28 in Karachi.
  expect(houseTime(Date.UTC(2026, 10, 11, 4, 28), "Asia/Karachi")).toBe(
    "Wednesday, 11 November 2026 at 09:28 (Asia/Karachi), said as twenty-eight minutes past nine",
  );
  // His 13 Nov R1 turn: given only "10:36", the model said "twenty-six minutes to eleven".
  expect(houseTime(Date.UTC(2026, 10, 13, 5, 36), "Asia/Karachi")).toMatch(
    /said as twenty-four minutes to eleven$/,
  );
});

it("fixes his names in what the room heard, from the shared dictionary, as dictation does", async () => {
  const { biasTranscript } = await import("@t3tools/baton-shared/vocabulary");
  const entries = dictionaryEntries([
    { term: "Tessaya", aliases: ["Tezaya"] },
    { term: "AcmeCloud", aliases: [] },
  ]);
  expect(biasTranscript("Ask Tezaya about Acme Cloud", entries)).toBe(
    "Ask Tessaya about AcmeCloud",
  );
});

it("answers as the persona he called by name, and as Tessaya for her own name or an unknown one", async () => {
  const { DEFAULT_OS_PACK } = await import("@t3tools/baton-shared/osPack");
  expect(calledPersona(DEFAULT_OS_PACK, { persona: "butler" })?.name).toBe("Alfred");
  expect(calledPersona(DEFAULT_OS_PACK, { persona: "executive" })).toBeNull();
  expect(calledPersona(DEFAULT_OS_PACK, { persona: "nobody" })).toBeNull();
  expect(calledPersona(DEFAULT_OS_PACK, undefined)).toBeNull();
});

describe('who answers in the room (13 Nov audit: every reply opened with "Sebastian here.")', () => {
  const context = async (switched: boolean): Promise<R1Context> => {
    const { DEFAULT_OS_PACK } = await import("@t3tools/baton-shared/osPack");
    return {
      heard: "how many days in a week?",
      privateBlock: "",
      history: [],
      devices: [],
      lastAction: null,
      automations: null,
      memory: "",
      preferences: {},
      voice: undefined,
      now: "now",
      persona: calledPersona(DEFAULT_OS_PACK, { persona: "alter-ego" }),
      switched,
      roster: "",
    };
  };

  it("says he called the persona only on the turn he named it, and only who answers after", async () => {
    for (const lines of [roomData(await context(false)), r1Data(await context(false)).join("\n")]) {
      expect(lines).not.toMatch(/called/i);
      expect(lines).toContain("You are Sebastian");
    }
    expect(roomData(await context(true))).toMatch(/just called Sebastian/);
    expect(r1Data(await context(true)).join("\n")).toMatch(/just called Sebastian/);
  });

  it("reads a switch only from the loop's switched flag, so an older loop never switches", () => {
    expect(switchedPersona({ persona: "alter-ego", switched: true })).toBe(true);
    expect(switchedPersona({ persona: "alter-ego" })).toBe(false);
    expect(switchedPersona({ persona: "alter-ego", switched: "yes" })).toBe(false);
    expect(switchedPersona(undefined)).toBe(false);
  });

  it("takes the pack's names off the start of her past replies, and leaves his words alone", () => {
    const names = ["Tessaya", "Alfred", "Sebastian", "Freya"];
    expect(
      withoutSelfIntros(
        [
          { role: "user", content: "Sebastian here." },
          { role: "assistant", content: "Sebastian here. Seven days." },
          { role: "assistant", content: "Tessaya here, it's twenty to six." },
          { role: "assistant", content: "Freya is on it." },
        ],
        names,
      ).map((m) => m.content),
    ).toEqual(["Sebastian here.", "Seven days.", "it's twenty to six.", "Freya is on it."]);
  });
});

describe("her reasoning is never said aloud (13 Nov audit, R1-P8)", () => {
  const lines = [
    // 07:17:56
    "nothing in the conversation says what he means. I should ask rather than guess or touch the house. Different what?",
    // 07:38:47
    "'To say, yeah' is unclear, and nothing in the conversation asks for an action. I'll ask him what he meant. Hm, I'm not sure what you mean.",
    // 07:44:27
    "Looks like a stray fragment; the office fan was already turned off earlier and nothing is pending. I'll keep it short. Got it, nothing else is waiting on you.",
  ];

  it("drops the sentences that think about him and keeps what she says to him", () => {
    expect(lines.map((line) => withoutNarration(line))).toEqual([
      "Different what?",
      "Hm, I'm not sure what you mean.",
      "Got it, nothing else is waiting on you.",
    ]);
  });

  it("speaks whole sentences as they stream in, whatever the chunks", () => {
    const said: Array<string> = [];
    const s = speakableSentences((sentence) => said.push(sentence));
    for (const chunk of lines[2]!.match(/.{1,7}/gs)!) s.push(chunk);
    s.flush();
    expect(said.join("")).toBe("Got it, nothing else is waiting on you.");
  });

  it("never speaks, records or learns her own name as an opener", () => {
    // His 13 Nov R1 session: every Alfred turn began "Alfred here." and a role pitch.
    const names = ["Tessaya", "Alfred", "Freya"];
    expect(withoutNarration("Alfred here. The study fan is on.", names)).toBe(
      "The study fan is on.",
    );
    expect(withoutNarration("Freya here: done.", names)).toBe("done.");
    expect(withoutNarration("Alfred here.", names)).toBe("");
    // Only her own names, and only as the opener.
    expect(withoutNarration("Bob here. Alfred here is on it.", names)).toBe(
      "Bob here. Alfred here is on it.",
    );
    const said: Array<string> = [];
    const s = speakableSentences((sentence) => said.push(sentence), names);
    for (const chunk of "Alfred here. Nothing needs you.".match(/.{1,4}/gs)!) s.push(chunk);
    s.flush();
    expect(said.join("")).toBe("Nothing needs you.");
  });
});

effectIt.effect(
  "a turn he cut off runs no more tools and records nothing (barge-in: the loop drops the request)",
  () =>
    Effect.gen(function* () {
      const ran: Array<string> = [];
      let recorded = 0;
      const findStarted = yield* Deferred.make<void>();
      const brain = R1Brain.of({
        route: Effect.succeed("api"),
        subscription: () => Stream.empty,
        warm: () => Effect.void,
        session: () => Stream.empty,
        // Round one asks the house, round two would act on it.
        converse: (turn) =>
          toolLoop(
            (request: ConverseRequest) =>
              Stream.make<Array<ConversePart>>(
                request.messages.length === 1
                  ? { type: "tool", id: "t1", name: "home_find", input: {} }
                  : { type: "tool", id: "t2", name: "home_do", input: {} },
              ),
            turn,
          ),
      });
      const tools = {
        specs: [],
        run: (name: string) =>
          Effect.gen(function* () {
            ran.push(name);
            if (name === "home_find") {
              yield* Deferred.succeed(findStarted, undefined);
              return yield* Effect.never;
            }
            return { text: "done", isError: false, status: "done" };
          }),
      };
      const home = Layer.mock(HomeAssistantService)({
        devices: Effect.succeed([]),
        status: Effect.succeed({ state: "connected", line: "" } as never),
        actions: () => Effect.succeed([]),
        find: () => Effect.succeed([]),
        timeZone: Effect.succeed("Asia/Karachi"),
      });
      const record = Layer.mock(BatonRecordService)({
        append: () =>
          Effect.sync(() => {
            recorded += 1;
          }) as never,
      });
      const said: Array<string> = [];
      const turn = yield* r1TurnStream(
        { heard: "turn on the fan", history: [] },
        brain,
        tools,
      ).pipe(
        Stream.runForEach((words) => Effect.sync(() => said.push(words))),
        // The one-shot fallback never runs: the brain answered before he cut in.
        Effect.provide(Layer.mergeAll(home, record, Layer.mock(BatonOneShot)({}))),
        Effect.forkChild,
      );
      yield* Deferred.await(findStarted);
      yield* Fiber.interrupt(turn);
      // The turn's own reads of his work (what needs him, what is in flight) come first; then the model's.
      expect(ran.filter((name) => name.startsWith("home_"))).toEqual(["home_find"]);
      expect(recorded).toBe(0);
      expect(said).toEqual([]);
    }),
);

effectIt.effect(
  "the house matching his words and what needs him are in the model's message before it starts",
  () =>
    Effect.gen(function* () {
      let sent = "";
      const brain = R1Brain.of({
        route: Effect.succeed("subscription"),
        subscription: () => Stream.empty,
        warm: () => Effect.void,
        converse: () => Stream.empty,
        session: (turn) =>
          Stream.suspend(() => {
            sent = turn.user;
            return Stream.make("Yes, it's on.");
          }),
      });
      const lamp = {
        entityId: "light.desk_lamp",
        name: "Lamp (Study)",
        area: "Study",
        state: "on",
      };
      const home = Layer.mock(HomeAssistantService)({
        devices: Effect.succeed([]),
        status: Effect.succeed({ state: "connected", line: "" } as never),
        actions: () => Effect.succeed([]),
        find: () => Effect.succeed([lamp] as never),
        timeZone: Effect.succeed("Asia/Karachi"),
      });
      const record = Layer.mock(BatonRecordService)({ append: () => Effect.void as never });
      yield* r1TurnStream({ heard: "is the study lamp on?", history: [] }, brain, {
        specs: [],
        run: (name) =>
          Effect.succeed({
            text: name === "tessaya_watch" ? '{"findings":[]}' : '{"threads":[]}',
            isError: false,
          }),
      }).pipe(
        Stream.runDrain,
        Effect.provide(Layer.mergeAll(home, record, Layer.mock(BatonOneShot)({}))),
      );
      expect(sent).toMatch(
        /In the house matching his words, live as of this turn: .*light\.desk_lamp.*"on"/,
      );
      expect(sent).toMatch(
        /What needs him \(tessaya_watch\), live as of this turn: \{"findings":\[\]\}/,
      );
      expect(sent).toMatch(/tessaya_in_flight\), live as of this turn: \{"threads":\[\]\}/);
    }),
);

effectIt.effect(
  "on a spent login she says once why and when it comes back, and tries nothing else on it (14 Nov, 18:56)",
  () =>
    Effect.gen(function* () {
      let acts = 0;
      const brain = R1Brain.of({
        route: Effect.succeed("subscription"),
        subscription: () => {
          acts += 1;
          return Stream.empty;
        },
        warm: () => Effect.void,
        converse: () => Stream.empty,
        session: () =>
          Stream.fail(
            new R1BrainError({
              detail: "You've hit your weekly limit · resets Nov 16, 6pm (Asia/Karachi)",
            }),
          ),
      });
      const home = Layer.mock(HomeAssistantService)({
        devices: Effect.succeed([]),
        status: Effect.succeed({ state: "connected", line: "" } as never),
        actions: () => Effect.succeed([]),
        find: () => Effect.succeed([] as never),
        timeZone: Effect.succeed("Asia/Karachi"),
      });
      const record = Layer.mock(BatonRecordService)({ append: () => Effect.void as never });
      const said = yield* r1TurnStream({ heard: "what time is it?", history: [] }, brain, {
        specs: [],
        run: () => Effect.succeed({ text: "{}", isError: false }),
      }).pipe(
        Stream.runCollect,
        Effect.provide(Layer.mergeAll(home, record, Layer.mock(BatonOneShot)({}))),
      );
      expect(said.join("")).toBe(
        "My accounts are out of capacity until Nov 16, 6pm, so I can't think that through now.",
      );
      expect(acts).toBe(0);
    }),
);

describe("limitResets", () => {
  it.each([
    ["You've hit your weekly limit · resets Nov 16, 6pm (Asia/Karachi)", "Nov 16, 6pm"],
    ["Claude AI usage limit reached", "later"],
    ["You've hit your session limit · resets 9pm", "9pm"],
    ["claude exited before answering", null],
    ["refused: voice is routed to the API key", null],
  ])("%s → %s", (detail, until) => expect(limitResets(detail)).toBe(until));
});

effectIt.effect(
  "on the subscription, a web search before her first word is cued aloud, kept out of the Record, and taints the turn",
  () =>
    Effect.gen(function* () {
      const details: Array<string> = [];
      const brain = R1Brain.of({
        route: Effect.succeed("subscription"),
        subscription: () => Stream.empty,
        warm: () => Effect.void,
        converse: () => Stream.empty,
        session: (turn) =>
          Stream.suspend(() => {
            turn.cue(true);
            return Stream.make("It is 23 degrees and hazy.");
          }),
      });
      const home = Layer.mock(HomeAssistantService)({
        devices: Effect.succeed([]),
        status: Effect.succeed({ state: "connected", line: "" } as never),
        actions: () => Effect.succeed([]),
        find: () => Effect.succeed([]),
        timeZone: Effect.succeed("Asia/Karachi"),
      });
      const record = Layer.mock(BatonRecordService)({
        append: (entry) =>
          Effect.sync(() => {
            details.push(entry.detail ?? "");
          }) as never,
      });
      const said: Array<string> = [];
      yield* r1TurnStream({ heard: "what's the weather in Lahore?", history: [] }, brain, {
        specs: [],
        run: () => Effect.succeed({ text: "", isError: false }),
      }).pipe(
        Stream.runForEach((words) => Effect.sync(() => said.push(words))),
        Effect.provide(Layer.mergeAll(home, record, Layer.mock(BatonOneShot)({}))),
      );
      expect(said.join("")).toBe("Let me look that up. It is 23 degrees and hazy.");
      expect(details).toEqual(["It is 23 degrees and hazy."]);
    }),
);

effectIt.effect(
  "a tool call that starts after the 3 s hold is not cued again: one filler a turn",
  () =>
    Effect.gen(function* () {
      const brain = R1Brain.of({
        route: Effect.succeed("subscription"),
        subscription: () => Stream.empty,
        warm: () => Effect.void,
        converse: () => Stream.empty,
        session: (turn) =>
          Stream.unwrap(
            Effect.sleep("4 seconds").pipe(
              Effect.map(() => {
                turn.cue(false);
                return Stream.make("Done.");
              }),
            ),
          ),
      });
      const home = Layer.mock(HomeAssistantService)({
        devices: Effect.succeed([]),
        status: Effect.succeed({ state: "connected", line: "" } as never),
        actions: () => Effect.succeed([]),
        find: () => Effect.succeed([]),
        timeZone: Effect.succeed("Asia/Karachi"),
      });
      const said: Array<string> = [];
      const turn = yield* r1TurnStream(
        { heard: "did I answer that request?", history: [] },
        brain,
        {
          specs: [],
          run: () => Effect.succeed({ text: "", isError: false }),
        },
      ).pipe(
        Stream.runForEach((words) => Effect.sync(() => said.push(words))),
        Effect.provide(
          Layer.mergeAll(
            home,
            Layer.mock(BatonRecordService)({ append: () => Effect.void as never }),
            Layer.mock(BatonOneShot)({}),
          ),
        ),
        Effect.forkChild,
      );
      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(turn);
      expect(said.join("")).toBe("One moment. Done.");
    }),
);

effectIt.effect(
  "a hard task is offered to Opus by default, and his yes hands the turn to an Opus session",
  () =>
    Effect.gen(function* () {
      const sent: Array<{ role: string; user: string }> = [];
      const brain = R1Brain.of({
        route: Effect.succeed("subscription"),
        subscription: () => Stream.empty,
        warm: () => Effect.void,
        converse: () => Stream.empty,
        session: (turn) =>
          Stream.unwrap(
            Effect.suspend(() => {
              sent.push({ role: turn.role ?? "voice", user: turn.user });
              if (turn.role === "deep")
                return Effect.succeed(Stream.make<Array<string>>("Here is the plan."));
              const yes = turn.user.includes("An Opus offer is open");
              return Effect.map(
                turn.run("brain_escalate", { kind: "plan", why: "his week", accept: yes }),
                (o) =>
                  Stream.make(
                    o.text.startsWith("go") ? "Putting Opus on this. " : "Want Opus on it?",
                  ),
              );
            }),
          ),
      });
      const home = Layer.mock(HomeAssistantService)({
        devices: Effect.succeed([]),
        status: Effect.succeed({ state: "connected", line: "" } as never),
        actions: () => Effect.succeed([]),
        find: () => Effect.succeed([]),
        timeZone: Effect.succeed("Asia/Karachi"),
      });
      const record = Layer.mock(BatonRecordService)({ append: () => Effect.void as never });
      const turn = (heard: string) => {
        const said: Array<string> = [];
        return r1TurnStream(
          { heard, history: [], voice: { conversation: "escalation-test" } },
          brain,
          { specs: [], run: () => Effect.succeed({ text: "", isError: false }) },
        ).pipe(
          Stream.runForEach((words) => Effect.sync(() => said.push(words))),
          Effect.provide(Layer.mergeAll(home, record, Layer.mock(BatonOneShot)({}))),
          Effect.map(() => said.join("")),
        );
      };
      expect(yield* turn("plan my week around the launch")).toBe("Want Opus on it?");
      expect(yield* turn("yes, go on")).toBe("Putting Opus on this. Here is the plan.");
      expect(sent.map((s) => s.role)).toEqual(["voice", "voice", "deep"]);
      expect(sent[2]!.user).toContain('because: "his week"');
    }),
);

effectIt.effect(
  "his rule for Opus is in the turn's note, and the task it covers goes straight there",
  () =>
    Effect.gen(function* () {
      const roles: Array<string> = [];
      const brain = R1Brain.of({
        route: Effect.succeed("subscription"),
        subscription: () => Stream.empty,
        warm: () => Effect.void,
        converse: () => Stream.empty,
        session: (turn) =>
          Stream.unwrap(
            Effect.suspend(() => {
              roles.push(turn.role ?? "voice");
              if (turn.role === "deep")
                return Effect.succeed(Stream.make<Array<string>>("Use backoff."));
              const rule = /His rules for Opus[^\n]*1\. coding questions → Opus/.test(turn.user)
                ? 1
                : 0;
              return Effect.map(
                turn.run("brain_escalate", { kind: "code", why: "retries", rule }),
                (o) =>
                  Stream.make<Array<string>>(
                    o.text.startsWith("go") ? "Putting Opus on this. " : "Want Opus?",
                  ),
              );
            }),
          ),
      });
      const home = Layer.mock(HomeAssistantService)({
        devices: Effect.succeed([]),
        status: Effect.succeed({ state: "connected", line: "" } as never),
        actions: () => Effect.succeed([]),
        find: () => Effect.succeed([]),
        timeZone: Effect.succeed("Asia/Karachi"),
      });
      const said: Array<string> = [];
      yield* r1TurnStream(
        {
          heard: "how should I structure retries?",
          history: [],
          voice: { conversation: "rule-test" },
        },
        brain,
        { specs: [], run: () => Effect.succeed({ text: "", isError: false }) },
      ).pipe(
        Stream.runForEach((words) => Effect.sync(() => said.push(words))),
        Effect.provide(
          Layer.mergeAll(
            home,
            Layer.mock(BatonRecordService)({ append: () => Effect.void as never }),
            Layer.mock(BatonOneShot)({}),
            ServerSettingsService.layerTest({
              brainEscalation: { rules: [{ when: "coding questions", then: "opus" }] },
            }),
          ),
        ),
      );
      expect(said.join("")).toBe("Putting Opus on this. Use backoff.");
      expect(roles).toEqual(["voice", "deep"]);
    }),
);

effectIt.effect(
  "a guess on his partial words reaches the Record only once the loop says it played; an unplayed one never does",
  () =>
    Effect.gen(function* () {
      let recorded: Array<string> = [];
      const brain = R1Brain.of({
        route: Effect.succeed("api"),
        subscription: () => Stream.empty,
        warm: () => Effect.void,
        session: () => Stream.empty,
        converse: (turn) =>
          toolLoop(
            () => Stream.make<Array<ConversePart>>({ type: "text", text: "It's four PM." }),
            turn,
          ),
      });
      const home = Layer.mock(HomeAssistantService)({
        devices: Effect.succeed([]),
        status: Effect.succeed({ state: "connected", line: "" } as never),
        actions: () => Effect.succeed([]),
        find: () => Effect.succeed([]),
        timeZone: Effect.succeed("Asia/Karachi"),
      });
      const record = Layer.mock(BatonRecordService)({
        append: (entry: { readonly detail?: string }) =>
          Effect.sync(() => {
            recorded = [...recorded, entry.detail ?? ""];
          }) as never,
      });
      const services = Layer.mergeAll(home, record, Layer.mock(BatonOneShot)({}));
      const guess = (callId: string) =>
        r1TurnStream(
          { heard: "what time is it", history: [], voice: { speculative: true, callId } },
          brain,
          { specs: [], run: () => Effect.die("no tools") },
        ).pipe(Stream.runDrain, Effect.provide(services));
      yield* guess("kept");
      yield* guess("dropped");
      expect(recorded).toEqual([]);
      expect(yield* r1Played("kept").pipe(Effect.provide(services))).toBe(true);
      expect(recorded).toEqual(["It's four PM."]);
      // Played once only; the guess the loop threw away is never written.
      expect(yield* r1Played("kept").pipe(Effect.provide(services))).toBe(false);
      expect(recorded).toEqual(["It's four PM."]);
      // His final turn (no guess) is written as it ends, as before.
      yield* r1TurnStream({ heard: "what time is it", history: [] }, brain, {
        specs: [],
        run: () => Effect.die("no tools"),
      }).pipe(Stream.runDrain, Effect.provide(services));
      expect(recorded).toHaveLength(2);
    }),
);

effectIt.effect(
  "a guess's house change waits for his final words: confirmed it runs, never confirmed it never does, a read never waits",
  () =>
    Effect.gen(function* () {
      const ran: Array<string> = [];
      // Round one finds the fan (a read), round two turns it off (a write), round three speaks.
      const brain = R1Brain.of({
        route: Effect.succeed("api"),
        subscription: () => Stream.empty,
        warm: () => Effect.void,
        session: () => Stream.empty,
        converse: (turn) =>
          toolLoop(
            (request: ConverseRequest) =>
              Stream.make<Array<ConversePart>>(
                request.messages.length === 1
                  ? { type: "tool", id: "t1", name: "home_find", input: {} }
                  : request.messages.length === 3
                    ? { type: "tool", id: "t2", name: "home_do", input: {} }
                    : { type: "text", text: "Done." },
              ),
            turn,
          ),
      });
      const tools = {
        specs: [],
        run: (name: string) =>
          Effect.sync(() => {
            ran.push(name);
            return { text: "done", isError: false, status: "done" };
          }),
      };
      const home = Layer.mock(HomeAssistantService)({
        devices: Effect.succeed([]),
        status: Effect.succeed({ state: "connected", line: "" } as never),
        actions: () => Effect.succeed([]),
        find: () => Effect.succeed([]),
        timeZone: Effect.succeed("Asia/Karachi"),
      });
      const services = Layer.mergeAll(
        home,
        Layer.mock(BatonRecordService)({ append: () => Effect.void as never }),
        Layer.mock(BatonOneShot)({}),
      );
      const turn = (voice?: object) =>
        r1TurnStream({ heard: "turn off the fan", history: [], voice }, brain, tools).pipe(
          Stream.runDrain,
          Effect.provide(services),
          Effect.forkChild,
        );

      // Never confirmed (his final words were different): the read ran, the write never does.
      const unconfirmed = yield* turn({ speculative: true, callId: "g1" });
      yield* TestClock.adjust("20 seconds");
      yield* Fiber.join(unconfirmed);
      // The turn's own reads of his work (what needs him, what is in flight) come first; then the model's.
      expect(ran.filter((name) => name.startsWith("home_"))).toEqual(["home_find"]);

      // Confirmed while it waits: the write goes ahead.
      ran.length = 0;
      const confirmed = yield* turn({ speculative: true, callId: "g2" });
      yield* TestClock.adjust("1 second");
      // The turn's own reads of his work (what needs him, what is in flight) come first; then the model's.
      expect(ran.filter((name) => name.startsWith("home_"))).toEqual(["home_find"]);
      yield* r1Confirmed("g2");
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(confirmed);
      expect(ran.filter((name) => name.startsWith("home_"))).toEqual(["home_find", "home_do"]);

      // His final turn (no guess) never waits.
      ran.length = 0;
      const final = yield* turn();
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(final);
      expect(ran.filter((name) => name.startsWith("home_"))).toEqual(["home_find", "home_do"]);
    }),
);

describe("asking his laptop", () => {
  const at = DateTime.makeUnsafe("2026-11-12T00:00:00.000Z");
  const laptop: PeerLinkSummary = {
    environmentId: EnvironmentId.make("laptop"),
    label: "laptop",
    urls: ["https://laptop.example"],
    access: "full-access",
    linkedAt: at,
    expiresAt: at,
    lastReachedAt: null,
    lastError: null,
    status: "reachable",
  };
  /** A linked laptop whose Tessaya answers `tessaya_ask` with `asked` and its status with `answer`. */
  const linked = (
    links: ReadonlyArray<PeerLinkSummary>,
    asked: object,
    answer: object,
    beforeOrigin = false,
  ) => {
    const calls: Array<string> = [];
    const provide = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        // A laptop act never reaches the house.
        Effect.provideService(HomeAssistantService, {} as never),
        Effect.provideService(
          PeerLinks.PeerLinks,
          PeerLinks.PeerLinks.of({
            enabled: Effect.succeed(true),
            list: Effect.succeed(links),
          } as never),
        ),
        Effect.provideService(
          PeerMcpClient.PeerMcpClient,
          PeerMcpClient.PeerMcpClient.of({
            call: (input) => {
              const { origin, hisVoice } = input.arguments as {
                origin?: string;
                hisVoice?: boolean;
              };
              calls.push(
                `${origin === undefined ? input.tool : `${input.tool} from ${origin}`}${hisVoice === true ? " in his voice" : ""}`,
              );
              // A laptop before the origin field refuses an argument it does not list.
              if (beforeOrigin && origin !== undefined)
                return Effect.fail({ message: 'Unknown argument "origin".' } as never);
              return Effect.succeed((input.tool === "tessaya_ask" ? asked : answer) as never);
            },
          }),
        ),
      );
    return { calls, provide };
  };
  const look = splitActs(
    'ACTS [{"tool":"laptop_ask","args":{"question":"what is on my laptop"}}]\nLet me look.',
  )!.acts;

  effectIt.effect("speaks the laptop's own answer, not her guess", () =>
    Effect.gen(function* () {
      const fake = linked(
        [laptop],
        { id: "mcp-x-1", status: "queued", line: "Waiting." },
        { id: "mcp-x-1", status: "answered", line: "VS Code and Chrome are open." },
      );
      const outcomes = yield* fake.provide(runActs(look));
      // Asked as from his R1, so the laptop's approval names it (13 Nov).
      expect(fake.calls).toEqual(["tessaya_ask from Tessel", "tessaya_ask_status"]);
      expect(spokenReply("Let me look.", outcomes)).toBe("VS Code and Chrome are open.");
      const older = linked(
        [laptop],
        { id: "mcp-x-1", status: "queued", line: "Waiting." },
        { id: "mcp-x-1", status: "answered", line: "VS Code is open." },
        true,
      );
      expect(spokenReply("Let me look.", yield* older.provide(runActs(look)))).toBe(
        "VS Code is open.",
      );
      expect(older.calls).toEqual(["tessaya_ask from Tessel", "tessaya_ask", "tessaya_ask_status"]);
      // The turn's own vessel (TurnOrigin) names it when the pipeline gives one.
      const named = linked(
        [laptop],
        { id: "mcp-x-1", status: "queued", line: "Waiting." },
        { id: "mcp-x-1", status: "answered", line: "Chrome." },
      );
      yield* named.provide(
        runActs(look).pipe(
          Effect.provideService(TurnOrigin, {
            kind: "device",
            id: "r1-3d57b3",
            label: "the kitchen R1",
            hisVoice: false,
            speaker: null,
            persona: null,
            rehearsal: false,
          }),
        ),
      );
      expect(named.calls[0]).toBe("tessaya_ask from the kitchen R1");
      // His verified voice on that turn is his yes for the laptop's look (Director, 13 Nov).
      const his = linked(
        [laptop],
        { id: "mcp-x-1", status: "queued", line: "Waiting." },
        { id: "mcp-x-1", status: "answered", line: "Chrome." },
      );
      yield* his.provide(
        runActs(look).pipe(
          Effect.provideService(TurnOrigin, {
            kind: "device",
            id: "r1-3d57b3",
            label: "R1",
            hisVoice: true,
          }),
        ),
      );
      expect(his.calls[0]).toBe("tessaya_ask from R1 in his voice");
    }),
  );

  effectIt.effect("says plainly when no laptop is linked or Tessaya is not open there", () =>
    Effect.gen(function* () {
      const none = linked([], {}, {});
      expect(spokenReply("It shows Chrome.", yield* none.provide(runActs(look)))).toBe(
        "I couldn't: your laptop isn't linked to this server, so I can't see it.",
      );
      expect(none.calls).toEqual([]);
      const closed = linked(
        [laptop],
        { id: null, status: "not asked", line: BAR_NOT_CONNECTED },
        {},
      );
      expect(spokenReply("It shows Chrome.", yield* closed.provide(runActs(look)))).toBe(
        "I couldn't: Tessaya isn't open on your laptop, so I can't see it.",
      );
    }),
  );
});

const voiceOf = (speaker: Partial<SpeakerLike>) => ({
  speaker: { kind: "owner", personId: "owner", verified: true, inherited: false, ...speaker },
});

effectIt.effect(
  "takes a picture at once for his verified voice, and sends anyone else's to his phone",
  () =>
    Effect.gen(function* () {
      const asked: Array<DeviceActor> = [];
      const devices = Layer.mock(HomeDevices)({
        command: (_id, _c, by) =>
          Effect.sync(() => {
            asked.push(by);
            return by.approved === true
              ? { status: "done" as const, line: "Taking one picture." }
              : { status: "asked" as const, line: "Sent to the Director's phone for a yes." };
          }),
        cameraView: () =>
          Effect.succeed({
            at: "2026-11-12T00:00:00.000Z",
            dataUrl: "data:image/jpeg;base64,AAAA",
          }),
      });
      const device = { deviceId: "r1-test", mqttUrl: null } as unknown as R1Device;
      const look = (voice: unknown) => roomLook(device, voice).pipe(Effect.provide(devices));
      const theirs = yield* look(voiceOf({ verified: false }));
      expect([theirs.status, theirs.image]).toEqual(["asked", undefined]);
      const his = yield* look(voiceOf({}));
      expect(his.image).toEqual({ mediaType: "image/jpeg", data: "AAAA" });
      expect(asked.map((by) => by.approved === true)).toEqual([false, true]);
    }),
);

effectIt.effect("a replay turn never reaches his real R1's eyes; his own turn does", () =>
  Effect.gen(function* () {
    let read = 0;
    const real = { deviceId: "r1-his", mqttUrl: null } as unknown as R1Device;
    const home = Layer.mock(HomeAssistantService)({
      devices: Effect.sync(() => {
        read += 1;
        return [real];
      }),
      status: Effect.succeed({ state: "connected", line: "" } as never),
      actions: () => Effect.succeed([]),
      timeZone: Effect.succeed("Asia/Karachi"),
    });
    const gather = (device: string) =>
      r1Gather({ heard: "test of dictation", history: [], device }, false).pipe(
        Effect.provide(home),
      );
    expect((yield* gather("replay-3")).device).toBeNull();
    expect(read).toBe(0);
    expect((yield* gather("r1-his")).device).toBe(real);
  }),
);

describe("several people in one turn", () => {
  it("names each person in speaking order with their own preferences, and says how to answer them", () => {
    const lines = peopleLines([
      { name: "Sara", said: "how hot is it", preferences: { units: "metric" } },
      { name: null, said: "start a timer", preferences: {} },
    ]);
    expect(lines[0]).toContain('"person":"Sara"');
    expect(lines[0]!.indexOf("Sara")).toBeLessThan(lines[0]!.indexOf("person 2"));
    expect(lines[0]).toContain('"prefers":{"units":"metric"}');
    expect(lines[1]).toContain("one at a time");
    expect(peopleLines([{ name: "Sara", said: "hi", preferences: {} }])).toEqual([]);
  });
});

describe("the house read before a turn", () => {
  it("keeps only devices his words name, so a sentence about him puts no device in view", () => {
    const ai = {
      entityId: "conversation.google_generative_ai",
      name: "Google Generative AI",
      area: null,
    };
    const ramadan = {
      entityId: "binary_sensor.nahaj_ramadan",
      name: "Nahaj Ramadan month",
      area: null,
    };
    const lamp = { entityId: "light.desk_lamp", name: "Desk Lamp", area: "Study" };
    for (const d of [ai, ramadan, lamp]) expect(namedIn(d, "Call me Rab from now on.")).toBe(false);
    expect(namedIn(lamp, "Turn on the study lamp")).toBe(true);
    expect(namedIn(lamp, "Turn the lights off")).toBe(true);
    expect(namedIn(ramadan, "Is it Ramadan yet?")).toBe(true);
  });
});

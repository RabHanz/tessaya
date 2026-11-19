import { TessayaTurn, TurnOrigin, moodMember, notLearnable } from "../tessaya/TessayaTurn.ts";
import * as Clock from "effect/Clock";
import { OWNER_MEMBER_ID } from "@t3tools/tessaya-shared/household";
import { it as effectIt } from "@effect/vitest";
import { BAR_NOT_CONNECTED } from "@t3tools/tessaya-shared/phoneRelay";
import { EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { SpeakerLike } from "@t3tools/tessaya-shared/privateMemory";
import { DEFAULT_OS_PACK } from "@t3tools/tessaya-shared/osPack";
import { REST_MARK } from "@t3tools/tessaya-shared/stopPhrases";
import { describe, expect, it } from "vite-plus/test";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { HomeAssistantService, type R1Device } from "./HomeAssistantService.ts";
import { DeviceRefusedError } from "./DeviceRegistry.ts";
import { HomeDevices, type DeviceActor } from "./HomeDevices.ts";
import { TessayaRecordService } from "../tessaya/TessayaRecordService.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { TessayaOneShot } from "../tessaya/TessayaOneShot.ts";
import * as CurrentPersona from "../tessaya/CurrentPersona.ts";
import { groupConversation } from "../tessaya/GroupTalk.ts";
import { R1Brain, R1BrainError, toolLoop, type ToolTurn } from "./R1Brain.ts";
import { sessionTools, speakableSentences } from "../tessaya/TessayaBrain.ts";
import { PersonaLayers, type LayerTurn } from "../tessaya/PersonaLayers.ts";
import type { ConversePart, ConverseRequest } from "../speech/DictationCleanupApi.ts";
import {
  calledPersona,
  dictionaryEntries,
  limitResets,
  r1Data,
  r1Envelope,
  r1Gather,
  peopleLines,
  namedIn,
  r1Confirmed,
  LOOK,
  r1Played,
  r1TurnStream,
  roomData,
  roomLook,
  runActs,
  splitActs,
  spokenReply,
  sseReply,
  switchedPersona,
  turnFace,
  withoutNarration,
  withoutSelfIntros,
  type R1Context,
  contextCleaned,
  tesselWishTick,
} from "./R1Device.ts";
import { R1Hub } from "./R1Hub.ts";
import { TessayaMood } from "../tessaya/TessayaMood.ts";
import { noteTesselHandled } from "../tessaya/TessayaBody.ts";
import { onAction } from "../provenance/ActionLog.ts";
import { DictationCleanupApi } from "../speech/DictationCleanupApi.ts";

describe("R1Device", () => {
  it("believes a guest's voiceprint only from the device whose key the call came with", () => {
    const print = { model: "m", vector: "AAAAAA==", ms: 3_000 };
    const heard = {
      heard: "hi",
      history: [],
      device: "r1-a",
      voice: {
        speaker: { kind: "guest", personId: null, verified: false, inherited: false, print },
      },
    };
    expect(r1Envelope({ ...heard, signed: true }, DEFAULT_OS_PACK, undefined).print).toEqual(print);
    expect(
      r1Envelope({ ...heard, signed: false }, DEFAULT_OS_PACK, undefined).print,
    ).toBeUndefined();
    expect(
      r1Envelope({ ...heard, signed: true }, DEFAULT_OS_PACK, undefined).speaker,
    ).not.toHaveProperty("print");
  });

  it("answers our test playback and the trusted test clone as a rehearsal, so nothing learns from them", () => {
    const heard = { heard: "what is the capital of Japan", history: [], device: "r1-a" };
    const owner = { kind: "owner", personId: "owner", verified: true, inherited: false };
    const live = r1Envelope({ ...heard, voice: { speaker: owner } }, DEFAULT_OS_PACK, undefined);
    expect(notLearnable(live)).toBeNull();
    // voice ID is the guard: a voice only near his, carried over or lifted by his session, never teaches his memory
    for (const near of [
      { ...owner, verified: false },
      { ...owner, verified: false, inherited: true },
      { ...owner, verified: false, lifted: true },
    ]) {
      const turn = r1Envelope({ ...heard, voice: { speaker: near } }, DEFAULT_OS_PACK, undefined);
      expect(notLearnable(turn), JSON.stringify(near)).toBe("his voice not verified");
      expect(moodMember(turn)).toBeNull();
    }
    for (const voice of [
      { speaker: owner, playback: "run1" },
      { speaker: { ...owner, test: true } },
    ]) {
      const turn = r1Envelope({ ...heard, voice }, DEFAULT_OS_PACK, undefined);
      expect(turn.rehearsal).toBe(true);
      expect(notLearnable(turn)).toBe("a rehearsal");
      expect(moodMember(turn)).toBeNull();
    }
  });

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

it("fixes his names in what the room heard, from the shared dictionary, as dictation does", async () => {
  const { biasTranscript } = await import("@t3tools/tessaya-shared/vocabulary");
  const entries = dictionaryEntries([
    { term: "Tessaya", aliases: ["Tezaya"] },
    { term: "AcmeCloud", aliases: [] },
  ]);
  expect(biasTranscript("Ask Tezaya about Acme Cloud", entries)).toBe(
    "Ask Tessaya about AcmeCloud",
  );
});

it("answers as the persona he called by name, and as Tessaya for her own name or an unknown one", async () => {
  const { DEFAULT_OS_PACK } = await import("@t3tools/tessaya-shared/osPack");
  expect(calledPersona(DEFAULT_OS_PACK, { persona: "butler" })?.name).toBe("Alfred");
  expect(calledPersona(DEFAULT_OS_PACK, { persona: "executive" })).toBeNull();
  expect(calledPersona(DEFAULT_OS_PACK, { persona: "nobody" })).toBeNull();
  expect(calledPersona(DEFAULT_OS_PACK, undefined)).toBeNull();
});

describe('who answers in the room (13 Nov audit: every reply opened with "Sebastian here.")', () => {
  const context = async (switched: boolean): Promise<R1Context> => {
    const { DEFAULT_OS_PACK } = await import("@t3tools/tessaya-shared/osPack");
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
    // The last one ends with a space as well: the R1's loop speaks a sentence once one follows it (14 Nov, 21:40).
    expect(said.join("")).toBe("Got it, nothing else is waiting on you. ");
  });

  it("sends her first clause before its sentence ends, then whole sentences", () => {
    const said: Array<string> = [];
    const s = speakableSentences((sentence) => said.push(sentence));
    s.push("The office fan is on, and the");
    expect(said).toEqual(["The office fan is on, "]);
    s.push(" lamp too. It's warm, so I left it.");
    s.flush();
    expect(said).toEqual([
      "The office fan is on, ",
      "and the lamp too. ",
      "It's warm, so I left it. ",
    ]);
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
    expect(said.join("")).toBe("Nothing needs you. ");
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
      const record = Layer.mock(TessayaRecordService)({
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
        Effect.provide(Layer.mergeAll(home, record, Layer.mock(TessayaOneShot)({}))),
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
  "a persona layer that answers takes the Tessel's whole turn: no brain, no house act, nothing in the Record",
  () =>
    Effect.gen(function* () {
      const touched: Array<string> = [];
      const brain = R1Brain.of({
        route: Effect.succeed("subscription"),
        subscription: () => Stream.empty,
        warm: () => Effect.void,
        converse: () => Stream.empty,
        session: () => Stream.suspend(() => (touched.push("brain"), Stream.make("no"))),
      });
      const home = Layer.mock(HomeAssistantService)({
        devices: Effect.sync(() => (touched.push("house"), [])),
      });
      const record = Layer.mock(TessayaRecordService)({
        append: () => Effect.sync(() => touched.push("record")) as never,
      });
      const said = yield* r1TurnStream({ heard: "hello", history: [], device: "bedroom" }, brain, {
        specs: [],
        run: () => Effect.succeed({ text: "", isError: false }),
      }).pipe(
        Stream.runCollect,
        Effect.provide(
          Layer.mergeAll(
            home,
            record,
            Layer.mock(TessayaOneShot)({}),
            Layer.succeed(PersonaLayers, {
              all: [
                {
                  id: "test",
                  onTurn: async (t) =>
                    t.vessel.id === "bedroom"
                      ? { text: "Only the layer.", mood: "happy", gesture: "none", intensity: 0.5 }
                      : null,
                  signal: () => undefined,
                  http: async () => ({ status: 404 }),
                },
              ],
            }),
          ),
        ),
      );
      expect([...said].join("")).toBe("Only the layer.");
      // Only the Tessel list, for her eyes to follow her: no brain, no house act, no Record.
      expect(touched).toEqual(["house"]);
    }),
);

effectIt.effect(
  "the house matching his words and what needs him are in the model's message before it starts, unless a read is slow",
  () =>
    Effect.gen(function* () {
      let sent = "";
      let offered: Array<string> = [];
      const brain = R1Brain.of({
        route: Effect.succeed("subscription"),
        subscription: () => Stream.empty,
        warm: () => Effect.void,
        converse: () => Stream.empty,
        session: (turn) =>
          Stream.suspend(() => {
            sent = turn.user;
            offered = turn.tools.map((t) => t.name);
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
      const record = Layer.mock(TessayaRecordService)({ append: () => Effect.void as never });
      yield* r1TurnStream({ heard: "is the study lamp on?", history: [] }, brain, {
        specs: [],
        run: (name) =>
          Effect.succeed({
            text: name === "tessaya_watch" ? '{"findings":[]}' : '{"threads":[]}',
            isError: false,
          }),
      }).pipe(
        Stream.runDrain,
        Effect.provide(Layer.mergeAll(home, record, Layer.mock(TessayaOneShot)({}))),
      );
      expect(sent).toMatch(
        /In the house matching his words, live as of this turn: .*light\.desk_lamp.*"on"/,
      );
      expect(sent).toMatch(
        /What needs him \(tessaya_watch\), live as of this turn: \{"findings":\[\]\}/,
      );
      expect(sent).toMatch(/tessaya_work_now\), live as of this turn: \{"threads":\[\]\}/);
      // The R1's warm sessions start with this list: any other and his first turn finds none warm (14 Nov, 20:44).
      expect(offered).toEqual(sessionTools([], [LOOK]).map((t) => t.name));

      // A read of his work that hangs is left out at its deadline; the model is not kept waiting (14 Nov, 21:40).
      sent = "";
      const slow = yield* r1TurnStream({ heard: "is the study lamp on?", history: [] }, brain, {
        specs: [],
        run: (name) =>
          name === "tessaya_watch"
            ? Effect.never
            : Effect.succeed({ text: '{"threads":[]}', isError: false }),
      }).pipe(
        Stream.runDrain,
        Effect.provide(Layer.mergeAll(home, record, Layer.mock(TessayaOneShot)({}))),
        Effect.forkChild,
      );
      yield* TestClock.adjust("300 millis");
      yield* Fiber.join(slow);
      expect(sent).not.toMatch(/tessaya_watch/);
      expect(sent).toMatch(/tessaya_work_now\), live as of this turn/);

      // The next turn on the same tools uses the read the slow one finished, without waiting on its own (15 Nov).
      let watchReads = 0;
      const lateTools = {
        specs: [],
        run: (name: string) =>
          name === "tessaya_watch" && watchReads++ === 0
            ? Effect.succeed({ text: '{"findings":["late"]}', isError: false }).pipe(
                Effect.delay("1 second"),
              )
            : name === "tessaya_watch"
              ? Effect.never
              : Effect.succeed({ text: '{"threads":[]}', isError: false }),
      };
      const turnOn = (toolSet: typeof lateTools) =>
        r1TurnStream({ heard: "is the study lamp on?", history: [] }, brain, toolSet).pipe(
          Stream.runDrain,
          Effect.provide(Layer.mergeAll(home, record, Layer.mock(TessayaOneShot)({}))),
          Effect.forkChild,
        );
      const first = yield* turnOn(lateTools);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(first);
      expect(sent).not.toMatch(/tessaya_watch/);
      yield* Fiber.join(yield* turnOn(lateTools));
      expect(sent).toMatch(
        /What needs him \(tessaya_watch\), live as of this turn: \{"findings":\["late"\]\}/,
      );
      // Past 30 s that read is too old: a hanging one leaves the line out again.
      yield* TestClock.adjust("31 seconds");
      const stale = yield* turnOn(lateTools);
      yield* TestClock.adjust("300 millis");
      yield* Fiber.join(stale);
      expect(sent).not.toMatch(/tessaya_watch/);
    }),
);

effectIt.effect(
  "the model's conversation_end rests the room after her goodbye, said at once, a goodbye of no words too (18 Nov)",
  () =>
    Effect.gen(function* () {
      let goodbye = "";
      let args = {};
      let slow = false;
      const brain = R1Brain.of({
        route: Effect.succeed("subscription"),
        subscription: () => Stream.empty,
        warm: () => Effect.void,
        converse: () => Stream.empty,
        // Her goodbye, the call, then a second goodbye the model wrote after it.
        session: (turn) =>
          Stream.concat(
            Stream.make(goodbye),
            Stream.unwrap(
              Effect.map(turn.run("conversation_end", args), () =>
                slow
                  ? Stream.fromEffect(Effect.as(Effect.sleep("4 seconds"), "Goodnight again."))
                  : Stream.make("Goodnight again."),
              ),
            ),
          ),
      });
      const home = Layer.mock(HomeAssistantService)({
        devices: Effect.succeed([]),
        status: Effect.succeed({ state: "connected", line: "" } as never),
        actions: () => Effect.succeed([]),
        find: () => Effect.succeed([] as never),
        timeZone: Effect.succeed("Asia/Karachi"),
      });
      const record = Layer.mock(TessayaRecordService)({ append: () => Effect.void as never });
      const turn = () =>
        r1TurnStream({ heard: "we're done for now", history: [] }, brain, {
          specs: [],
          run: () => Effect.succeed({ text: "{}", isError: false }),
        }).pipe(
          Stream.runCollect,
          Effect.map((said) => [...said].join("")),
          Effect.provide(Layer.mergeAll(home, record, Layer.mock(TessayaOneShot)({}))),
        );
      goodbye = "Goodnight.";
      expect(yield* turn()).toBe(`Goodnight. ${REST_MARK}`);
      goodbye = "";
      expect(yield* turn()).toBe(`Goodnight again. ${REST_MARK}`);
      // The goodbye in the call is said at once; what the model writes after it is not.
      args = { goodbye: "Sleep well." };
      expect(yield* turn()).toBe(`Sleep well. ${REST_MARK}`);
      // A silent end, then a slow pass that writes the goodbye: no "One moment." before it (.189 room gate).
      args = {};
      slow = true;
      const late = yield* Effect.forkChild(turn());
      yield* TestClock.adjust("5 seconds");
      expect(yield* Fiber.join(late)).toBe(`Goodnight again. ${REST_MARK}`);
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
      const record = Layer.mock(TessayaRecordService)({ append: () => Effect.void as never });
      const said = yield* r1TurnStream({ heard: "what time is it?", history: [] }, brain, {
        specs: [],
        run: () => Effect.succeed({ text: "{}", isError: false }),
      }).pipe(
        Stream.runCollect,
        Effect.provide(Layer.mergeAll(home, record, Layer.mock(TessayaOneShot)({}))),
      );
      expect(said.join("")).toBe(
        "My accounts are out of capacity until Nov 16, 6pm, so I can't think that through now.",
      );
      expect(acts).toBe(0);
    }),
);

effectIt.effect(
  "a route that fails after her first words ends the turn: no other route says the answer again",
  () =>
    Effect.gen(function* () {
      let acts = 0;
      const answer = "I can't see a cause. Two sessions are working, nothing is stuck.";
      const brain = R1Brain.of({
        route: Effect.succeed("subscription"),
        subscription: () => {
          acts += 1;
          return Stream.make(answer);
        },
        warm: () => Effect.void,
        converse: () => Stream.empty,
        session: () =>
          Stream.concat(
            Stream.make(`${answer} `),
            Stream.fail(new R1BrainError({ detail: "claude exited before answering" })),
          ),
      });
      const home = Layer.mock(HomeAssistantService)({
        devices: Effect.succeed([]),
        status: Effect.succeed({ state: "connected", line: "" } as never),
        actions: () => Effect.succeed([]),
        find: () => Effect.succeed([] as never),
        timeZone: Effect.succeed("Asia/Karachi"),
      });
      const record = Layer.mock(TessayaRecordService)({ append: () => Effect.void as never });
      const said = yield* r1TurnStream({ heard: "why is everything slow?", history: [] }, brain, {
        specs: [],
        run: () => Effect.succeed({ text: "{}", isError: false }),
      }).pipe(
        Stream.runCollect,
        Effect.provide(Layer.mergeAll(home, record, Layer.mock(TessayaOneShot)({}))),
      );
      expect(said.join("").split("I can't see a cause.").length - 1).toBe(1);
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
      const record = Layer.mock(TessayaRecordService)({
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
        Effect.provide(Layer.mergeAll(home, record, Layer.mock(TessayaOneShot)({}))),
      );
      // No line of her own for it, so no fixed one either (B-056: "Let me look that up." on every search).
      expect(said.join("")).toBe("It is 23 degrees and hazy. ");
      expect(details).toEqual(["It is 23 degrees and hazy."]);
    }),
);

effectIt.effect(
  "a tool before her first word gets no stock line, and her own words before it are a sentence of their own",
  () =>
    Effect.gen(function* () {
      const said: Array<string> = [];
      const brain = R1Brain.of({
        route: Effect.succeed("subscription"),
        subscription: () => Stream.empty,
        warm: () => Effect.void,
        converse: () => Stream.empty,
        session: (turn) =>
          Stream.concat(
            Stream.suspend(() => {
              // "Where is he?" answered "Patience, it's coming." first (18 Nov): a tool start says nothing itself.
              turn.cue(false);
              return Stream.make("Let me find him.");
            }),
            Stream.fromEffect(turn.run("tessaya_cast", {}).pipe(Effect.as("He's on the desktop."))),
          ),
      });
      const home = Layer.mock(HomeAssistantService)({
        devices: Effect.succeed([]),
        status: Effect.succeed({ state: "connected", line: "" } as never),
        actions: () => Effect.succeed([]),
        find: () => Effect.succeed([]),
        timeZone: Effect.succeed("Asia/Karachi"),
      });
      yield* r1TurnStream({ heard: "where is he?", history: [] }, brain, {
        specs: [],
        run: () => Effect.succeed({ text: "", isError: false }),
      }).pipe(
        Stream.runForEach((words) => Effect.sync(() => said.push(words))),
        Effect.provide(
          Layer.mergeAll(
            home,
            Layer.mock(TessayaRecordService)({ append: () => Effect.void as never }),
            Layer.mock(TessayaOneShot)({}),
          ),
        ),
      );
      // Held until the tool answered, it ran into the answer as one sentence ("Let me find him.He's on…").
      expect(said).toEqual(["Let me find him. ", "He's on the desktop. "]);
    }),
);

effectIt.effect(
  "she says nothing while she thinks, on a quick turn or a slow one: only her answer",
  () =>
    Effect.gen(function* () {
      // Director, 19 Nov 06:20: "the filler words are really out of place… most times it breaks the flow".
      const brain = (answerAfterMs: number) =>
        R1Brain.of({
          route: Effect.succeed("subscription"),
          subscription: () => Stream.empty,
          warm: () => Effect.void,
          converse: () => Stream.empty,
          session: (turn) =>
            Stream.unwrap(
              Effect.sleep(answerAfterMs).pipe(
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
      const turn = (heard: string, answerAfterMs: number, device: string) =>
        Effect.gen(function* () {
          const said: Array<string> = [];
          const running = yield* r1TurnStream(
            { heard, history: [], device },
            brain(answerAfterMs),
            {
              specs: [],
              run: () => Effect.succeed({ text: "", isError: false }),
            },
          ).pipe(
            Stream.runForEach((words) => Effect.sync(() => said.push(words))),
            Effect.provide(
              Layer.mergeAll(
                home,
                Layer.mock(TessayaRecordService)({ append: () => Effect.void as never }),
                Layer.mock(TessayaOneShot)({}),
              ),
            ),
            Effect.forkChild,
          );
          yield* TestClock.adjust("10 seconds");
          yield* Fiber.join(running);
          return said.join("");
        });
      // Silence while she thinks, however long, and a late tool start says nothing either: only her answer.
      expect(yield* turn("did I answer that request of mine?", 4_000, "replay-a")).toBe("Done. ");
      expect(yield* turn("why are my agents taking so long today?", 9_000, "replay-b")).toBe(
        "Done. ",
      );
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
      const record = Layer.mock(TessayaRecordService)({ append: () => Effect.void as never });
      const turn = (heard: string) => {
        const said: Array<string> = [];
        return r1TurnStream(
          { heard, history: [], voice: { conversation: "escalation-test" } },
          brain,
          { specs: [], run: () => Effect.succeed({ text: "", isError: false }) },
        ).pipe(
          Stream.runForEach((words) => Effect.sync(() => said.push(words))),
          Effect.provide(Layer.mergeAll(home, record, Layer.mock(TessayaOneShot)({}))),
          Effect.map(() => said.join("")),
        );
      };
      expect(yield* turn("plan my week around the launch")).toBe("Want Opus on it? ");
      expect(yield* turn("yes, go on")).toBe("Putting Opus on this. Here is the plan. ");
      expect(sent.map((s) => s.role)).toEqual(["voice", "voice", "deep"]);
      expect(sent[2]!.user).toContain('because: "his week"');
    }),
);

effectIt.effect(
  "his rule for Opus is in the turn's note, and the task it covers goes straight there, on his key as on his subscription",
  () =>
    Effect.forEach(["subscription", "api"] as const, (way) =>
      Effect.gen(function* () {
        const roles: Array<string> = [];
        const voiceTurn = (turn: ToolTurn & { readonly role?: string }) =>
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
          );
        const brain = R1Brain.of({
          route: Effect.succeed(way),
          subscription: () => Stream.empty,
          warm: () => Effect.void,
          converse: (turn) => (way === "api" ? voiceTurn(turn) : Stream.empty),
          session: (turn) =>
            way === "api" && turn.role !== "deep" ? Stream.empty : voiceTurn(turn),
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
              Layer.mock(TessayaRecordService)({ append: () => Effect.void as never }),
              Layer.mock(TessayaOneShot)({}),
              ServerSettingsService.layerTest({
                brainEscalation: { rules: [{ when: "coding questions", then: "opus" }] },
              }),
            ),
          ),
        );
        expect(said.join("")).toBe("Putting Opus on this. Use backoff. ");
        expect(roles).toEqual(["voice", "deep"]);
      }),
    ),
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
      const record = Layer.mock(TessayaRecordService)({
        append: (entry: { readonly detail?: string }) =>
          Effect.sync(() => {
            recorded = [...recorded, entry.detail ?? ""];
          }) as never,
      });
      const services = Layer.mergeAll(home, record, Layer.mock(TessayaOneShot)({}));
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
  "a group answers on the Tessel: each speaker marked before its own words, and a guess records every speaker once played (M-021)",
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
            (request) =>
              Stream.make<Array<ConversePart>>({
                type: "text",
                text: `Agreed (${/you \((\w+)\)/.exec(JSON.stringify(request))?.[1] ?? "nobody"}).`,
              }),
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
      const record = Layer.mock(TessayaRecordService)({
        append: (entry: { readonly detail?: string }) =>
          Effect.sync(() => {
            recorded = [...recorded, entry.detail ?? ""];
          }) as never,
      });
      // each speaker's layer turn carries its place in the group and the group's note
      const asked: Array<{ first: boolean; note: string } | undefined> = [];
      const probe = Layer.succeed(PersonaLayers, {
        all: [
          {
            id: "probe",
            onTurn: async (t: LayerTurn) => (asked.push(t.group), null),
            signal: () => undefined,
            http: async () => ({ status: 404 }),
          },
        ],
      });
      const services = Layer.mergeAll(
        home,
        record,
        Layer.mock(TessayaOneShot)({}),
        CurrentPersona.layer,
        probe,
      );
      const heard = {
        heard: "Alfred and Freya, what do you think?",
        history: [],
        voice: { speculative: true, callId: "group" },
      };
      const said = yield* Effect.gen(function* () {
        const current = yield* CurrentPersona.CurrentPersona;
        yield* current.setGroup(
          groupConversation(r1Envelope(heard, DEFAULT_OS_PACK, undefined), false),
          { mode: "answer", members: [{ id: "butler" }, { id: "companion" }] },
        );
        const said = yield* r1TurnStream(heard, brain, {
          specs: [],
          run: () => Effect.die("no tools"),
        }).pipe(Stream.runCollect);
        yield* r1Played("group");
        return said;
      }).pipe(Effect.provide(services));
      expect([...said].join("")).toBe("[as:butler]Agreed (Alfred). [as:companion]Agreed (Freya). ");
      expect(recorded).toEqual(["Agreed (Alfred).", "Agreed (Freya)."]);
      expect(asked.map((g) => g?.first)).toEqual([true, false]);
      expect(asked[1]?.note).toContain("Agreed (Alfred).");
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
        Layer.mock(TessayaRecordService)({ append: () => Effect.void as never }),
        Layer.mock(TessayaOneShot)({}),
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

effectIt.effect(
  "takes the picture through the server whose hub she is on when his turn runs on another (19 Nov topology gate)",
  () =>
    Effect.gen(function* () {
      const tools: Array<string> = [];
      const device = { deviceId: "r1-test", mqttUrl: null } as unknown as R1Device;
      const hub = {
        ...({} as PeerLinkSummary),
        environmentId: EnvironmentId.make("hub"),
        label: "home",
        status: "reachable" as const,
      };
      const shot = yield* roomLook(device, voiceOf({})).pipe(
        Effect.provide(
          Layer.mock(HomeDevices)({
            command: () =>
              Effect.fail(new DeviceRefusedError({ why: "Not on this hub.", notLinked: true })),
          }),
        ),
        Effect.provideService(
          PeerLinks.PeerLinks,
          PeerLinks.PeerLinks.of({
            enabled: Effect.succeed(true),
            list: Effect.succeed([hub]),
          } as never),
        ),
        Effect.provideService(
          PeerMcpClient.PeerMcpClient,
          PeerMcpClient.PeerMcpClient.of({
            call: (input) => {
              const op = (input.arguments as { op: string }).op;
              tools.push(`${input.tool} ${op}`);
              return Effect.succeed({
                ok: true,
                value: {
                  status: "done",
                  line: "Taking one picture.",
                  shot: "data:image/jpeg;base64,BBBB",
                },
              } as never);
            },
          }),
        ),
      );
      expect(shot.image).toEqual({ mediaType: "image/jpeg", data: "BBBB" });
      expect(tools).toEqual(["device_owner camera"]);
    }),
);

it("shows a relationship on that person's verified turns only, so her eyes never say what her words weren't told", () => {
  const turn = (speaker: Partial<SpeakerLike>) =>
    ({ vessel: { kind: "device", id: "r1-his" }, text: "hi", ...voiceOf(speaker) }) as never;
  // 16 Nov 06:20: his short turns were not verified yet; she said "pretty calm" behind sulky eyes.
  expect(moodMember(turn({ verified: false, kind: "unverified" }))).toBeNull();
  expect(moodMember(turn({}))).toBe(OWNER_MEMBER_ID);
  expect(turnFace([], { label: "sulky" })).toEqual({ mood: "sulky", reason: "her mood: sulky" });
  expect(turnFace([], null).mood).toBe("happy");
});

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

describe("a room turn that looks misheard is fixed from the talk before it", () => {
  const NAMES = ["Tessaya", "Alfred", "Freya", "BillingHub"];
  const run = (heard: string, settings: { tessayaRoomCleanup?: boolean } = {}) => {
    const asked: string[] = [];
    const out = contextCleaned(
      heard,
      [{ role: "assistant", content: "The BillingHub session is open." }],
      NAMES,
    ).pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(DictationCleanupApi)({
            cleanup: (input) =>
              Effect.sync(() => {
                asked.push(input.message);
                return { configured: true, text: "What about BillingHub?", ms: 300 } as const;
              }),
          }),
          ServerSettingsService.layerTest(settings),
        ),
      ),
    );
    return { asked, out };
  };
  effectIt.effect("fixes a near-miss, and never asks on a clear turn or with the setting off", () =>
    Effect.gen(function* () {
      // As 18 Nov 00:50, his project heard as ordinary words.
      const misheard = run("What about bill in hub?");
      expect(yield* misheard.out).toBe("What about BillingHub?");
      expect(misheard.asked[0]).toContain("The BillingHub session is open.");
      const clear = run("What time is it?");
      expect(yield* clear.out).toBe("What time is it?");
      expect(clear.asked).toEqual([]);
      const off = run("What about bill in hub?", { tessayaRoomCleanup: false });
      expect(yield* off.out).toBe("What about bill in hub?");
      expect(off.asked).toEqual([]);
    }),
  );
});

effectIt.effect(
  "her own life on a Tessel shows in its eyes only: tired is sleepy, picked up is curious, and a talk there keeps it out",
  () =>
    Effect.gen(function* () {
      const eyes: Array<{ topic: string; mood: string }> = [];
      const wants: Array<unknown> = [];
      const off = onAction((e) => void (e.kind === "body.want" && wants.push(e.data)));
      let seenAt: number | null = null;
      let energy = 0.1;
      const world = Layer.mergeAll(
        Layer.mock(HomeAssistantService)({
          devices: Effect.succeed([{ deviceId: "t1", mqttUrl: null }] as never),
          timeZone: Effect.succeed("Asia/Karachi"),
        }),
        Layer.mock(R1Hub)({
          publish: (topic: string, payload: string) =>
            void (topic.includes("/eye") && eyes.push({ topic, mood: JSON.parse(payload).mood })),
        } as never),
        Layer.mock(TessayaMood)({
          atDevice: () => Effect.succeed({ label: "sleepy", intensity: 0.5, energy } as never),
          view: () => Effect.sync(() => ({ seenAt }) as never),
        }),
        Layer.mock(TessayaTurn)({
          threads: () => Effect.succeed([]),
          whoIsHome: Effect.succeed([]),
        }),
      );
      const tick = () => tesselWishTick().pipe(Effect.provide(world));
      expect((yield* tick()).map((w) => w.want)).toEqual(["rest"]);
      expect(eyes).toHaveLength(1);
      // picked up a moment later, past her wish rhythm: curious
      yield* TestClock.adjust("4 minutes");
      energy = 0.8;
      yield* noteTesselHandled("t1");
      expect((yield* tick()).map((w) => w.want)).toEqual(["curious"]);
      expect(wants.at(-1)).toMatchObject({
        vessel: "t1",
        why: "she was just picked up or touched",
      });
      // he talked with her a moment ago (her one affect heard it, from any vessel): her own life waits
      yield* TestClock.adjust("4 minutes");
      seenAt = yield* Clock.currentTimeMillis;
      expect(yield* tick()).toEqual([]);
      off();
    }),
);

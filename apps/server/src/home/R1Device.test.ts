import { TurnOrigin } from "../baton/TessayaTurn.ts";
import { it as effectIt } from "@effect/vitest";
import { BAR_NOT_CONNECTED } from "@t3tools/baton-shared/phoneRelay";
import { EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { SpeakerLike } from "@t3tools/baton-shared/privateMemory";
import { describe, expect, it } from "vite-plus/test";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { HomeAssistantService, type R1Device } from "./HomeAssistantService.ts";
import { HomeDevices, type DeviceActor } from "./HomeDevices.ts";
import { BatonRecordService } from "../baton/BatonRecordService.ts";
import { BatonOneShot } from "../baton/BatonOneShot.ts";
import { R1Brain, toolLoop } from "./R1Brain.ts";
import type { ConversePart, ConverseRequest } from "../speech/DictationCleanupApi.ts";
import {
  calledPersona,
  dictionaryEntries,
  houseTime,
  mqttPublishBytes,
  r1Data,
  r1Gather,
  r1TurnStream,
  roomData,
  roomLook,
  runActs,
  speakableSentences,
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
  });

  it("writes MQTT 3.1.1 connect and publish packets", () => {
    const { connect, publish, disconnect } = mqttPublishBytes({
      clientId: "c",
      user: "u",
      pass: "p",
      topic: "t/x",
      payload: "{}",
    });
    expect([...connect]).toEqual([
      0x10, 19, 0, 4, 0x4d, 0x51, 0x54, 0x54, 4, 0xc2, 0, 30, 0, 1, 0x63, 0, 1, 0x75, 0, 1, 0x70,
    ]);
    expect([...publish]).toEqual([0x30, 7, 0, 3, 0x74, 0x2f, 0x78, 0x7b, 0x7d]);
    expect([...disconnect]).toEqual([0xe0, 0]);
    // Retained, so a room loop that starts later still gets his pronunciations.
    const kept = mqttPublishBytes({
      clientId: "c",
      user: null,
      pass: null,
      topic: "t/x",
      payload: "{}",
      retain: true,
    });
    expect(kept.publish[0]).toBe(0x31);
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
    "Wednesday, 11 November 2026 at 09:28 (Asia/Karachi)",
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
  expect(calledPersona(DEFAULT_OS_PACK, { persona: "engineering" })?.name).toBe("Alfred");
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
      voice: undefined,
      now: "now",
      persona: calledPersona(DEFAULT_OS_PACK, { persona: "research" }),
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
    expect(switchedPersona({ persona: "research", switched: true })).toBe(true);
    expect(switchedPersona({ persona: "research" })).toBe(false);
    expect(switchedPersona({ persona: "research", switched: "yes" })).toBe(false);
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
    expect(lines.map(withoutNarration)).toEqual([
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
        warm: Effect.void,
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
        device: Effect.succeed(null),
        status: Effect.succeed({ state: "connected", line: "" } as never),
        actions: () => Effect.succeed([]),
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
      expect(ran).toEqual(["home_find"]);
      expect(recorded).toBe(0);
      expect(said).toEqual([]);
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
      expect(fake.calls).toEqual(["tessaya_ask from R1", "tessaya_ask_status"]);
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
      expect(older.calls).toEqual(["tessaya_ask from R1", "tessaya_ask", "tessaya_ask_status"]);
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
      device: Effect.sync(() => {
        read += 1;
        return real;
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

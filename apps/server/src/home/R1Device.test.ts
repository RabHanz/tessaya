import { it as effectIt } from "@effect/vitest";
import { BAR_NOT_CONNECTED } from "@t3tools/baton-shared/phoneRelay";
import { EnvironmentId, type PeerLinkSummary } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { HomeAssistantService } from "./HomeAssistantService.ts";
import {
  calledPersona,
  dictionaryEntries,
  houseTime,
  mqttPublishBytes,
  runActs,
  splitActs,
  spokenReply,
  sseReply,
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

describe("asking his laptop", () => {
  const at = DateTime.makeUnsafe("2026-11-12T00:00:00.000Z");
  const laptop: PeerLinkSummary = {
    environmentId: EnvironmentId.make("laptop"),
    label: "laptop",
    urls: ["http://100.64.0.2:3773"],
    access: "full-access",
    linkedAt: at,
    expiresAt: at,
    lastReachedAt: null,
    lastError: null,
    status: "reachable",
  };
  /** A linked laptop whose Tessaya answers `tessaya_ask` with `asked` and its status with `answer`. */
  const linked = (links: ReadonlyArray<PeerLinkSummary>, asked: object, answer: object) => {
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
              calls.push(input.tool);
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
      expect(fake.calls).toEqual(["tessaya_ask", "tessaya_ask_status"]);
      expect(spokenReply("Let me look.", outcomes)).toBe("VS Code and Chrome are open.");
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

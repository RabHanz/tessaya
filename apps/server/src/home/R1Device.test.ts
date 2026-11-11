import { describe, expect, it } from "vite-plus/test";

import {
  dictionaryEntries,
  houseTime,
  mqttPublishBytes,
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
    { term: "VentureOS", aliases: [] },
  ]);
  expect(biasTranscript("Ask Tezaya about Venture OS", entries)).toBe(
    "Ask Tessaya about VentureOS",
  );
});

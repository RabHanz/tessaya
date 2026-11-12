import { describe, expect, it } from "vite-plus/test";

import { calledName, invitesReply, isBackchannel, isDismissal, isOwnVoice } from "./addressing.ts";

const NAMES = ["Tessaya", "Freya", "Alfred", "Sebastian"];

describe("whether he was talking to her", () => {
  it("hears her name the way the R1 wrote it on 12 Nov, and nothing in what was not for her", () => {
    const heard = (t: string) => calledName(t, NAMES);
    expect(heard("Seya, can you hear me?")).toBe("Tessaya");
    expect(heard("Casea, can you hear me?")).toBe("Tessaya");
    expect(heard("Say yeah.")).toBe("Tessaya");
    expect(heard("You say ya?")).toBe("Tessaya");
    expect(heard("Tessaya, turn off the lamp.")).toBe("Tessaya");
    expect(heard("Alfred, what broke?")).toBe("Alfred");
    expect(heard("Can I speak to Alfred?")).toBe("Alfred");
    expect(heard("Freya can you remind me at six")).toBe("Freya");
    for (const t of [
      "Did you hear me?",
      "This is a test of Tessa dictation.",
      "Testing without selecting an input box.",
      "I mean turn it back off.",
      "Tessa said she would call me later.",
    ])
      expect(heard(t)).toBeNull();
  });

  it("knows when he has sent her away", () => {
    expect(isDismissal("No, dismissed.")).toBe(true);
    expect(isDismissal("Okay, that will be all discussed.")).toBe(true);
    expect(isDismissal("Turn off the lamp.")).toBe(false);
  });

  it("tells a bare 'yeah' from a request, and a reply that waits for his answer from one that does not", () => {
    for (const t of ["Yes.", "Okay.", "Yeah.", " yeah ", "Mm.", "Uh huh."])
      expect(isBackchannel(t)).toBe(true);
    for (const t of ["Movie going here.", "Yes, turn it off.", "Okay, what time is it?"])
      expect(isBackchannel(t)).toBe(false);
    expect(invitesReply("Shall I turn it off?")).toBe(true);
    expect(invitesReply("It isn't linked to this server. You'd need to link it first.")).toBe(true);
    expect(invitesReply("Sorry, I missed that one. Could you say it again?")).toBe(true);
    expect(invitesReply("It's twenty-three minutes past seven.")).toBe(false);
    expect(invitesReply("Good evening.")).toBe(false);
  });

  it("knows her own words coming back through the R1's mic (00:38 to 00:42, 13 Nov), and his", () => {
    // What she said, then what the R1 heard while it played.
    const echoes: Array<[string, string]> = [
      ["Twenty to one.", "twenty to one."],
      [
        "Twenty to one, in the morning. I said that because it's late.",
        "Twenty to one in the morning.",
      ],
      ['I couldn\'t find anything called "scrap" in the house.', "I couldn't find anything."],
      ['Sorry, I searched again and there\'s still nothing called "scrap".', "I searched again."],
      ["I didn't catch that clearly. Could you say the room?", "I didn't catch that clearly."],
      ["No need to apologise. Just tell me the room.", "No need to apologize."],
      ["There's no office stand in the house.", "office stand in the house."],
      ["No, there's nothing called an office stand.", "No, there's nothing called an o"],
      ["Got it, I won't touch anything for that.", "Got it. I won't"],
      ["Okay, I'm listening.", "Okay, I'm listening."],
      ["Hello to you. It's just gone twenty to one.", "Hello to you."],
    ];
    for (const [her, heard] of echoes) expect(isOwnVoice(heard, [her])).toBe(true);
    // His own words while she spoke or just after.
    for (const [her, heard] of [
      ["Yes, I can hear you.", "What time is it?"],
      ["Twenty to one.", "What did you say?"],
      ["Okay, I'm listening.", "Turn on the office fan."],
      ["I couldn't find anything called scrap.", "Uh can you turn on the lamp?"],
    ] as const)
      expect(isOwnVoice(heard, [her])).toBe(false);
  });
});

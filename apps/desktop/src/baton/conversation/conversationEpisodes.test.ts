// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createEpisodeWatch, type EpisodeSend } from "./conversationEpisodes.ts";
import { createPersonaConversations } from "./conversationLog.ts";

describe("a conversation gone quiet becomes an episode (MEM-18)", () => {
  it("sends each persona's turns since its last episode once it is idle, and again only after new turns", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-episodes-"));
    let clock = Date.parse("2026-11-08T10:00:00Z");
    const conversations = createPersonaConversations({
      dir,
      legacy: NodePath.join(dir, "none.ndjson"),
      lead: "executive",
      now: () => new Date(clock),
    });
    const freya = conversations.of("operations");
    freya.add({ route: "answer", said: "venue?", reply: "From six.", persona: "operations" });
    freya.add({ route: "answer", said: "and the bar?", reply: "Ask them.", persona: "operations" });
    conversations.of("executive").add({ route: "answer", said: "hi", reply: "Hello." });
    const sent: EpisodeSend[] = [];
    let accept = false;
    const watch = () =>
      createEpisodeWatch({
        conversations,
        file: NodePath.join(dir, "episodes.json"),
        nameOf: (id) => (id === "operations" ? "Freya" : undefined),
        send: async (e) => (sent.push(e), accept),
        now: () => clock,
      });
    // Still going: nothing yet.
    expect(await watch().tick()).toBe(0);
    clock += 31 * 60_000;
    // The server did not keep it: tried again on the next tick, with the same turns.
    expect(await watch().tick()).toBe(0);
    accept = true;
    expect(await watch().tick()).toBe(1);
    expect(sent.at(-1)).toEqual({
      persona: "operations",
      transcript:
        "he said: venue?\nFreya replied: From six.\n\nhe said: and the bar?\nFreya replied: Ask them.",
      sourceRef: "conversation:operations:1-2",
    });
    // A single turn (the lead's) is not worth one; and a restart does not send Freya's again.
    const before = sent.length;
    expect(await watch().tick()).toBe(0);
    expect(sent).toHaveLength(before);
    freya.add({ route: "answer", said: "dinner?", reply: "Eight.", persona: "operations" });
    freya.add({ route: "answer", said: "where?", reply: "The Italian.", persona: "operations" });
    clock += 31 * 60_000;
    expect(await watch().tick()).toBe(1);
    expect(sent.at(-1)?.sourceRef).toBe("conversation:operations:3-4");
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });
});

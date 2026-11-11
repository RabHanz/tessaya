// @effect-diagnostics nodeBuiltinImport:off globalDate:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createEpisodeWatch, type EpisodeSend } from "./conversationEpisodes.ts";
import { createPersonaConversations } from "./conversationLog.ts";

describe("a conversation gone quiet becomes an episode (MEM-18)", () => {
  it("starts with no backlog, then sends each idle stretch once, split by project, with its taint and time", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-episodes-"));
    let clock = Date.parse("2026-11-08T10:00:00Z");
    const conversations = createPersonaConversations({
      dir,
      legacy: NodePath.join(dir, "none.ndjson"),
      lead: "executive",
      now: () => new Date(clock),
    });
    const freya = conversations.of("operations");
    const say = (said: string, reply: string, extra: { project?: string; tainted?: true } = {}) =>
      freya.add({ route: "answer", said, reply, persona: "operations", ...extra });
    say("old one", "Old.");
    say("old two", "Old.");
    const sent: EpisodeSend[] = [];
    let answer: "done" | "retry" = "retry";
    const watch = () =>
      createEpisodeWatch({
        conversations,
        file: NodePath.join(dir, "episodes.json"),
        nameOf: (id) => ({ operations: "Freya", engineering: "Alfred" })[id],
        send: async (e) => (sent.push(e), answer),
        now: () => clock,
      });
    // The first run starts where the files are: an upgrade sends no backlog.
    clock += 31 * 60_000;
    expect(await watch().tick()).toBe(0);
    expect(sent).toEqual([]);

    say("venue?", "From six.");
    say("and the bar?", "Ask them.", { tainted: true });
    // Then the shop, a walled project: its own episode, scoped to it, never mixed into the one before.
    say("shop launch?", "Friday.", { project: "shop" });
    say("price?", "Twelve pounds.", { project: "shop" });
    // Still going: nothing yet.
    expect(await watch().tick()).toBe(0);
    clock += 31 * 60_000;
    // The server said try again: nothing moves on, and the next tick sends the same turns.
    expect(await watch().tick()).toBe(0);
    expect(sent.map((e) => e.sourceRef)).toEqual(["conversation:operations:3-4"]);
    answer = "done";
    expect(await watch().tick()).toBe(2);
    expect(sent.slice(1)).toEqual([
      {
        persona: "operations",
        transcript:
          "he said: venue?\nFreya replied: From six.\n\nhe said: and the bar?\nFreya replied: Ask them.",
        sourceRef: "conversation:operations:3-4",
        project: null,
        tainted: true,
        at: new Date(clock - 31 * 60_000).toISOString(),
      },
      {
        persona: "operations",
        transcript:
          "he said: shop launch?\nFreya replied: Friday.\n\nhe said: price?\nFreya replied: Twelve pounds.",
        sourceRef: "conversation:operations:5-6",
        project: "shop",
        tainted: false,
        at: new Date(clock - 31 * 60_000).toISOString(),
      },
    ]);
    // Nothing again after a restart, and a single turn is not worth one.
    say("thanks", "Any time.");
    clock += 31 * 60_000;
    expect(await watch().tick()).toBe(0);
    expect(sent).toHaveLength(3);
    // The lead's file holds the old shared turns: each is labelled by who answered it.
    const lead = conversations.of("executive");
    lead.add({ route: "answer", said: "deploy?", reply: "Fixed.", persona: "engineering" });
    lead.add({ route: "answer", said: "and you?", reply: "Fine." });
    clock += 31 * 60_000;
    expect(await watch().tick()).toBe(1);
    expect(sent.at(-1)?.transcript).toBe(
      "he said: deploy?\nAlfred replied: Fixed.\n\nhe said: and you?\nexecutive replied: Fine.",
    );
    NodeFS.rmSync(dir, { recursive: true, force: true });
  });
});

import { describe, expect, it } from "vite-plus/test";

import type { DictionaryEntry } from "@t3tools/baton-shared/dictationCleanup";

import type { VisionSession } from "../screen/claudeVision.ts";
import { makeRewriter } from "./dictationRewriter.ts";

describe("makeRewriter", () => {
  it("starts a session with the new dictionary as soon as he teaches a word", () => {
    const prompts: string[] = [];
    let dictionary: ReadonlyArray<DictionaryEntry> = [];
    const rewriter = makeRewriter({
      claudeBinary: "claude",
      model: "haiku",
      workDir: "/tmp",
      env: {},
      platform: "linux",
      dictionary: () => dictionary,
      start: (options): VisionSession => {
        prompts.push(options.systemPrompt);
        return { ask: async () => "", alive: () => true, dispose: () => {} };
      },
    });
    rewriter.warm();
    rewriter.warm();
    dictionary = [{ phrase: "Tessaya", replacement: null }];
    rewriter.warm();
    rewriter.dispose();
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain("Tessaya");
  });

  it("takes the answer cleaned at the pause, and never asks the session two things at once", async () => {
    const asked: string[] = [];
    let open = 0;
    let most = 0;
    const rewriter = makeRewriter({
      claudeBinary: "claude",
      model: "haiku",
      workDir: "/tmp",
      env: {},
      platform: "linux",
      dictionary: () => [],
      always: true,
      limitMs: 60_000,
      start: (): VisionSession => ({
        ask: async (content) => {
          open += 1;
          most = Math.max(most, open);
          const text = content[0]?.type === "text" ? content[0].text : "";
          asked.push(text);
          await Promise.resolve();
          open -= 1;
          return /<dictation>(.*)<\/dictation>/s.exec(text)?.[1]?.toUpperCase() ?? "";
        },
        alive: () => true,
        dispose: () => {},
      }),
    });
    const said = { mode: "default", level: "claude" } as const;
    rewriter.speculate({ ...said, raw: "we should go" });
    expect((await rewriter.clean({ ...said, raw: "we should go" })).text).toBe("WE SHOULD GO");
    expect(asked).toHaveLength(1);
    rewriter.speculate({ ...said, raw: "we should" });
    expect((await rewriter.clean({ ...said, raw: "we should go home" })).text).toBe(
      "WE SHOULD GO HOME",
    );
    expect(asked).toHaveLength(3);
    expect(most).toBe(1);
    rewriter.dispose();
  });
});

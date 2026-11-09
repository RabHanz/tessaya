import { describe, expect, it } from "vite-plus/test";

import {
  effortCommand,
  modelCommand,
  readBack,
  sessionEffort,
  withRealEffort,
  setLiveModel,
  setModelResumingStopped,
  type LiveModelDeps,
} from "./liveModel.ts";

const said = (text: string) =>
  `{"type":"user","message":{"role":"user","content":"<local-command-stdout>${text}</local-command-stdout>"}}\n`;

const deps = (over: Partial<LiveModelDeps> & { transcript?: () => string }): LiveModelDeps => {
  let written = "";
  return {
    session: { herdrPane: "s~1", status: "idle" },
    send: async () => true,
    mark: () => 0,
    since: () => over.transcript?.() ?? written,
    wait: async () => undefined,
    claudeModels: ["claude-opus-5-5"],
    ...over,
  };
};

describe("slash commands", () => {
  it("types only a model alias or id made of safe characters, and a known effort", () => {
    expect(modelCommand("claude-opus-5-5")).toBe("/model claude-opus-5-5");
    expect(modelCommand("opus")).toBe("/model opus");
    expect(modelCommand("opus; rm -rf /")).toBeNull();
    expect(modelCommand("")).toBeNull();
    expect(effortCommand("medium")).toBe("/effort medium");
    expect(effortCommand("ultra")).toBeNull();
  });
});

describe("reading the session's answer back", () => {
  it("finds the newest model or effort line in what was written after the command", () => {
    const text =
      said("Set model to `Opus 5.5 (1M context)` and saved as your default for new sessions") +
      said("Set effort level to medium");
    expect(readBack(text, "model")).toMatch(/^Set model to `Opus 5\.5/);
    expect(readBack(text, "effort")).toBe("Set effort level to medium");
    expect(readBack("{}\n", "model")).toBeNull();
  });

  it("reads a session's real effort: its last change, then its settings, then its model's default", () => {
    const settings = JSON.stringify({ effortLevel: "xhigh" });
    const changed = said("Set effort level to medium") + said("Set model to `Opus 5.5`");
    expect(
      sessionEffort({ transcriptTail: changed, settingsJson: settings, modelDefault: "high" }),
    ).toBe("medium");
    expect(
      sessionEffort({ transcriptTail: "{}\n", settingsJson: settings, modelDefault: "high" }),
    ).toBe("xhigh");
    expect(
      sessionEffort({ transcriptTail: "", settingsJson: "{not json", modelDefault: "high" }),
    ).toBe("high");
    expect(
      sessionEffort({ transcriptTail: "", settingsJson: null, modelDefault: null }),
    ).toBeNull();
  });

  it('shows the real effort in place of the live instance\'s "as it is" choice, and keeps a held pick', () => {
    const models = [
      {
        capabilities: {
          optionDescriptors: [
            { id: "effort", options: [{ id: "session" }, { id: "high" }, { id: "max" }] },
          ],
        },
      },
    ];
    const shown = withRealEffort(models, [{ id: "effort", value: "session" }], "high");
    expect(shown.options).toEqual([{ id: "effort", value: "high" }]);
    expect(shown.models[0]?.capabilities.optionDescriptors[0]?.options).toEqual([
      { id: "high" },
      { id: "max" },
    ]);
    expect(withRealEffort(models, [{ id: "effort", value: "max" }], "high").options).toEqual([
      { id: "effort", value: "max" },
    ]);
  });
});

describe("setLiveModel", () => {
  it("applies the model and the effort only once the session has said so", async () => {
    const sent: string[] = [];
    let log = "";
    const result = await setLiveModel(
      deps({
        send: async (_pane, text) => {
          sent.push(text);
          log += text.startsWith("/model")
            ? said("Set model to `Opus 5.5`")
            : said("Set effort level to medium");
          return true;
        },
        since: () => log,
      }),
      { model: "claude-opus-5-5", effort: "medium" },
    );
    expect(sent).toEqual(["/model claude-opus-5-5", "/effort medium"]);
    expect(result).toMatchObject({
      state: "applied",
      confirmed: expect.arrayContaining([expect.stringContaining("Opus 5.5")]),
    });
  });

  it("refuses another provider's model without typing anything", async () => {
    const sent: string[] = [];
    const result = await setLiveModel(
      deps({ send: async (_pane, text) => (sent.push(text), true) }),
      { model: "gpt-5.5" },
    );
    expect(result.state).toBe("refused");
    expect(sent).toEqual([]);
  });

  it("says it was not confirmed when the session stays silent, never that it was applied", async () => {
    const result = await setLiveModel(deps({}), { model: "opus" });
    expect(result.state).toBe("not_confirmed");
  });

  it("offers to bring a session that is not in Herdr in, and sends nothing", async () => {
    const sent: string[] = [];
    const result = await setLiveModel(
      deps({ session: { herdrPane: null, status: "idle" }, send: async (_p, t) => !!sent.push(t) }),
      { effort: "high" },
    );
    expect(result.state).toBe("not_in_herdr");
    expect(sent).toEqual([]);
  });

  it("waits for a busy session or an open question, and refuses a bad model or effort before typing anything", async () => {
    expect(
      (await setLiveModel(deps({ session: { herdrPane: "p", status: "busy" } }), { effort: "low" }))
        .state,
    ).toBe("busy");
    expect(
      (
        await setLiveModel(deps({ session: { herdrPane: "p", status: "waiting" } }), {
          effort: "low",
        })
      ).state,
    ).toBe("busy");
    expect((await setLiveModel(deps({}), { model: "x; y" })).state).toBe("refused");
    expect((await setLiveModel(deps({}), { effort: "ultra" })).state).toBe("refused");
    expect((await setLiveModel(deps({ session: null }), { effort: "low" })).state).toBe(
      "not_running",
    );
  });
});

describe("a model change on a stopped live session", () => {
  const applied = { state: "applied", detail: "Set model", confirmed: ["Set model"] } as const;
  const stopped = { state: "not_running", detail: "not here", confirmed: [] } as const;
  it("resumes the same session once, then tells that session; a running one is never resumed", async () => {
    const results = [stopped, applied];
    let resumes = 0;
    const got = await setModelResumingStopped({
      run: async () => results.shift() ?? stopped,
      resume: async () => ((resumes += 1), true),
      wait: async () => undefined,
    });
    expect(got.state).toBe("applied");
    expect(resumes).toBe(1);
    let more = 0;
    const running = await setModelResumingStopped({
      run: async () => applied,
      resume: async () => ((more += 1), true),
      wait: async () => undefined,
    });
    expect(running.state).toBe("applied");
    expect(more).toBe(0);
  });
  it("says so when the session could not be resumed, and never loops forever", async () => {
    const failed = await setModelResumingStopped({
      run: async () => stopped,
      resume: async () => false,
      wait: async () => undefined,
    });
    expect(failed.state).toBe("not_running");
    expect(failed.detail).toContain("could not be resumed");
    const never = await setModelResumingStopped({
      run: async () => stopped,
      resume: async () => true,
      wait: async () => undefined,
    });
    expect(never.detail).toContain("not live yet");
  });
});

/* oxlint-disable t3code/no-low-value-comments, t3code/no-test-timeout-or-unreasoned-skip, t3code/no-wall-clock-in-tests -- Baton file predating upstream's rule (D82) */
// @effect-diagnostics globalConsole:off globalDate:off nodeBuiltinImport:off
/**
 * The desktop's capture → core loop with the REAL core: the voice lane's
 * espeak-ng fixtures as the microphone, openWakeWord → Silero → whisper.cpp →
 * mode machine → router → the real grammar, and the HUD's last-words line.
 *
 * Needs the models and whisper-cli (docs/baton/VOICE.md); skipped otherwise:
 *   BATON_VOICE_MODELS=<dir>  BATON_WHISPER_CLI=<whisper-cli>
 */
import * as NodePath from "node:path";

import type { TessayaFocusTarget } from "@t3tools/tessaya-contracts";
import {
  createVoiceCore,
  createVoiceRouter,
  createWhisperCppStt,
  DEFAULT_TIMINGS,
} from "@t3tools/tessaya-voice";
import { emptyContextBus } from "@t3tools/tessaya-shared/contextBus";
import { resolveTessayaIntent, type IntentVocabulary } from "@t3tools/tessaya-shared/intentParser";
import { describe, expect, it } from "vite-plus/test";

import {
  createDesktopVoiceCore,
  desktopVoiceContext,
  makeVoiceIntentClient,
  missingVoiceAssets,
  resolveVoiceAssets,
  resolveWakeModels,
  sessionMessageSentence,
  type VoiceIntentRequest,
  liveTimings,
  withPreempt,
} from "./desktopVoiceCore.ts";
import { makeWavFileAudioInput, wavDeviceId } from "./WavFileAudioInput.ts";
import { utteranceCaption } from "./voiceHud.ts";
import { startVoiceLoop } from "./voiceLoop.ts";
import type { VoiceState } from "./voiceTypes.ts";

const fleet: IntentVocabulary = {
  workSessions: [
    {
      id: "ws-vantageos",
      title: "Niche radar tests",
      projectId: "project-vantageos",
      projectLabel: "VantageOS",
      needsApproval: false,
      updatedAt: "2026-10-26T05:00:00.000Z",
    },
    {
      id: "ws-margin",
      title: "Search ranking",
      projectId: "project-margin",
      projectLabel: "The Margin",
      needsApproval: false,
      updatedAt: "2026-10-26T06:00:00.000Z",
    },
  ],
  projects: [
    { id: "project-vantageos", title: "VantageOS" },
    { id: "project-margin", title: "The Margin" },
  ],
  providers: [],
  openGates: [],
  hostAliases: [],
  focusedWorkSessionId: null,
};

const field: TessayaFocusTarget = {
  producer: "desktop",
  kind: "editable",
  label: "the focused field",
  injectable: true,
  origin: null,
};

/** The renderer's two RPCs, answered by the real grammar. */
const grammarRenderer = () => {
  const requests: VoiceIntentRequest[] = [];
  const request = async (r: VoiceIntentRequest) => {
    requests.push(r);
    const resolution = resolveTessayaIntent(r.text, {
      ...fleet,
      focusedWorkSessionId: r.focusedWorkSessionId,
    });
    if (r.kind === "resolve") return resolution;
    return { resolution, reply: resolution.outcome === "resolved" ? "Done." : "Refused." };
  };
  return { request, requests };
};

describe("the intent bridge", () => {
  it("sends direct-session speech to the given session, word for word", async () => {
    const { request, requests } = grammarRenderer();
    const client = makeVoiceIntentClient({
      request,
      field,
      injection: { method: "clipboard", canInject: () => true, insertText: async () => {} },
    });
    await client.sendToSession({ workSessionId: "ws-vantageos", text: "run the migration tests" });
    expect(requests[0]).toEqual({
      kind: "run",
      text: sessionMessageSentence("run the migration tests"),
      focusedWorkSessionId: "ws-vantageos",
    });
    const resolved = resolveTessayaIntent(requests[0]!.text, {
      ...fleet,
      focusedWorkSessionId: "ws-vantageos",
    });
    // The focused one, not the one that moved last (ws-margin).
    expect(resolved.outcome === "resolved" && resolved.workSessionId).toBe("ws-vantageos");
    expect(
      resolved.outcome === "resolved" &&
        resolved.command.kind === "message_work_session" &&
        resolved.command.text,
    ).toBe("run the migration tests");
  });

  it("starts and stops dictation by voice alone and pastes each sentence, with no key", async () => {
    const pasted: string[] = [];
    const client = makeVoiceIntentClient({
      request: async () => null,
      field,
      injection: {
        method: "clipboard",
        canInject: () => true,
        insertText: async ({ text }) => void pasted.push(text),
      },
    });
    const none = {} as never;
    const core = createVoiceCore({
      wake: none,
      vad: none,
      stt: none,
      router: createVoiceRouter(client),
    });
    core.setContext(
      desktopVoiceContext({ focusedWorkSessionId: null, field, observedAt: new Date() }),
    );
    const states: string[] = [];
    core.subscribe((e) => e.type === "state" && states.push(e.state));
    core.activate("wake");
    await core.hear("dictate");
    await core.hear("Thanks, I'll send the contract tomorrow.");
    await core.hear("Colour is spelt with a u.");
    await core.hear("stop dictating");
    await core.idle();
    expect(pasted).toEqual([
      "Thanks, I'll send the contract tomorrow.",
      "Colour is spelt with a u.",
    ]);
    expect(states).toContain("dictation");
    expect(core.snapshot().machine.mode).not.toBe("dictation");
  });

  it("reports a refused paste as not inserted rather than throwing", async () => {
    const client = makeVoiceIntentClient({
      request: async () => null,
      field,
      injection: {
        method: "clipboard",
        canInject: () => false,
        insertText: async () => {
          throw new Error("no paste here");
        },
      },
    });
    expect(await client.insertText({ text: "hello" })).toEqual({ inserted: false });
  });

  it("finds the shipped models unless told otherwise, and names what is missing", () => {
    const assets = resolveVoiceAssets({ stateDir: "/s", resourcesPath: "/r", env: {} });
    expect(assets.modelsDir).toBe(NodePath.join("/r", "baton-voice", "models"));
    expect(missingVoiceAssets(assets, () => false)).toHaveLength(3);
    expect(
      resolveVoiceAssets({ stateDir: "/s", resourcesPath: "/r", env: { BATON_VOICE_MODELS: "/m" } })
        .modelsDir,
    ).toBe("/m");
  });

  it("drops a switched-off word, prefers his own model, and names a word with none", () => {
    const assets = { modelsDir: "/shipped", userModelsDir: "/mine" };
    const words = [
      { word: "Sebastian", enabled: true, threshold: 0.5 },
      { word: "Alfred", enabled: false, threshold: 0.5 },
      { word: "Mister Baker", enabled: true, threshold: 0.6 },
      { word: "Freya", enabled: true, threshold: 0.7 },
    ];
    const present = new Set([
      NodePath.join("/shipped", "sebastian.onnx"),
      NodePath.join("/mine", "sebastian.onnx"),
      NodePath.join("/shipped", "freya.onnx"),
    ]);
    const { models, missing } = resolveWakeModels(assets, words, (path) => present.has(path));
    expect(models).toEqual([
      { word: "Sebastian", path: NodePath.join("/mine", "sebastian.onnx"), threshold: 0.5 },
      { word: "Freya", path: NodePath.join("/shipped", "freya.onnx"), threshold: 0.7 },
    ]);
    expect(missing).toEqual(["Mister Baker"]);
  });
});

const env = {
  BATON_VOICE_MODELS: process.env.BATON_VOICE_MODELS,
  BATON_WHISPER_CLI: process.env.BATON_WHISPER_CLI,
};
const assets = resolveVoiceAssets({ stateDir: "/nonexistent", resourcesPath: "/nonexistent", env });
const ready =
  env.BATON_VOICE_MODELS !== undefined &&
  env.BATON_WHISPER_CLI !== undefined &&
  missingVoiceAssets(assets).length === 0;
const fixtures = NodePath.resolve(
  import.meta.dirname,
  "../../../../../packages/tessaya-voice/test/fixtures",
);
const wav = (name: string) => NodePath.join(fixtures, `${name}.wav`);

describe.skipIf(!ready)("WAV as the mic, through the real core", () => {
  it("wake → VAD → STT → intent → the HUD's last-words line", { timeout: 240_000 }, async () => {
    const { request, requests } = grammarRenderer();
    const inserted: string[] = [];
    const replies: string[] = [];
    const { core, drain } = await createDesktopVoiceCore({
      assets,
      wakeWords: [{ word: "jarvis", enabled: true, threshold: 0.5 }],
      stt: createWhisperCppStt({
        binary: env.BATON_WHISPER_CLI!,
        model: NodePath.join(assets.modelsDir, "ggml-base.en.bin"),
      }),
      platform: "linux",
      tts: null,
      origin: Date.now(),
      onReply: (text) => replies.push(text),
      intent: makeVoiceIntentClient({
        request,
        field,
        injection: {
          method: "clipboard",
          canInject: () => true,
          insertText: async ({ text }) => void inserted.push(text),
        },
      }),
    });
    const files = ["wake-status", "followup", "dictate", "stop-dictating"].map(wav);
    const states: VoiceState[] = [];
    const captions: string[] = [];
    const refresh = () =>
      core.setContext(
        desktopVoiceContext({ focusedWorkSessionId: null, field, observedAt: new Date() }),
      );
    refresh();
    const loop = await startVoiceLoop({
      audio: makeWavFileAudioInput(files, { afterFrame: drain }),
      core,
      deviceId: wavDeviceId(files[0]!),
      onState: (s) => states.push(s),
      onUtterance: (u) => captions.push(utteranceCaption(u)),
    });
    await core.idle();
    const play = async (index: number) => {
      refresh();
      await loop.switchDevice(wavDeviceId(files[index]!));
      await core.idle();
    };

    // "Hey Jarvis, what is VantageOS doing?" — woken, transcribed, run.
    expect(states).toContain("command_window");
    expect(captions[0]).toMatch(/^“What is VantageOS doing\?” to Baton$/i);
    expect(requests.some((r) => r.kind === "run" && /VantageOS doing/i.test(r.text))).toBe(true);

    // Follow-up without a wake: conversation mode, target inherited.
    await play(1);
    expect(states).toContain("conversation");
    expect(captions.at(-1)).toMatch(/run the other test too/i);
    expect(requests.findLast((r) => r.kind === "run")?.focusedWorkSessionId).toBe("ws-vantageos");

    // Dictation is typed into the field and never reaches the intent path.
    await play(2);
    expect(core.snapshot().state).toBe("dictation");
    expect(inserted.join(" ")).toMatch(/revised version tomorrow/i);
    expect(captions.at(-1)).toMatch(
      /^“Thanks, I will send the revised version tomorrow\.” typed into the focused field$/,
    );
    await play(3);
    expect(core.snapshot().machine.mode).not.toBe("dictation");
    expect(requests.some((r) => /revised/i.test(r.text))).toBe(false);

    expect(replies.length).toBeGreaterThan(0);
    console.log(["captions:", ...captions, "replies:", ...replies].join("\n  "));
    await loop.stop();
  });
});

describe("how long the voice listens", () => {
  it("reads the choices each time, and keeps the defaults when none are given", () => {
    let open = { commandWindowMs: 15_000, conversationMs: 60_000 };
    const live = liveTimings({ ...DEFAULT_TIMINGS, wakeWords: ["tessaya"] }, () => open);
    expect(live.commandWindowMs).toBe(15_000);
    expect(live.conversationMs).toBe(60_000);
    expect(live.confirmationMs).toBe(DEFAULT_TIMINGS.confirmationMs);
    expect(live.wakeWords).toEqual(["tessaya"]);
    open = { commandWindowMs: 8_000, conversationMs: 120_000 };
    expect(live.commandWindowMs).toBe(8_000);
    expect(live.conversationMs).toBe(120_000);
    expect(liveTimings(DEFAULT_TIMINGS).commandWindowMs).toBe(DEFAULT_TIMINGS.commandWindowMs);
  });
});

describe("the dictionary preempt", () => {
  it("runs only at go, and still when thinking ahead failed", async () => {
    let preempted = 0;
    const router = withPreempt(
      {
        route: async () => ({ kind: "none" }),
        prepare: async () => {
          throw new Error("offline");
        },
      },
      async () => {
        preempted += 1;
        return "Added.";
      },
    );
    const go = await router.prepare!(
      { kind: "command", text: "add Tessaya to my dictionary", inheritedTarget: null },
      { bus: emptyContextBus, now: 0 },
    );
    expect(preempted).toBe(0);
    expect(await go()).toMatchObject({ kind: "ran", reply: "Added." });
    expect(preempted).toBe(1);
  });
});

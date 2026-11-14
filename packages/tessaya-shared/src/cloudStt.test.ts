import { describe, expect, it } from "vite-plus/test";

import {
  CloudSttError,
  cloudBudgetMs,
  cloudTranscribe,
  listCloudModels,
  transcribeWithFallback,
  type CloudSttProvider,
} from "./cloudStt.ts";

const KEY = "sk-test-SECRET-key-123";
const WAV = new Uint8Array([82, 73, 70, 70, 1, 2, 3, 4]);

interface Seen {
  url: string;
  init: RequestInit;
}

/** Answers with a recorded body (trimmed from real responses) and keeps what was sent. */
const recorded = (status: number, body: unknown) => {
  const seen: Seen[] = [];
  const fetch = async (url: string, init: RequestInit) => {
    seen.push({ url, init });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
  };
  return { fetch, seen };
};

const headers = (init: RequestInit) => new Headers(init.headers);

describe("listing the models that can transcribe", () => {
  it.each<[CloudSttProvider, unknown, ReadonlyArray<string>]>([
    [
      "openai",
      {
        object: "list",
        data: [
          { id: "gpt-4o", object: "model" },
          { id: "whisper-1", object: "model" },
          { id: "gpt-4o-transcribe", object: "model" },
          { id: "gpt-4o-mini-transcribe", object: "model" },
          { id: "gpt-4o-transcribe-diarize", object: "model" },
          { id: "gpt-4o-realtime-preview", object: "model" },
          { id: "tts-1", object: "model" },
        ],
      },
      ["gpt-4o-mini-transcribe", "gpt-4o-transcribe", "whisper-1"],
    ],
    [
      "gemini",
      {
        models: [
          {
            name: "models/gemini-2.5-flash",
            supportedGenerationMethods: ["generateContent", "countTokens"],
          },
          {
            name: "models/gemini-2.5-flash-lite",
            supportedGenerationMethods: ["generateContent"],
          },
          {
            name: "models/gemini-2.5-flash-preview-tts",
            supportedGenerationMethods: ["generateContent"],
          },
          { name: "models/gemini-embedding-001", supportedGenerationMethods: ["embedContent"] },
          { name: "models/imagen-4.0-generate-001", supportedGenerationMethods: ["predict"] },
        ],
      },
      ["gemini-2.5-flash", "gemini-2.5-flash-lite"],
    ],
    [
      "openrouter",
      {
        data: [
          { id: "openai/gpt-4o", architecture: { input_modalities: ["text", "image"] } },
          {
            id: "google/gemini-2.5-flash",
            architecture: { input_modalities: ["text", "image", "audio", "file"] },
          },
          {
            id: "openai/gpt-4o-audio-preview",
            architecture: { input_modalities: ["text", "audio"] },
          },
        ],
      },
      ["google/gemini-2.5-flash", "openai/gpt-4o-audio-preview"],
    ],
  ])("%s: only models that hear audio, the recommended one first", async (provider, body, ids) => {
    const { fetch, seen } = recorded(200, body);
    const models = await listCloudModels(provider, KEY, fetch);
    expect(models.map((m) => m.id)).toEqual(ids);
    expect(models[0]!.recommended).toBe(true);
    expect(models[0]!.label).toContain("recommended");
    // The key goes in a header, never in the address.
    expect(seen[0]!.url).not.toContain(KEY);
  });
});

describe("transcribing a clip on his key", () => {
  it("OpenAI: the audio as a file, the model and his language", async () => {
    const { fetch, seen } = recorded(200, { text: " Book the train for Friday. " });
    const text = await cloudTranscribe({
      provider: "openai",
      key: KEY,
      model: "gpt-4o-mini-transcribe",
      wav: WAV,
      language: "en",
      fetch,
    });
    expect(text).toBe("Book the train for Friday.");
    expect(seen[0]!.url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect(headers(seen[0]!.init).get("authorization")).toBe(`Bearer ${KEY}`);
    const form = seen[0]!.init.body as FormData;
    expect(form.get("model")).toBe("gpt-4o-mini-transcribe");
    expect(form.get("language")).toBe("en");
    expect(form.get("file")).toBeInstanceOf(Blob);
  });

  it("Gemini: inline audio with the language in the prompt, the key in a header", async () => {
    const { fetch, seen } = recorded(200, {
      candidates: [
        { content: { parts: [{ text: "Réserve le train pour vendredi." }], role: "model" } },
      ],
      usageMetadata: { promptTokenCount: 120 },
    });
    const text = await cloudTranscribe({
      provider: "gemini",
      key: KEY,
      model: "gemini-2.5-flash",
      wav: WAV,
      language: "fr",
      fetch,
    });
    expect(text).toBe("Réserve le train pour vendredi.");
    expect(seen[0]!.url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent",
    );
    expect(headers(seen[0]!.init).get("x-goog-api-key")).toBe(KEY);
    const sent = JSON.parse(seen[0]!.init.body as string);
    // The name, not the code: the model reads "French" better than "fr".
    expect(sent.contents[0].parts[0].text).toContain("language is French");
    expect(sent.contents[0].parts[1].inline_data).toEqual({
      mime_type: "audio/wav",
      data: Buffer.from(WAV).toString("base64"),
    });
  });

  it("OpenRouter: input_audio in a chat message", async () => {
    const { fetch, seen } = recorded(200, {
      id: "gen-1",
      choices: [{ message: { role: "assistant", content: "What needs me today?" } }],
    });
    const text = await cloudTranscribe({
      provider: "openrouter",
      key: KEY,
      model: "google/gemini-2.5-flash",
      wav: WAV,
      language: null,
      fetch,
    });
    expect(text).toBe("What needs me today?");
    const sent = JSON.parse(seen[0]!.init.body as string);
    expect(sent.model).toBe("google/gemini-2.5-flash");
    expect(sent.messages[0].content[0].text).not.toContain("language is");
    expect(sent.messages[0].content[1]).toEqual({
      type: "input_audio",
      input_audio: { data: Buffer.from(WAV).toString("base64"), format: "wav" },
    });
  });

  it.each<[CloudSttProvider, number, unknown, string, string]>([
    [
      "openai",
      401,
      { error: { message: `Incorrect API key provided: ${KEY}.`, code: "invalid_api_key" } },
      "key",
      "OpenAI answered 401 (invalid_api_key)",
    ],
    [
      "openai",
      404,
      { error: { message: "The model `gpt-9` does not exist", code: "model_not_found" } },
      "model",
      "OpenAI answered 404 (model_not_found)",
    ],
    [
      "gemini",
      403,
      { error: { code: 403, message: "API key not valid.", status: "PERMISSION_DENIED" } },
      "key",
      "Google Gemini answered 403 (403)",
    ],
    ["openrouter", 500, "<html>upstream error</html>", "other", "OpenRouter answered 500"],
  ])(
    "%s %d: names the status and short code, never the key or the body",
    async (provider, status, body, failure, message) => {
      const { fetch, seen } = recorded(status, body);
      const error = await cloudTranscribe({
        provider,
        key: KEY,
        model: "m",
        wav: WAV,
        language: null,
        fetch,
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(CloudSttError);
      expect((error as CloudSttError).failure).toBe(failure);
      expect((error as CloudSttError).message).toBe(message);
      // A key is never carried to another host by a redirect.
      expect(seen[0]!.init.redirect).toBe("error");
    },
  );
});

describe("falling back to this computer", () => {
  const manual = () => {
    let fire = () => undefined as void;
    return {
      timer: (_ms: number, abort: () => void) => {
        fire = abort;
        return () => undefined;
      },
      expire: () => fire(),
    };
  };

  it("keeps the cloud's words when it answers in time", async () => {
    const notes: string[] = [];
    const result = await transcribeWithFallback({
      cloud: async () => "hello there",
      local: async () => "local words",
      audioMs: 2_000,
      onFallback: (why) => void notes.push(why.failure),
    });
    expect(result).toEqual({ text: "hello there", via: "cloud" });
    expect(notes).toEqual([]);
  });

  it.each([
    [
      "a refused key",
      async () => Promise.reject(new CloudSttError("OpenAI answered 401", "key")),
      "key",
    ],
    ["a missing model", async () => Promise.reject(new CloudSttError("404", "model")), "model"],
    ["a network error", async () => Promise.reject(new TypeError("fetch failed")), "other"],
    ["an empty answer", async () => "", "empty"],
  ])("hears the clip locally after %s, and says why once", async (_name, cloud, failure) => {
    const notes: string[] = [];
    const result = await transcribeWithFallback({
      cloud,
      local: async () => "local words",
      audioMs: 2_000,
      onFallback: (why) => void notes.push(why.failure),
    });
    expect(result).toEqual({ text: "local words", via: "local" });
    expect(notes).toEqual([failure]);
  });

  it("does not wait past the budget, even for a call that ignores the abort", async () => {
    const clock = manual();
    const notes: string[] = [];
    let aborted = false;
    const pending = transcribeWithFallback({
      cloud: (signal) => {
        signal.addEventListener("abort", () => (aborted = true));
        return new Promise<string>(() => undefined);
      },
      local: async () => "local words",
      audioMs: 3_000,
      onFallback: (why) => void notes.push(`${why.failure}: ${why.detail}`),
      timer: clock.timer,
    });
    clock.expire();
    expect(await pending).toEqual({ text: "local words", via: "local" });
    expect(aborted).toBe(true);
    expect(notes).toEqual([`timeout: no answer in ${Math.round(cloudBudgetMs(3_000) / 1000)} s`]);
  });

  it("gives a long clip longer, within a ceiling", () => {
    expect(cloudBudgetMs(2_000)).toBe(5_000);
    expect(cloudBudgetMs(60_000)).toBe(20_000);
  });
});

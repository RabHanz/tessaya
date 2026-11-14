// @effect-diagnostics globalTimers:off extendsNativeError:off
/**
 * Speech to text on his own cloud key (BYOK): OpenAI, Gemini or OpenRouter. Local Parakeet stays the default; this is only
 * used when he picks Cloud, and a failure or a slow answer falls back to the local model for that utterance, so no words are
 * lost. Pure apart from the `fetch` it is given: the key is passed in per call and never kept or logged here.
 */

import { languageName } from "./dictationLanguages.ts";

export type CloudSttProvider = "openai" | "gemini" | "openrouter";
export const CLOUD_STT_PROVIDERS: ReadonlyArray<CloudSttProvider> = [
  "openai",
  "gemini",
  "openrouter",
];

export const PROVIDER_LABEL: Readonly<Record<CloudSttProvider, string>> = {
  openai: "OpenAI",
  gemini: "Google Gemini",
  openrouter: "OpenRouter",
};

/** The one each provider is set to when he has not picked, and why, in a line. */
export const RECOMMENDED: Readonly<
  Record<CloudSttProvider, { readonly model: string; readonly why: string }>
> = {
  openai: {
    model: "gpt-4o-mini-transcribe",
    why: "Fast and cheap, nearly as accurate as gpt-4o-transcribe.",
  },
  gemini: {
    model: "gemini-2.5-flash",
    why: "Quick and accurate in many languages; flash-lite is cheaper but misses more.",
  },
  openrouter: {
    model: "google/gemini-2.5-flash",
    why: "The quickest accurate audio model OpenRouter serves; costs about the same as Gemini direct.",
  },
};

type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export interface CloudModel {
  readonly id: string;
  readonly label: string;
  readonly recommended: boolean;
}

/** Why a cloud call did not give words: each gets its own note, and a refused key stops the cloud until a new one. */
export type CloudFailure = "timeout" | "key" | "model" | "empty" | "other";

/** A failure that says what went wrong with only the status and the provider's short code: never the key, the audio or the body. */
export class CloudSttError extends Error {
  readonly failure: CloudFailure;
  constructor(message: string, failure: CloudFailure = "other") {
    super(message);
    this.failure = failure;
  }
}

const PROMPT =
  "Transcribe this audio exactly as spoken. Reply with the transcript only: no quotes, no labels, no notes.";
// The models read a name better than a code: "French", not "fr".
const promptFor = (language: string | null) =>
  language === null ? PROMPT : `${PROMPT} The speaker's language is ${languageName(language)}.`;

const base64 = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64");

/** The provider's own short error code (OpenAI `code`/`type`, Gemini `status`, OpenRouter `code`), if it is a plain word. */
const codeOf = (body: unknown): string | null => {
  const error = (body as { error?: Record<string, unknown> } | null)?.error;
  const code = error?.["code"] ?? error?.["status"] ?? error?.["type"];
  const text = typeof code === "number" ? String(code) : code;
  return typeof text === "string" && /^[A-Za-z0-9_.-]{1,40}$/.test(text) ? text : null;
};

const failed = async (provider: CloudSttProvider, response: Response): Promise<never> => {
  const code = codeOf(await response.json().catch(() => null));
  const failure: CloudFailure =
    response.status === 401 || response.status === 403
      ? "key"
      : response.status === 404 || (response.status === 400 && code !== null && /model/i.test(code))
        ? "model"
        : "other";
  throw new CloudSttError(
    `${PROVIDER_LABEL[provider]} answered ${response.status}${code === null ? "" : ` (${code})`}`,
    failure,
  );
};

const json = async (provider: CloudSttProvider, response: Response): Promise<unknown> => {
  if (!response.ok) await failed(provider, response);
  return response.json();
};

/** The models that can turn speech into text, the recommended one first. */
export const listCloudModels = async (
  provider: CloudSttProvider,
  key: string,
  fetch: Fetch,
): Promise<ReadonlyArray<CloudModel>> => {
  let ids: string[];
  if (provider === "openai") {
    const body = (await json(
      provider,
      await fetch("https://api.openai.com/v1/models", {
        headers: { authorization: `Bearer ${key}` },
        redirect: "error",
      }),
    )) as { data?: Array<{ id?: string }> };
    ids = (body.data ?? [])
      .map((m) => m.id ?? "")
      .filter((id) => /transcribe|whisper/.test(id) && !/diarize|realtime/.test(id));
  } else if (provider === "gemini") {
    const body = (await json(
      provider,
      await fetch("https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000", {
        headers: { "x-goog-api-key": key },
        redirect: "error",
      }),
    )) as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
    };
    ids = (body.models ?? [])
      .filter((m) => m.supportedGenerationMethods?.includes("generateContent") === true)
      .map((m) => (m.name ?? "").replace(/^models\//, ""))
      // Gemini models hear audio; the image, speech-out, embedding and live variants do not transcribe through this call.
      .filter((id) => /^gemini-/.test(id) && !/image|tts|embedding|live|native-audio/.test(id));
  } else {
    const body = (await json(
      provider,
      await fetch("https://openrouter.ai/api/v1/models", {
        headers: { authorization: `Bearer ${key}` },
        redirect: "error",
      }),
    )) as {
      data?: Array<{ id?: string; architecture?: { input_modalities?: string[] } }>;
    };
    ids = (body.data ?? [])
      .filter((m) => m.architecture?.input_modalities?.includes("audio") === true)
      .map((m) => m.id ?? "");
  }
  const recommended = RECOMMENDED[provider].model;
  return [...new Set(ids.filter((id) => id !== ""))]
    .toSorted((a, b) => Number(b === recommended) - Number(a === recommended) || a.localeCompare(b))
    .map((id) => ({
      id,
      label: id === recommended ? `${id} (recommended)` : id,
      recommended: id === recommended,
    }));
};

export interface CloudTranscribeInput {
  readonly provider: CloudSttProvider;
  readonly key: string;
  readonly model: string;
  /** 16 kHz mono 16-bit WAV. */
  readonly wav: Uint8Array;
  /** His language as an ISO 639-1 code, or null to let the model detect it. */
  readonly language: string | null;
  readonly fetch: Fetch;
  readonly signal?: AbortSignal;
}

const textOf = (value: unknown): string => (typeof value === "string" ? value.trim() : "");

/** The words in one clip, on his key. Throws `CloudSttError` (or the abort) on any failure, for the caller's fallback. */
export const cloudTranscribe = async (input: CloudTranscribeInput): Promise<string> => {
  const { provider, key, model, wav, language, fetch, signal } = input;
  if (provider === "openai") {
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array(wav)], { type: "audio/wav" }), "audio.wav");
    form.append("model", model);
    form.append("response_format", "json");
    if (language !== null) form.append("language", language);
    const body = (await json(
      provider,
      await fetch("https://api.openai.com/v1/audio/transcriptions", {
        method: "POST",
        // A key is never carried to another host.
        redirect: "error",
        headers: { authorization: `Bearer ${key}` },
        body: form,
        ...(signal === undefined ? {} : { signal }),
      }),
    )) as { text?: unknown };
    return textOf(body.text);
  }
  if (provider === "gemini") {
    const body = (await json(
      provider,
      await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          // A key is never carried to another host.
          redirect: "error",
          headers: { "x-goog-api-key": key, "content-type": "application/json" },
          body: JSON.stringify({
            contents: [
              {
                parts: [
                  { text: promptFor(language) },
                  { inline_data: { mime_type: "audio/wav", data: base64(wav) } },
                ],
              },
            ],
            generationConfig: { temperature: 0 },
          }),
          ...(signal === undefined ? {} : { signal }),
        },
      ),
    )) as { candidates?: Array<{ content?: { parts?: Array<{ text?: unknown }> } }> };
    return (body.candidates?.[0]?.content?.parts ?? [])
      .map((p) => textOf(p.text))
      .join(" ")
      .trim();
  }
  const body = (await json(
    provider,
    await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      // A key is never carried to another host.
      redirect: "error",
      headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: promptFor(language) },
              { type: "input_audio", input_audio: { data: base64(wav), format: "wav" } },
            ],
          },
        ],
      }),
      ...(signal === undefined ? {} : { signal }),
    }),
  )) as { choices?: Array<{ message?: { content?: unknown } }> };
  return textOf(body.choices?.[0]?.message?.content);
};

/** How long a cloud answer may take before the local model hears the clip instead: a few seconds plus half its length. */
export const cloudBudgetMs = (audioMs: number): number =>
  Math.min(20_000, 4_000 + Math.round(audioMs / 2));

/**
 * Cloud first, within the budget; on any failure the local recogniser hears the same audio, and `onFallback` is told
 * once per utterance (a quiet note, never the key). The words are never lost to a cloud failure.
 */
export const transcribeWithFallback = async (input: {
  readonly cloud: (signal: AbortSignal) => Promise<string>;
  readonly local: () => Promise<string>;
  readonly audioMs: number;
  readonly onFallback: (reason: {
    readonly failure: CloudFailure;
    readonly detail: string;
  }) => void;
  /** A test passes its own; real time by default. */
  readonly timer?: (ms: number, abort: () => void) => () => void;
}): Promise<{ readonly text: string; readonly via: "cloud" | "local" }> => {
  const controller = new AbortController();
  const timer =
    input.timer ??
    ((ms: number, abort: () => void) => {
      const id = setTimeout(abort, ms);
      return () => clearTimeout(id);
    });
  const budget = cloudBudgetMs(input.audioMs);
  let timedOut!: (error: Error) => void;
  // Raced as well as aborted: a call that ignores the signal still cannot hold his words past the budget.
  const late = new Promise<never>((_, reject) => (timedOut = reject));
  const cancel = timer(budget, () => {
    controller.abort();
    timedOut(new CloudSttError("timed out", "timeout"));
  });
  try {
    const text = await Promise.race([input.cloud(controller.signal), late]);
    // Nothing back for audio he spoke is a failure too: the local model may still hear words in it.
    if (text.trim() === "") throw new CloudSttError("an empty answer", "empty");
    return { text, via: "cloud" };
  } catch (error) {
    input.onFallback(
      controller.signal.aborted
        ? { failure: "timeout", detail: `no answer in ${Math.round(budget / 1000)} s` }
        : error instanceof CloudSttError
          ? { failure: error.failure, detail: error.message }
          : // A network error's message names the host at most, never the key.
            { failure: "other", detail: error instanceof Error ? error.message : String(error) },
    );
    return { text: await input.local(), via: "local" };
  } finally {
    cancel();
  }
};

import type { EnvironmentSpeechModel } from "@t3tools/contracts";
import catalog from "./catalog.json" with { type: "json" };

export type SpeechModel = {
  readonly id: string;
  readonly revision: string;
  readonly name: string;
  readonly description: string;
  readonly filename: string;
  readonly size: number;
  readonly sha256: string;
  readonly languages: readonly string[];
  readonly accuracy: number;
  readonly speed: number;
  readonly benchmark: NonNullable<EnvironmentSpeechModel["benchmark"]>;
  readonly recommended: boolean;
  readonly supportsStreaming: boolean;
  readonly supportsLanguageDetection: boolean;
  readonly supportsTranslation: boolean;
};

// Scores remain required by the wire schema but are not displayed.
export const SPEECH_MODELS: readonly SpeechModel[] = catalog.models.map((model) => ({
  ...model,
  accuracy: 0,
  speed: 0,
}));

export const DEFAULT_SPEECH_MODEL_ID = "handy-computer/parakeet-unified-en-0.6b-gguf";
export const getSpeechModel = (modelId: string): SpeechModel | undefined =>
  SPEECH_MODELS.find((model) => model.id === modelId);

export const PERSONAL_SPEECH_MODEL_ID = "tessaya/personal";
const TDT_V3 = getSpeechModel("handy-computer/parakeet-tdt-0.6b-v3-gguf")!;

/**
 * A person's own fine-tune of Parakeet TDT v3, found where the desktop finds it (`voiceModels.ts`):
 * `<home>/.tessaya/personal-models/manifest.json` names one GGUF beside it with its size and sha256.
 */
export const personalSpeechModel = (manifest: unknown): SpeechModel | undefined => {
  if (typeof manifest !== "object" || manifest === null) return undefined;
  const { name, size, sha256 } = manifest as Record<string, unknown>;
  if (
    typeof name !== "string" ||
    !/^[^/\\:]+\.gguf$/.test(name) ||
    name.startsWith(".") ||
    typeof size !== "number" ||
    typeof sha256 !== "string" ||
    !/^[0-9a-f]{64}$/.test(sha256)
  )
    return undefined;
  return {
    ...TDT_V3,
    id: PERSONAL_SPEECH_MODEL_ID,
    revision: sha256,
    name: "Personal",
    description: "Trained on your own voice",
    filename: name,
    size,
    sha256,
    languages: ["en"],
    benchmark: { ...TDT_V3.benchmark, accuracy: {} },
    recommended: true,
    supportsLanguageDetection: false,
  };
};

export { effectiveSpeechLanguage } from "@t3tools/shared/speech";

import { chosenWakeWords, type WakeChoices } from "@t3tools/tessaya-shared/wakeWords";
import {
  createOpenWakeWordProvider,
  createOpenWakeWordScorerWith,
} from "@t3tools/tessaya-shared/openWakeWord";
import { Asset } from "expo-asset";

// The desktop's and the room loop's own models (Metro needs literal paths), every shipped word, so his choice holds here.
const FEATURES = {
  melspectrogram:
    require("../../../../../native/baton-dictation/models/melspectrogram.onnx") as number,
  embedding: require("../../../../../native/baton-dictation/models/embedding_model.onnx") as number,
};
const WORDS: Readonly<Record<string, number>> = {
  Tessaya: require("../../../../../native/baton-dictation/models/tessaya.onnx") as number,
  Alfred: require("../../../../../native/baton-dictation/models/alfred.onnx") as number,
  Freya: require("../../../../../native/baton-dictation/models/freya.onnx") as number,
  Sebastian: require("../../../../../native/baton-dictation/models/sebastian.onnx") as number,
  Onyx: require("../../../../../native/baton-dictation/models/onyx.onnx") as number,
};

// onnxruntime takes the file:// URI as it is
const local = async (module: number) => {
  const asset = await Asset.fromModule(module).downloadAsync();
  return asset.localUri ?? asset.uri;
};

export interface SleeveWake {
  /** Feeds 16 kHz PCM16; true on the frame her wake word fired. */
  readonly heard: (frame: Int16Array) => boolean;
  readonly reset: () => void;
}

/** His wake words on this phone, as he chose them in her brain, scored by the desktop's and the room loop's pipeline. */
export const loadSleeveWake = async (choices: WakeChoices): Promise<SleeveWake> => {
  const words = chosenWakeWords(choices).filter((w) => w.enabled && WORDS[w.word] !== undefined);
  const [melspectrogram, embedding, ...paths] = await Promise.all([
    local(FEATURES.melspectrogram),
    local(FEATURES.embedding),
    ...words.map((w) => local(WORDS[w.word]!)),
  ]);
  // loaded here, not at the top: its import runs the native install and throws when that fails, which would take the app down
  const Ort = await import("onnxruntime-react-native");
  const wake = await createOpenWakeWordProvider(
    {
      melspectrogram: melspectrogram!,
      embedding: embedding!,
      wakes: words.map((w, i) => ({ word: w.word, path: paths[i]!, threshold: w.threshold })),
    },
    (p) => createOpenWakeWordScorerWith(Ort, p),
  );
  return { heard: (frame) => wake.process(frame) !== null, reset: wake.reset };
};

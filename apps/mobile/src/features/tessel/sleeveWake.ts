import { WAKE_WORDS } from "@t3tools/tessaya-shared/wakeWords";
import {
  createOpenWakeWordProvider,
  createOpenWakeWordScorerWith,
} from "@t3tools/tessaya-shared/openWakeWord";
import { Asset } from "expo-asset";
import * as Ort from "onnxruntime-react-native";

// The desktop's and the room loop's own models (Metro needs literal paths); only the words a fresh install wakes to ride in the app.
const FEATURES = {
  melspectrogram:
    require("../../../../../native/baton-dictation/models/melspectrogram.onnx") as number,
  embedding: require("../../../../../native/baton-dictation/models/embedding_model.onnx") as number,
};
const WORDS: Readonly<Record<string, number>> = {
  Tessaya: require("../../../../../native/baton-dictation/models/tessaya.onnx") as number,
  Alfred: require("../../../../../native/baton-dictation/models/alfred.onnx") as number,
  Freya: require("../../../../../native/baton-dictation/models/freya.onnx") as number,
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

/** Her wake words on this phone, scored by the same pipeline and thresholds as the desktop and the room loop. */
export const loadSleeveWake = async (): Promise<SleeveWake> => {
  const words = WAKE_WORDS.filter((w) => w.onByDefault && WORDS[w.word] !== undefined);
  const [melspectrogram, embedding, ...paths] = await Promise.all([
    local(FEATURES.melspectrogram),
    local(FEATURES.embedding),
    ...words.map((w) => local(WORDS[w.word]!)),
  ]);
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

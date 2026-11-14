// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
/**
 * Sentence vectors for recall by meaning (MEM-13, MEM-16): bge-small-en-v1.5 int8 in a child process, so a native crash or an
 * out-of-memory in onnxruntime ends the child, never the server. Tokens are cut here; the child only runs the model.
 * No model, no onnxruntime, or a child that keeps failing: recall stays on keywords.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { clsPool } from "./memoryVectors.ts";
import { createWordPiece } from "./wordpiece.ts";

const MODEL_NAME = "bge-small-en-v1.5-int8";
const MODEL_FILE = "model_quantized.onnx";
const VOCAB_FILE = "vocab.txt";
const DIM = 384;
/** Memory items are short; a long one is read by its first 128 tokens, which bounds the cost of one. */
const MAX_TOKENS = 128;
const CALL_MS = 10_000;
/** bge reads a search question with this instruction; stored items are embedded as they are. */
const QUERY_PREFIX = "Represent this sentence for searching relevant passages: ";
/** A child that dies this many times is not started again until the server restarts; recall stays on keywords. */
export const MAX_CHILD_FAILURES = 3;
/** Before each new child after a failure: 5 s, 10 s, 20 s. */
const BACKOFF_MS = 5_000;

/** The model run failed or timed out; recall then goes on without this sentence's vector. */
export class TessayaMemoryEmbedError extends Schema.TaggedError<TessayaMemoryEmbedError>()(
  "BatonMemoryEmbedError",
  { reason: Schema.String },
) {}

export class TessayaMemoryEmbedder extends Context.Service<
  TessayaMemoryEmbedder,
  {
    /** The model's id (name and file hash), or null when this server has none (keyword recall only). */
    readonly model: string | null;
    /** The text's unit vector (as a search question when `query`), or null when the model is missing, failed, or off. */
    readonly embed: (text: string, query?: boolean) => Effect.Effect<Float32Array | null>;
  }
>()("t3/tessaya/TessayaMemoryEmbedder") {}

const noModel = TessayaMemoryEmbedder.of({
  model: null,
  embed: Effect.fn("BatonMemoryEmbedder.embed")(function* (_text: string) {
    return null;
  }),
});
/** No model: recall is keyword-only. Tests and a server without the files use this. */
export const layerNone = Layer.succeed(TessayaMemoryEmbedder, noModel);

/**
 * The child, as CommonJS source: run by `node -e` (Electron as Node on the desktop), or by the single executable's
 * `__memory-embed` subcommand, which has no Node to run a script with. The session is created once (its promise is kept).
 */
export const CHILD_SOURCE = `
const ort = require(process.env.TESSAYA_MEMORY_ORT);
let session = null;
process.on("message", async ({ id, ids }) => {
  try {
    session ??= ort.InferenceSession.create(process.env.TESSAYA_MEMORY_MODEL, {
      intraOpNumThreads: 1,
      interOpNumThreads: 1,
      executionMode: "sequential",
    });
    const ready = await session;
    const shape = [1, ids.length];
    const tensor = (values) => new ort.Tensor("int64", BigInt64Array.from(values, BigInt), shape);
    const out = await ready.run({
      input_ids: tensor(ids),
      attention_mask: tensor(ids.map(() => 1)),
      token_type_ids: tensor(ids.map(() => 0)),
    });
    process.send({ id, data: out.last_hidden_state.data });
  } catch (error) {
    process.send({ id, error: String((error && error.message) || error) });
  }
});
process.on("disconnect", () => process.exit(0));
`;

/** The single executable's way in: it runs the same child source in its own process. */
export const runMemoryEmbedChild = () =>
  new Function("require", "process", CHILD_SOURCE)(
    NodeModule.createRequire(import.meta.url),
    process,
  ) as void;

/** Where the model files are: an explicit folder, beside the server executable, or the repo's resources in development. */
const modelDirs = (): ReadonlyArray<string> => [
  ...(process.env["TESSAYA_MEMORY_MODEL_DIR"] ? [process.env["TESSAYA_MEMORY_MODEL_DIR"]] : []),
  NodePath.join(NodePath.dirname(process.execPath), "memory-model"),
  NodeURL.fileURLToPath(new URL("../../resources/memory-model", import.meta.url)),
];

export interface EmbedderLocation {
  readonly dir: string;
  /** onnxruntime-node's entry file, resolved from disk as node-pty is. */
  readonly ort: string;
}

const findModel = (): EmbedderLocation | null => {
  const dir = modelDirs().find(
    (d) =>
      NodeFS.existsSync(NodePath.join(d, MODEL_FILE)) &&
      NodeFS.existsSync(NodePath.join(d, VOCAB_FILE)),
  );
  if (dir === undefined) return null;
  try {
    return { dir, ort: NodeModule.createRequire(import.meta.url).resolve("onnxruntime-node") };
  } catch {
    return null;
  }
};

/** The embedder for a model at `location`; exported so a test can point it at a model that cannot load. */
export const makeEmbedder = Effect.fn("BatonMemoryEmbedder.make")(function* (
  location: EmbedderLocation,
) {
  const modelPath = NodePath.join(location.dir, MODEL_FILE);
  // Hashed once at start, so vectors from a different file (another revision) are never compared with these.
  const fileHash = NodeCrypto.createHash("sha256")
    .update(NodeFS.readFileSync(modelPath))
    .digest("hex")
    .slice(0, 12);
  const words = createWordPiece(
    NodeFS.readFileSync(NodePath.join(location.dir, VOCAB_FILE), "utf8"),
  );
  const isExecutable = yield* HostProcess.IsExecutable;
  const executable = yield* HostProcess.ExecutablePath;

  let child: NodeChildProcess.ChildProcess | null = null;
  let failures = 0;
  let notBefore = 0;
  let next = 0;
  const waiting = new Map<number, (reply: { data?: Float32Array; error?: string }) => void>();
  const start = (): NodeChildProcess.ChildProcess => {
    const made = NodeChildProcess.spawn(
      executable,
      isExecutable ? ["__memory-embed"] : ["-e", CHILD_SOURCE],
      {
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        // Typed arrays cross as they are, not as JSON.
        serialization: "advanced",
        env: {
          ...process.env,
          ELECTRON_RUN_AS_NODE: "1",
          TESSAYA_MEMORY_ORT: location.ort,
          TESSAYA_MEMORY_MODEL: modelPath,
        },
        windowsHide: true,
      },
    );
    made.on("message", (reply: { id: number; data?: Float32Array; error?: string }) => {
      waiting.get(reply.id)?.(reply);
      waiting.delete(reply.id);
    });
    const ended = () => {
      if (child !== made) return;
      child = null;
      failures += 1;
      notBefore = Date.now() + BACKOFF_MS * 2 ** (failures - 1);
      for (const [, answer] of waiting) answer({ error: "the embedding child stopped" });
      waiting.clear();
    };
    made.on("exit", ended);
    made.on("error", ended);
    made.unref();
    made.channel?.unref();
    return made;
  };
  yield* Effect.addFinalizer(() => Effect.sync(() => child?.kill()));

  const run = (ids: ReadonlyArray<number>) =>
    new Promise<Float32Array>((resolve, reject) => {
      if (failures >= MAX_CHILD_FAILURES)
        return reject(new Error("embedding is off after failures"));
      if (child === null && Date.now() < notBefore)
        return reject(new Error("embedding is backing off"));
      child ??= start();
      const id = (next += 1);
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error("the embedding child did not answer"));
      }, CALL_MS);
      waiting.set(id, (reply) => {
        clearTimeout(timer);
        if (reply.data !== undefined) resolve(reply.data);
        else reject(new Error(reply.error ?? "no answer"));
      });
      child.send({ id, ids }, (error) => {
        if (error === null) return;
        waiting.get(id)?.({ error: error.message });
        waiting.delete(id);
      });
    });

  return TessayaMemoryEmbedder.of({
    model: `${MODEL_NAME}-${fileHash}`,
    embed: Effect.fn("BatonMemoryEmbedder.embed")(function* (text: string, query?: boolean) {
      const ids = words.encode(query === true ? QUERY_PREFIX + text : text, MAX_TOKENS);
      return yield* Effect.tryPromise({
        try: () => run(ids),
        catch: (error) =>
          new TessayaMemoryEmbedError({
            reason: error instanceof Error ? error.message : String(error),
          }),
      }).pipe(
        Effect.map((hidden) => clsPool(hidden, DIM)),
        Effect.catch((error) =>
          Effect.logWarning("memory embedding failed", error.reason).pipe(Effect.as(null)),
        ),
      );
    }),
  });
});

const make = Effect.gen(function* () {
  const found = findModel();
  if (found === null) {
    yield* Effect.logInfo(
      "memory recall by meaning is off: no model or onnxruntime on this server",
    );
    return noModel;
  }
  const embedder = yield* makeEmbedder(found);
  // Loaded in the background at start, so the first recall is not keyword-only while the model loads (~1 s).
  yield* embedder.embed("warm up").pipe(Effect.delay("5 seconds"), Effect.forkScoped);
  return embedder;
});

export const layer = Layer.effect(TessayaMemoryEmbedder, make);

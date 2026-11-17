// @effect-diagnostics nodeBuiltinImport:off
/**
 * The replay check (V-045): does this clip come from a loudspeaker rather than a live voice in the room? A small CNN
 * trained on his room (the Tessel hearing him live, and his own clips and his clone played through the office speaker).
 * Waveform in, one logit out (replay when above the cut-off). Runs beside the speaker embedder.
 *
 * @module baton-voice/providers/replayOnnx
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import type * as Ort from "onnxruntime-node";

let ortModule: Promise<typeof Ort> | undefined;
const loadOrt = () => (ortModule ??= import("onnxruntime-node"));

/** Six seconds says all the clip has to say about the speaker it came through. */
const MAX_SAMPLES = 6 * 16_000;

export interface ReplayCheck {
  /** The replay logit for the clip, or null when it is under half a second or the output is broken. */
  readonly logit: (pcm: Int16Array) => Promise<number | null>;
}

export const createReplayCheck = async (path: string, threads = 1): Promise<ReplayCheck> => {
  const ort = await loadOrt();
  const session = await ort.InferenceSession.create(path, {
    intraOpNumThreads: threads,
    interOpNumThreads: 1,
    executionMode: "sequential",
  });
  return {
    logit: async (pcm) => {
      if (pcm.length < 8_000) return null;
      const clip = pcm.subarray(0, MAX_SAMPLES);
      const data = Float32Array.from(clip, (x) => x / 32768);
      const out = await session.run({ pcm: new ort.Tensor("float32", data, [1, data.length]) });
      const v = (Object.values(out)[0]!.data as Float32Array)[0];
      return v !== undefined && Number.isFinite(v) ? v : null;
    },
  };
};

export type ReplayStatus =
  | { readonly state: "loaded"; readonly sha: string }
  | { readonly state: "missing" | "failed"; readonly reason: string; readonly degraded: boolean };

/**
 * The check and what became of it, for the start log and the ready line. Without it every room-mic turn stays
 * unverified (replayChecked), so owner-only acts need the step-up; `expected` marks that as degraded on this host.
 */
export const loadReplayCheck = async (
  path: string,
  expected: boolean,
): Promise<{ readonly check: ReplayCheck | null; readonly status: ReplayStatus }> => {
  let bytes: Buffer;
  try {
    bytes = NodeFS.readFileSync(path);
  } catch (error) {
    const reason =
      (error as NodeJS.ErrnoException).code === "ENOENT" ? `no ${path}` : String(error);
    return { check: null, status: { state: "missing", reason, degraded: expected } };
  }
  try {
    const check = await createReplayCheck(path);
    const sha = NodeCrypto.createHash("sha256").update(bytes).digest("hex").slice(0, 8);
    return { check, status: { state: "loaded", sha } };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { check: null, status: { state: "failed", reason, degraded: expected } };
  }
};

export const replayStatusLine = (s: ReplayStatus): string =>
  s.state === "loaded"
    ? `replay check loaded (sha ${s.sha})`
    : `replay check ${s.degraded ? "DEGRADED, " : ""}${s.state}: ${s.reason}; owner-only acts need the step-up`;

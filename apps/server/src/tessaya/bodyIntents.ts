/**
 * Her motion library recalled by meaning (M-081): each `intent` in a move (and in its later steps) is matched to the
 * nearest library entry by sentence vectors from the memory embedder, fused with the word ranking, and named by id, so
 * the decoder plays that entry. With no model on this server the move goes on unchanged and the decoder matches words.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { recallByMeaning } from "@t3tools/tessaya-shared/bodyLibrary";
import { MOTION_LIBRARY } from "@t3tools/tessaya-shared/bodyMotionLibrary";

import { TessayaMemoryEmbedder } from "./TessayaMemoryEmbedder.ts";

// entry vectors by model id: the library is fixed per build, so each is embedded once
let cached: { readonly model: string; readonly vectors: Map<string, Float32Array> } | null = null;

const isObj = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const resolveIntents = Effect.fn("TessayaBody.resolveIntents")(function* (raw: unknown) {
  const embedder = Option.getOrNull(yield* Effect.serviceOption(TessayaMemoryEmbedder));
  const steps = isObj(raw)
    ? [raw, ...(Array.isArray(raw["then"]) ? raw["then"].filter(isObj) : [])]
    : [];
  if (embedder?.model == null || !steps.some((s) => typeof s["intent"] === "string")) return raw;
  if (cached?.model !== embedder.model) {
    const vectors = new Map<string, Float32Array>();
    for (const e of MOTION_LIBRARY) {
      const v = yield* embedder.embed(e.text);
      if (v !== null) vectors.set(e.id, v);
    }
    cached = { model: embedder.model, vectors };
  }
  const vectors = cached.vectors;
  const named = new Map<string, string>();
  for (const s of steps) {
    const intent = s["intent"];
    if (typeof intent !== "string" || named.has(intent)) continue;
    const hit = recallByMeaning(
      intent,
      MOTION_LIBRARY,
      yield* embedder.embed(intent.slice(0, 200), true),
      vectors,
    );
    if (hit !== null) named.set(intent, hit.id);
  }
  const name = (s: Record<string, unknown>) =>
    typeof s["intent"] === "string" && named.has(s["intent"])
      ? { ...s, intent: named.get(s["intent"]) }
      : s;
  const top = name(raw as Record<string, unknown>);
  return Array.isArray(top["then"])
    ? { ...top, then: top["then"].map((s: unknown) => (isObj(s) ? name(s) : s)) }
    : top;
});

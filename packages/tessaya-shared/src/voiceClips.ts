/**
 * Per-voice clips, voice → name → variants. A "sound" is a nonverbal a voice cannot make from text (a Pocket voice
 * reads "*coughs*" as silence or a word), made once from that voice's own Pocket vowels and spliced by
 * `speechSplice.ts`.
 * A "reference" (`affect-tender` …) is an embedding a whole line is spoken with, recorded beside a cloned voice.
 */
import { CLIP_DATA } from "./voiceClips.data.ts";

export type VoiceClipSet =
  | { readonly kind: "sound"; readonly rate: number; readonly variants: ReadonlyArray<Int16Array> }
  | { readonly kind: "reference"; readonly embeddings: ReadonlyArray<string> };

/** G.711 μ-law, which keeps the clips a third of their PCM size with no decoder to ship. */
const fromMuLaw = (byte: number): number => {
  const u = ~byte & 0xff;
  const magnitude = (((u & 0x0f) << 3) + 0x84) << ((u & 0x70) >> 4);
  return u & 0x80 ? 0x84 - magnitude : magnitude - 0x84;
};

const decode = (base64: string): Int16Array => {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return Int16Array.from(bytes, fromMuLaw);
};

const CLIP_DATA_RATE = 16_000;
const sets = new Map<string, VoiceClipSet>();

export const voiceClips = (voice: string, name: string): VoiceClipSet | undefined => {
  const key = `${voice}/${name}`;
  const known = sets.get(key);
  if (known !== undefined) return known;
  const data = CLIP_DATA[voice]?.[name];
  if (data === undefined) return undefined;
  const set: VoiceClipSet = { kind: "sound", rate: CLIP_DATA_RATE, variants: data.map(decode) };
  sets.set(key, set);
  return set;
};

/**
 * The embedding a line in this tone is spoken with: the voice's `affect-<name>` reference, when it has one. Pocket's
 * /tts takes it only as an http(s) or hf:// URL (3.3.0 refuses a local path or file://), so a reference is kept as one.
 */
export const affectReference = (voice: string, affect: string): string | undefined => {
  const set = voiceClips(voice, `affect-${affect}`);
  return set?.kind === "reference"
    ? set.embeddings.find((e) => /^(https?|hf):\/\//.test(e))
    : undefined;
};

/**
 * Every voice Tessaya can speak in, for the voice list in Settings and each persona's picker: Pocket TTS's 27 English
 * embeddings (on the machine) and, with his Google key saved, Gemini TTS's en-GB library. Licences are from
 * kyutai/tts-voices (docs/baton/THIRD_PARTY_NOTICES.md); a voice with a non-commercial source or no licence line of
 * its own is "personal use": his to choose, and left out of a commercial build.
 */
import { GEMINI_EN_GB_VOICES } from "./geminiVoices.ts";

export const POCKET_VOICE_REVISION = "a3055dcb533cf2ec90458008a01e7cef550bae2a";
export const pocketVoiceUrl = (name: string): string =>
  `https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve/${POCKET_VOICE_REVISION}/languages/english/embeddings/${name}.safetensors`;

export type VoiceLicence = "cc-by-4.0" | "cc0" | "cc-by-nc-4.0" | "unlisted" | "google";
export const LICENCE_LABELS: Readonly<Record<VoiceLicence, string>> = {
  "cc-by-4.0": "CC BY 4.0",
  cc0: "CC0",
  "cc-by-nc-4.0": "Personal use",
  unlisted: "Personal use",
  google: "Google API",
};
const PERSONAL: ReadonlySet<VoiceLicence> = new Set(["cc-by-nc-4.0", "unlisted"]);

/**
 * Name, bytes and sha256 at the pinned revision (Hugging Face API), the recording's licence, and the gender and pitch
 * heard in the library's sample line (median pitch, voice-lab `pitchOfWav`, 2026-11-11).
 */
const POCKET_TABLE = [
  [
    "alba",
    6244152,
    "4206b7194018c7e345e5cfd99f147caad36285df858ea153d0188c40d9f261e5",
    "unlisted",
    "female",
    "low",
  ],
  [
    "anna",
    7620408,
    "4f1a928fc92ae04367324cc5d880745c1e6680bd56bf99e5d26a1e80c2cff421",
    "cc-by-4.0",
    "female",
    "medium",
  ],
  [
    "azelma",
    7178040,
    "cc09e106a1acf5fe0b4c5de61b2b7686080b7bab853f9c11bfef219801bf3126",
    "cc-by-4.0",
    "female",
    "high",
  ],
  [
    "bill_boerst",
    6539064,
    "063b245f60f682a2403e4c61d2e8754e0a2916d75b2cd515cc97355a9e7a10a8",
    "cc0",
    "male",
    "medium",
  ],
  [
    "caro_davy",
    5064504,
    "971a47f7e655e4e377915b2862f2b1242aa4f27659ed936c85387bc2dfe17595",
    "cc0",
    "female",
    "low",
  ],
  [
    "charles",
    6195000,
    "21806203b56a8ee954b66a33fcdea636c67cd54760f20f12f7586062d9455337",
    "cc-by-4.0",
    "male",
    "low",
  ],
  [
    "cosette",
    6244152,
    "ee63b91d4614e939fa5eb24df8c43de367c552dfd60c1c6b61582a859e25298a",
    "cc-by-nc-4.0",
    "female",
    "medium",
  ],
  [
    "daan",
    3884848,
    "2241724e629acd348f2c810b587441812f1412262b6244378db5f73af430c8ac",
    "unlisted",
    "male",
    "low",
  ],
  [
    "eponine",
    6932280,
    "897d1d697e433f4ac1f0a8957fd2d69b073e316935c681fe488a7bf63a2b9a7b",
    "cc-by-4.0",
    "female",
    "low",
  ],
  [
    "estelle",
    7571256,
    "c6d0487d2a3e3d830b5dc3595ee9804df4920d87beb6dca042d769474e34db75",
    "cc0",
    "female",
    "high",
  ],
  [
    "eve",
    6145848,
    "d31289743fdf306517925afb91e99c27b4d336c127013d2c4d1212791a41cf37",
    "cc-by-4.0",
    "female",
    "medium",
  ],
  [
    "fantine",
    6440760,
    "a1803e41334934b199f4c7a2a4cec1069a75c0b3cb100e3cc3b5e76f0b07dd9e",
    "cc-by-4.0",
    "female",
    "medium",
  ],
  [
    "george",
    5900088,
    "fc5ff4439cbbb532b69d2762524b55844e03352102f13376f2fa00443bc04090",
    "cc-by-4.0",
    "male",
    "medium",
  ],
  [
    "giovanni",
    4130608,
    "abe83e91cc6984dc7d8ae1362fe4282ec095198087db7c2519f7a42dae2d9630",
    "cc0",
    "male",
    "medium",
  ],
  [
    "jane",
    7325496,
    "495ff63b1757ceb68a7a8e2d369b780e9d60dcd98a25ef784e246c65c9af4d90",
    "cc-by-4.0",
    "female",
    "medium",
  ],
  [
    "javert",
    6145848,
    "f60f4603404152370ae5ad4d01fa9ad3e1afd3a5df6122aa3dd88ed95fbfd6f8",
    "cc0",
    "male",
    "low",
  ],
  [
    "jean",
    6096696,
    "2d720746d3f2ec131b4dd67c0b101af7a7006798511bb975c707788e9a2467fc",
    "cc-by-nc-4.0",
    "male",
    "medium",
  ],
  [
    "juergen",
    6096696,
    "1382e92abb0abf4cd531d33d1ad4e6db0c9ebd10ab1b1533421e151f14190450",
    "unlisted",
    "male",
    "low",
  ],
  [
    "lola",
    5457720,
    "5be565a67bc85610d7b1d0a44fb7fb658d5d324504a4341a619ef1641f363503",
    "cc0",
    "female",
    "high",
  ],
  [
    "marius",
    6244152,
    "6fd2496993221be51edc027820fa465b67221d7e369b8caeab40076040d561dd",
    "cc0",
    "male",
    "high",
  ],
  [
    "mary",
    5949240,
    "f05824557190fe66e39837337d65c6c400aa54920bae316e1245eeb4cd447b8b",
    "cc-by-4.0",
    "female",
    "low",
  ],
  [
    "michael",
    7128888,
    "188f29bf53aca645d77accd44455b494a28e17d94b1658fbaec80f679371ad13",
    "cc-by-4.0",
    "male",
    "medium",
  ],
  [
    "paul",
    6833976,
    "02b77e48b791c7ece818d7f85b98459bc8dc035104e6327635053ffb56898050",
    "cc-by-4.0",
    "male",
    "medium",
  ],
  [
    "peter_yearsley",
    3639088,
    "7410cc6531929ea0ea7daa3a3f083a78239701df31acc60583172585a9304c3e",
    "cc0",
    "male",
    "low",
  ],
  [
    "rafael",
    6244152,
    "ce295d539693b6ee3b4dc592e186661502392ceb5e403759a18c3c32acc38dd1",
    "unlisted",
    "male",
    "high",
  ],
  [
    "stuart_bell",
    5064504,
    "6ccec2880941cd132a9997798c8b0350d3dd547c890e45024873a85b017e5b39",
    "cc0",
    "male",
    "high",
  ],
  [
    "vera",
    6686520,
    "6deb7eb7606810edbba1c9639376d6750a8f441e464e279c43341debf5c29765",
    "cc-by-4.0",
    "female",
    "low",
  ],
] as const satisfies ReadonlyArray<
  readonly [string, number, string, VoiceLicence, "female" | "male", "low" | "medium" | "high"]
>;
export type PocketVoiceName = (typeof POCKET_TABLE)[number][0];
export const POCKET_VOICE_FILES = POCKET_TABLE.map(([name, size, sha256]) => ({
  name,
  size,
  sha256,
}));
export const DEFAULT_POCKET_VOICE: PocketVoiceName = "anna";

export interface LibraryVoice {
  readonly engine: "pocket" | "gemini";
  readonly id: string;
  readonly name: string;
  readonly gender: "female" | "male";
  readonly pitch: "low" | "medium" | "high";
  readonly accent: string | null;
  readonly licence: VoiceLicence;
  readonly personalUse: boolean;
}

const title = (id: string) =>
  id
    .split("_")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");

const POCKET_LIBRARY: ReadonlyArray<LibraryVoice> = POCKET_TABLE.map(
  ([id, , , licence, gender, pitch]) => ({
    engine: "pocket",
    id,
    name: title(id),
    gender,
    pitch,
    accent: null,
    licence,
    personalUse: PERSONAL.has(licence),
  }),
);
const GEMINI_LIBRARY: ReadonlyArray<LibraryVoice> = GEMINI_EN_GB_VOICES.map(
  ([id, name, gender, pitch, accent]) => ({
    engine: "gemini",
    id,
    name,
    gender,
    pitch,
    accent,
    licence: "google",
    personalUse: false,
  }),
);

/** A build for sale sets TESSAYA_COMMERCIAL_BUILD=1, which leaves out every personal-use voice. */
export const commercialBuild = (env: Readonly<Record<string, string | undefined>>): boolean =>
  env["TESSAYA_COMMERCIAL_BUILD"] === "1";

export const voiceLibrary = (
  engine: LibraryVoice["engine"],
  options: { readonly commercial: boolean },
): ReadonlyArray<LibraryVoice> =>
  (engine === "pocket" ? POCKET_LIBRARY : GEMINI_LIBRARY).filter(
    (voice) => !(options.commercial && voice.personalUse),
  );

export const isLibraryVoice = (
  engine: LibraryVoice["engine"],
  id: string,
  options: { readonly commercial: boolean },
): boolean => voiceLibrary(engine, options).some((voice) => voice.id === id);

/** The line every preview says, so voices are compared on the same words. */
export const PREVIEW_LINE = "Hello, this is how I sound. Your build passed at half past two.";

export interface PersonaVoices {
  readonly pocket: string;
  /** The Gemini voice to try first; null when none is chosen or cloud voices are off. */
  readonly cloud: string | null;
}

/**
 * What a persona speaks in: its Pocket voice when the library has it (else the default), and its cloud voice only while
 * cloud voices are on. Callers try the cloud voice first and fall back to the Pocket one when it does not answer.
 */
export const resolvePersonaVoice = (
  persona: { readonly voice: string; readonly cloudVoice?: string | null },
  context: { readonly cloud: boolean; readonly commercial: boolean },
): PersonaVoices => {
  const voice = persona.voice.trim().toLowerCase();
  const cloudVoice = persona.cloudVoice?.trim().toLowerCase() ?? "";
  return {
    pocket: isLibraryVoice("pocket", voice, context) ? voice : DEFAULT_POCKET_VOICE,
    cloud: context.cloud && isLibraryVoice("gemini", cloudVoice, context) ? cloudVoice : null,
  };
};

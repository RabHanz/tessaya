/**
 * Her face per mood as a mix of a VRoid model's own part shapes (`Fcl_…` brows, eyes, mouth, teeth), asymmetric where
 * a person's is. Keys drop the `Fcl_` prefix; a pair without its side means both. A model draws what it has; one with
 * none keeps the preset faces. BRW_Knit, BRW_Worry, MTH_Frown, MTH_Press and MTH_O_Big are optional sculpted shapes.
 */
export type FaceRecipe = Readonly<Record<string, number>>;

// open-eyed: the closed-eye smile is for delight and laughter, or at a desk's distance she reads as sleepy
const happy = { BRW_Joy: 0.7, EYE_Joy: 0.2, MTH_Up: 0.8, MTH_Joy: 0.85, MTH_Large: 0.15 };
const sad = {
  BRW_Sorrow: 1,
  BRW_Worry: 0.9,
  EYE_Sorrow: 1,
  EYE_Close: 0.15,
  MTH_Down: 0.6,
  MTH_Sorrow: 0.6,
  MTH_Frown: 0.9,
};
const angry = {
  BRW_Angry: 1,
  BRW_Knit: 1,
  EYE_Angry: 1,
  EYE_Close: 0.2,
  MTH_Angry: 0.6,
  MTH_Press: 1,
  MTH_Frown: 0.35,
};
const fond = { BRW_Fun: 0.35, EYE_Joy: 0.25, MTH_Up: 0.4 };
const worry = {
  BRW_Sorrow: 0.6,
  BRW_Worry: 1,
  EYE_Spread: 0.25,
  MTH_Sorrow: 0.3,
  MTH_Frown: 0.45,
  MTH_Press: 0.25,
  MTH_Small: 0.2,
};

export const FACE_RECIPES: Readonly<Record<string, FaceRecipe>> = {
  neutral: {},
  attentive: { BRW_Surprised: 0.3, EYE_Spread: 0.2 },
  calm: fond,
  steady: fond,
  relaxed: fond,
  relieved: { ...fond, BRW_Sorrow: 0.2, EYE_Close: 0.2 },
  unimpressed: { BRW_Angry: 0.25, EYE_Close: 0.3, MTH_Down: 0.25 },
  bored: { EYE_Close: 0.4, MTH_Down: 0.2, MTH_Small: 0.2 },
  happy,
  delighted: { BRW_Joy: 0.9, EYE_Joy: 0.9, MTH_Joy: 1, MTH_Up: 0.4, MTH_Large: 0.3, MTH_A: 0.2 },
  laughing: { BRW_Joy: 1, EYE_Joy: 1, MTH_Joy: 1, MTH_A: 0.45, MTH_Large: 0.35 },
  giggle: { BRW_Joy: 0.7, EYE_Joy: 0.8, MTH_Joy: 0.8, MTH_I: 0.25 },
  excited: { BRW_Surprised: 0.6, EYE_Spread: 0.5, MTH_Joy: 0.8, MTH_A: 0.3 },
  proud: { BRW_Fun: 0.5, EYE_Joy: 0.3, MTH_Up: 0.5, MTH_Fun: 0.4 },
  // a crooked look: one eye narrower than the other
  smug: { BRW_Fun: 0.5, EYE_Close_L: 0.15, EYE_Joy_R: 0.3, MTH_Up: 0.6, MTH_Fun: 0.5 },
  playful: { BRW_Fun: 0.5, EYE_Joy_R: 0.55, EYE_Close_L: 0.1, MTH_Fun: 0.6, MTH_Up: 0.5 },
  wink: { BRW_Joy: 0.5, EYE_Close_L: 1, MTH_Up: 0.6, MTH_Joy: 0.4 },
  shy: { BRW_Sorrow: 0.5, EYE_Close: 0.15, EYE_Spread: 0.1, MTH_Small: 0.6, MTH_Up: 0.25 },
  love: { BRW_Joy: 0.4, BRW_Sorrow: 0.2, EYE_Joy: 0.5, MTH_Up: 0.6, MTH_Small: 0.35 },
  embarrassed: { BRW_Sorrow: 0.6, EYE_Close: 0.15, MTH_Small: 0.5, MTH_Sorrow: 0.3 },
  curious: {
    BRW_Surprised: 0.55,
    EYE_Close_L: 0.08,
    EYE_Spread: 0.15,
    MTH_Small: 0.3,
    MTH_O: 0.15,
  },
  thinking: { BRW_Angry: 0.3, EYE_Close_R: 0.1, MTH_Small: 0.4, MTH_Down: 0.2 },
  searching: { BRW_Surprised: 0.35, EYE_Spread: 0.25, MTH_Small: 0.3 },
  skeptical: { BRW_Angry: 0.4, EYE_Close_R: 0.18, MTH_Down: 0.3 },
  dizzy: { BRW_Sorrow: 0.4, EYE_Spread: 0.3, MTH_O: 0.3 },
  focused: { BRW_Angry: 0.35, EYE_Close: 0.12, MTH_Small: 0.3 },
  determined: { BRW_Angry: 0.6, EYE_Angry: 0.3, MTH_Small: 0.3, MTH_Down: 0.2 },
  confused: { BRW_Sorrow: 0.4, EYE_Close_L: 0.12, MTH_Down: 0.3, MTH_Small: 0.3 },
  surprised: {
    BRW_Surprised: 1,
    EYE_Surprised: 1,
    EYE_Spread: 1,
    MTH_Surprised: 0.3,
    MTH_Large: 0.2,
    MTH_O_Big: 0.3,
  },
  amazed: { BRW_Surprised: 0.9, EYE_Spread: 0.8, MTH_Joy: 0.4, MTH_A: 0.35 },
  nervous: { ...worry, EYE_Spread: 0.35 },
  concerned: worry,
  worried: worry,
  sad,
  hurt: { ...sad, EYE_Close: 0.3, MTH_Sorrow: 0.7 },
  crying: { ...sad, BRW_Sorrow: 1, EYE_Close: 0.45, MTH_Sorrow: 0.8, MTH_Down: 0.8 },
  lonely: { ...sad, MTH_Down: 0.5 },
  sulky: { BRW_Angry: 0.4, BRW_Sorrow: 0.3, MTH_Down: 0.6, MTH_U: 0.3 },
  putout: { BRW_Angry: 0.4, MTH_Down: 0.5 },
  pout: { BRW_Angry: 0.35, MTH_U: 0.55 },
  annoyed: { ...angry, BRW_Angry: 0.6, MTH_Angry: 0.3 },
  frustrated: { ...angry, BRW_Angry: 0.8 },
  angry: { ...angry, HA_Fung1: 0.4 },
  grumpy: { BRW_Angry: 0.6, EYE_Close: 0.2, MTH_Down: 0.5 },
  sleepy: { BRW_Sorrow: 0.3, EYE_Close: 0.55, MTH_Small: 0.2 },
  asleep: { EYE_Close: 1, MTH_Small: 0.2 },
};

/** Shapes that open her mouth: a feeling stays within these together, so a face never gapes (bodyCues face limits). */
export const OPENING = ["MTH_A", "MTH_O", "MTH_Large", "MTH_Surprised", "MTH_O_Big"];
const FEELING_OPEN = 0.7;

/**
 * A mood's mix at a strength (the spine's intensity, 0 to 1): a mild mood is a mild face, a strong one the whole
 * recipe; null for a label with no recipe. Talking (`speaking`), the opening shapes give way to the words' mouth.
 */
export const recipeWeights = (
  label: string,
  intensity: number,
  speaking = false,
): FaceRecipe | null => {
  if (!Object.hasOwn(FACE_RECIPES, label)) return null;
  const k = 0.35 + 0.65 * Math.max(0, Math.min(1, intensity));
  const out: Record<string, number> = {};
  for (const [key, w] of Object.entries(FACE_RECIPES[label]!)) out[key] = w * k;
  const open = OPENING.reduce((n, key) => n + (out[key] ?? 0), 0);
  const cap = speaking ? FEELING_OPEN * 0.3 : FEELING_OPEN;
  if (open > cap) for (const key of OPENING) if (out[key] !== undefined) out[key] *= cap / open;
  return out;
};

/**
 * How far each mouth shape moves at full weight on the model the recipes were tuned on (Lilac, m). A model whose
 * shape moves further gets proportionally less of it, so a smile is a smile, not a grimace, on any model.
 */
export const TUNED_REACH: Readonly<Record<string, number>> = {
  MTH_Up: 0.008,
  MTH_Down: 0.013,
  MTH_Angry: 0.002,
  MTH_Small: 0.009,
  MTH_Large: 0.02,
  MTH_Fun: 0.003,
  MTH_Joy: 0.006,
  MTH_Sorrow: 0.004,
  MTH_Surprised: 0.008,
  MTH_A: 0.005,
  MTH_I: 0.004,
  MTH_U: 0.006,
  MTH_E: 0.005,
  MTH_O: 0.008,
};

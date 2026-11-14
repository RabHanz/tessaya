/** Outside TessayaTurn.ts: services its tools use (HomeAssistantService) read this, and importing the turn pipeline from them is a load-order cycle. */
import type { Assurance } from "@t3tools/tessaya-shared/household";
import type { SpeakerLike } from "@t3tools/tessaya-shared/privateMemory";
import * as Context from "effect/Context";

export type VesselKind = "desktop" | "device" | "phone" | "web" | "mcp" | "job";

/** The vessel that heard the turn, for every tool it calls: a tool reads it to name where a request came from. */
export const TurnOrigin = Context.Reference<{
  readonly kind: VesselKind;
  readonly id: string;
  readonly label: string;
  /**
   * His own voice, verified on this turn's audio (identity design A2): his yes for what the turn asks, and his words.
   * False for any other voice, an unverified one, or one carried over from an earlier turn.
   */
  readonly hisVoice?: boolean;
  /** Who spoke, so a tool that writes for him knows whose words they are. */
  readonly speaker?: SpeakerLike | null;
  /** The member the turn is from (null: a guest's voice) and how sure (A0-A4): what Trust and the household gate on. */
  readonly member?: string | null;
  readonly assurance?: Assurance;
  /** The turn read outside content. */
  readonly tainted?: boolean;
  readonly persona?: string | null;
  /** A replay or test of the vessel: its writes are dry runs. */
  readonly rehearsal?: boolean;
} | null>("t3/tessaya/TessayaTurn/TurnOrigin", { defaultValue: () => null });

import type { HapticHardware, HapticRendering } from "@t3tools/tessaya-shared/haptics";
import { requireOptionalNativeModule } from "expo";

export interface HapticsModule {
  /** This phone's motor, or null when it has none the player can drive. */
  hardware(): HapticHardware | null;
  /** A rendering made for `hardware()`; any other kind is ignored. */
  play(rendering: HapticRendering): void;
}

/** Null on a build without the native player. */
export const Haptics = requireOptionalNativeModule<HapticsModule>("T3Haptics");

import { batonDesktopBridge } from "@t3tools/baton-contracts";

export type TessayaDictation = NonNullable<
  NonNullable<ReturnType<typeof batonDesktopBridge>>["tessayaDictation"]
>;

/** Tessaya's dictation when its voice runs on this desktop (P8); web and mobile keep T3's own. */
export const tessayaDictation = (): TessayaDictation | undefined =>
  batonDesktopBridge()?.tessayaDictation;

/**
 * T3's microphone controls driving Tessaya's engine and pill: always available (Tessaya owns setup and the microphone),
 * and T3's own recording state stays idle, since the pill shows the recording and Tessaya types the words in.
 */
export function withTessayaDictation<
  Speech extends {
    readonly available: boolean;
    readonly start: () => Promise<void>;
    readonly stop: () => Promise<void>;
    readonly cancel: () => void;
  },
>(speech: Speech, dictation: TessayaDictation | undefined): Speech {
  if (dictation === undefined) return speech;
  return {
    ...speech,
    available: true,
    start: async () => dictation.start(),
    stop: async () => dictation.stop(),
    cancel: () => dictation.stop(),
  };
}

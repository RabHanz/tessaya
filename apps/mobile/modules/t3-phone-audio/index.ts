import { requireOptionalNativeModule } from "expo";

export interface PhoneAudioRoute {
  readonly output:
    | "bluetooth-hfp"
    | "bluetooth-a2dp"
    | "bluetooth-le"
    | "wired"
    | "speaker"
    | "receiver"
    | "other";
  readonly name: string | null;
  readonly headsetMic: boolean;
}

export interface PhoneAudioEvents {
  /** Base64 of exactly 1920 bytes: 60 ms of 16 kHz mono PCM16LE. */
  readonly onMic: { readonly pcm: string };
  readonly onRoute: PhoneAudioRoute;
  /** The headset's play/pause (an AirPods stem press, a wired headset's button). */
  readonly onButton: { readonly button: "play-pause" };
  readonly onState: {
    readonly state: "interrupted" | "resumed" | "error";
    readonly message?: string;
  };
}

/** All PCM is signed 16-bit little-endian, 16 kHz, mono. */
export interface PhoneAudioModule {
  start(): Promise<PhoneAudioRoute>;
  play(pcm: Uint8Array): void;
  flush(): void;
  setMic(on: boolean): Promise<void>;
  stop(): Promise<void>;
  getRoute(): PhoneAudioRoute;
  addListener<K extends keyof PhoneAudioEvents>(
    event: K,
    listener: (event: PhoneAudioEvents[K]) => void,
  ): { remove(): void };
}

export const PhoneAudio = requireOptionalNativeModule<PhoneAudioModule>("T3PhoneAudio");

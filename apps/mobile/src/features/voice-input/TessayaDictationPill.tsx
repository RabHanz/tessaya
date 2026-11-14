/**
 * Dictation in the phone's chat box, in the chosen pill design (tessaya-ops drafts/pill-styles composer.html):
 * ✕ / waveform / ✓ centred in the toolbar, coloured from the phone's theme. Only colour and opacity change between
 * states, nothing reflows, and the waveform is the one thing that moves, from the microphone's level on the UI thread.
 */
import type { PillDesign, PillTokens, WaveName } from "@t3tools/tessaya-shared/composerDictation";
import { BlurView } from "expo-blur";
import { memo } from "react";
import { Platform, Pressable, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  ReduceMotion,
  useAnimatedStyle,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { VOICE_WAVEFORM_SAMPLE_COUNT } from "./voiceInputMetering";

const W = 64;
const H = 18;
const SMOOTH = {
  duration: 100,
  easing: Easing.out(Easing.quad),
  reduceMotion: ReduceMotion.System,
};
const NEWEST = VOICE_WAVEFORM_SAMPLE_COUNT - 1;

/** The level `age` samples back (0 is now), as the drafts' renderers read it. */
const levelAt = (levels: ReadonlyArray<number>, age: number) => {
  "worklet";
  return levels[Math.max(0, NEWEST - Math.round(age))] ?? 0;
};

/** Bars: thin, mirrored about the middle, the centre freshest; silence rests as a row of dots. */
const BARS = 14;
const Bar = memo(function Bar(props: {
  readonly levels: SharedValue<ReadonlyArray<number>>;
  readonly index: number;
  readonly colour: string;
}) {
  const { levels, index } = props;
  const d = Math.abs(index - (BARS - 1) / 2) / ((BARS - 1) / 2);
  const style = useAnimatedStyle(() => {
    const v = levelAt(levels.value, d * 8) * (1 - 0.5 * d * d);
    return {
      opacity: withTiming(0.45 + 0.55 * Math.min(1, v * 2.2), SMOOTH),
      transform: [{ scaleY: withTiming(Math.max(2, v * H) / H, SMOOTH) }],
    };
  });
  return (
    <Animated.View
      style={[{ width: 2, height: H, borderRadius: 1, backgroundColor: props.colour }, style]}
    />
  );
});

/** Beads: round beads that lift and swell with the voice, newest on the right. */
const BEADS = 6;
const R0 = 2.7;
const Bead = memo(function Bead(props: {
  readonly levels: SharedValue<ReadonlyArray<number>>;
  readonly index: number;
  readonly colour: string;
}) {
  const { levels, index } = props;
  const u = index / (BEADS - 1);
  const mid = 1 - 0.35 * Math.abs(u - 0.5) * 2;
  const style = useAnimatedStyle(() => {
    const v = levelAt(levels.value, (BEADS - 1 - index) * 1.5);
    return {
      opacity: withTiming(0.55 + 0.45 * Math.min(1, v * 2), SMOOTH),
      transform: [
        { translateY: withTiming(-v * mid * (H / 2 - R0 * 1.6), SMOOTH) },
        { scale: withTiming(1 + 0.55 * v, SMOOTH) },
      ],
    };
  });
  return (
    <Animated.View
      style={[
        { width: R0 * 2, height: R0 * 2, borderRadius: R0, backgroundColor: props.colour },
        style,
      ]}
    />
  );
});

/** Mound: a lattice of dots lit from the foot up to a surface that swells with the voice; the middle is freshest. */
const COLS = 18;
const PITCH = 3.4;
const ROWS = Math.floor(H / PITCH) + 1;
const FLOOR = 0.12;
const MoundColumn = memo(function MoundColumn(props: {
  readonly levels: SharedValue<ReadonlyArray<number>>;
  readonly index: number;
  readonly colour: string;
}) {
  const { levels, index } = props;
  const u = index / (COLS - 1);
  const d = Math.abs(u - 0.5) * 2;
  const bell = Math.pow(Math.cos((d * Math.PI) / 2), 1.6);
  // The ends fade over 12% of the width, as the drafts' mound does.
  const edge = Math.min(1, Math.min(u, 1 - u) / 0.12);
  const style = useAnimatedStyle(() => {
    const surface = Math.min(0.96, FLOOR + levelAt(levels.value, d * 9) * bell * (1 - FLOOR));
    return { transform: [{ translateY: withTiming((1 - surface) * H, SMOOTH) }] };
  });
  return (
    <View style={{ width: PITCH, height: H, overflow: "hidden", opacity: edge }}>
      <Animated.View
        style={[{ height: H, justifyContent: "flex-end", alignItems: "center" }, style]}
      >
        {Array.from({ length: ROWS }, (_, row) => (
          <View
            key={row}
            style={{
              width: 1.9,
              height: 1.9,
              borderRadius: 0.95,
              marginTop: PITCH - 1.9,
              backgroundColor: props.colour,
              opacity: 0.35 + 0.65 * (1 - row / ROWS),
            }}
          />
        ))}
      </Animated.View>
    </View>
  );
});

export const PillWaveform = memo(function PillWaveform(props: {
  readonly wave: WaveName;
  readonly levels: SharedValue<ReadonlyArray<number>>;
  readonly colour: string;
  readonly colour2: string;
}) {
  const { wave, levels } = props;
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{
        width: W,
        height: H,
        flexDirection: "row",
        alignItems: wave === "mound" ? "flex-end" : "center",
        justifyContent: wave === "bars" ? "space-between" : "space-around",
      }}
    >
      {wave === "bars"
        ? Array.from({ length: BARS }, (_, i) => (
            <Bar key={i} levels={levels} index={i} colour={props.colour} />
          ))
        : wave === "beads"
          ? Array.from({ length: BEADS }, (_, i) => (
              <Bead
                key={i}
                levels={levels}
                index={i}
                colour={i % 2 ? props.colour2 : props.colour}
              />
            ))
          : Array.from({ length: COLS }, (_, i) => (
              <MoundColumn key={i} levels={levels} index={i} colour={props.colour} />
            ))}
    </View>
  );
});

function PillButton(props: {
  readonly design: PillDesign;
  readonly tokens: PillTokens;
  readonly primary: boolean;
  readonly label: string;
  readonly icon: "xmark" | "checkmark";
  readonly busy?: boolean;
  readonly disabled?: boolean;
  readonly onPress: () => void;
}) {
  const { tokens, design } = props;
  const size = design === "lively" ? 26 : 22;
  return (
    <Pressable
      accessibilityLabel={props.label}
      accessibilityRole="button"
      accessibilityState={{ busy: props.busy, disabled: props.disabled }}
      disabled={props.disabled}
      // 44 pt to touch; the drawn part stays the draft's size.
      hitSlop={(44 - size) / 2}
      onPress={props.onPress}
      style={({ pressed }) => ({
        width: size,
        height: size,
        alignItems: "center",
        justifyContent: "center",
        borderRadius: props.primary
          ? design === "tessaya"
            ? 7
            : design === "lively"
              ? 8
              : 11
          : 11,
        backgroundColor: props.primary
          ? tokens.ok
          : design === "lively"
            ? tokens.surface
            : "transparent",
        opacity: pressed ? 0.7 : props.disabled && !props.busy ? 0.45 : 1,
      })}
    >
      {props.busy ? (
        <AppActivityIndicator
          size="small"
          color={tokens.onOk}
          style={{ transform: [{ scale: 0.6 }] }}
        />
      ) : (
        <SymbolView
          name={props.icon}
          size={12}
          weight="semibold"
          tintColor={props.primary ? tokens.onOk : tokens.fg2}
          type="monochrome"
        />
      )}
    </Pressable>
  );
}

/** Real blur only on iOS, where it is cheap; Quiet gets its tint everywhere else. */
const QUIET_BLUR = Platform.OS === "ios";

export function TessayaDictationPill(props: {
  readonly design: PillDesign;
  readonly wave: WaveName;
  readonly tokens: PillTokens;
  readonly dark: boolean;
  readonly levels: SharedValue<ReadonlyArray<number>>;
  readonly label: string;
  /** False while preparing or writing it out: ✓ waits, ✕ still throws it away. */
  readonly confirmable: boolean;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}) {
  const { tokens, design } = props;
  const lively = design === "lively";
  return (
    <View className="min-w-0 flex-1 items-center justify-center" style={{ height: 44 }}>
      <Animated.View
        accessible={false}
        accessibilityLabel={props.label}
        entering={FadeIn.duration(160).reduceMotion(ReduceMotion.System)}
        exiting={FadeOut.duration(160).reduceMotion(ReduceMotion.System)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: lively ? 4 : 6,
          height: 28,
          paddingHorizontal: lively ? 0 : 3,
          borderRadius: 14,
          overflow: "hidden",
          backgroundColor:
            lively || (design === "quiet" && QUIET_BLUR) ? "transparent" : tokens.surface,
          borderWidth: tokens.hairline === null ? 0 : StyleSheet.hairlineWidth,
          borderColor: tokens.hairline ?? "transparent",
        }}
      >
        {design === "quiet" && QUIET_BLUR ? (
          <BlurView
            intensity={30}
            tint={props.dark ? "dark" : "light"}
            style={[StyleSheet.absoluteFill, { backgroundColor: tokens.surface }]}
          />
        ) : null}
        <PillButton
          design={design}
          tokens={tokens}
          primary={false}
          label="Cancel dictation"
          icon="xmark"
          onPress={props.onCancel}
        />
        <View
          style={
            lively
              ? {
                  backgroundColor: tokens.surface,
                  borderRadius: 8,
                  paddingHorizontal: 6,
                  paddingVertical: 4,
                }
              : undefined
          }
        >
          <PillWaveform
            wave={props.wave}
            levels={props.levels}
            colour={tokens.wave}
            colour2={tokens.wave2}
          />
        </View>
        <PillButton
          design={design}
          tokens={tokens}
          primary
          label={props.confirmable ? "Finish dictation" : props.label}
          icon="checkmark"
          busy={!props.confirmable}
          disabled={!props.confirmable}
          onPress={props.onConfirm}
        />
      </Animated.View>
    </View>
  );
}

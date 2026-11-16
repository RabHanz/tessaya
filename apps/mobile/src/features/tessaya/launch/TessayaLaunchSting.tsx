import * as SplashScreen from "expo-splash-screen";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Platform, StyleSheet } from "react-native";
import Animated, {
  Easing,
  interpolateColor,
  useAnimatedProps,
  useAnimatedStyle,
  useDerivedValue,
  useReducedMotion,
  useSharedValue,
  withSequence,
  withTiming,
} from "react-native-reanimated";
import Svg, { Path } from "react-native-svg";
import { scheduleOnRN } from "react-native-worklets";

import { IS_TESSAYA_APP } from "../../../lib/tessayaBrand";
import { MARK_SPAN, STING_END_S, STING_REST_S, STING_VIEWBOX, stingFrame } from "./tessayaSting";

// The native splash (tessaya.config.ts): the woad tile with the paper mark; the T takes woad's light dye (logo kit).
const TILE = "#14505A";
const PAPER = "#EEEDE4";
const DYE = "#5FB3B3";
// The mark's width on the native splash: iOS draws the 1024 icon at 220 pt (mark 77% of it), Android 12+ the
// 1152 px splash icon at 288 dp (mark 49% of it). The same size here is what makes the hand-off seamless.
const MARK_WIDTH = Platform.OS === "android" ? 288 * 0.486 : 220 * 0.7715;
const STAGE = (MARK_WIDTH * STING_VIEWBOX[2]) / MARK_SPAN;
const FADE_MS = 250;

let appReady = false;
const readyListeners = new Set<() => void>();
const subscribeReady = (listener: () => void) => {
  readyListeners.add(listener);
  return () => readyListeners.delete(listener);
};
/** The app is laid out (App.tsx's splash rules): the sting hands over now. */
export function markTessayaLaunchReady() {
  appReady = true;
  for (const listener of readyListeners) listener();
}

const AnimatedPath = Animated.createAnimatedComponent(Path);

/**
 * The Tessaya build's launch: from the native splash's frame, the logo kit's sting plays in full on every cold start
 * (Director, 16 Nov: launch should be a designed moment), and hands over once the strips are home and the app is ready.
 * A resume never remounts it.
 */
export function TessayaLaunchSting() {
  return IS_TESSAYA_APP ? <Sting /> : null;
}

function Sting() {
  const reducedMotion = useReducedMotion();
  const ready = useSyncExternalStore(subscribeReady, () => appReady);
  const [played, setPlayed] = useState(false);
  const [gone, setGone] = useState(false);
  const started = useRef(false);
  const t = useSharedValue(0);
  const opacity = useSharedValue(1);
  const frame = useDerivedValue(() => stingFrame(t.value));
  const paperProps = useAnimatedProps(() => ({ d: frame.value.paper }));
  const dyeProps = useAnimatedProps(() => ({
    d: frame.value.dye,
    fill: interpolateColor(frame.value.tee, [0, 1], [PAPER, DYE]),
  }));
  const fade = useAnimatedStyle(() => ({ opacity: opacity.value }));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fades the sting out (a Reanimated value) once the film and the app are both done
  useEffect(() => {
    if (!ready || !played) return;
    opacity.set(
      withTiming(0, { duration: FADE_MS }, (finished) => {
        if (finished) scheduleOnRN(setGone, true);
      }),
    );
  }, [ready, played, opacity]);

  // Reduced motion keeps T3's plain splash, which App.tsx hides once the app is ready.
  if (reducedMotion || gone) return null;

  const start = () => {
    if (started.current) return;
    started.current = true;
    // This frame is the native splash's, so swapping them shows nothing; the app loads beneath while the film plays.
    void SplashScreen.hide();
    // The hand-off starts when the strips are home (1.5 s); the listening beat plays out under the fade.
    t.set(
      withSequence(
        withTiming(
          STING_REST_S,
          { duration: STING_REST_S * 1000, easing: Easing.linear },
          (done) => {
            if (done) scheduleOnRN(setPlayed, true);
          },
        ),
        withTiming(STING_END_S, {
          duration: (STING_END_S - STING_REST_S) * 1000,
          easing: Easing.linear,
        }),
      ),
    );
  };

  return (
    <Animated.View
      style={[StyleSheet.absoluteFill, styles.tile, fade]}
      onLayout={start}
      accessible
      accessibilityLabel="Tessaya"
      pointerEvents={ready ? "none" : "auto"}
    >
      <Svg width={STAGE} height={STAGE} viewBox={STING_VIEWBOX.join(" ")}>
        <AnimatedPath animatedProps={paperProps} fill={PAPER} />
        <AnimatedPath animatedProps={dyeProps} />
      </Svg>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  tile: {
    backgroundColor: TILE,
    zIndex: 1000,
    elevation: 1000,
    alignItems: "center",
    justifyContent: "center",
  },
});

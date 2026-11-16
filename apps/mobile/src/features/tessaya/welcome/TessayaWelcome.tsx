import { useCameraPermissions } from "expo-camera";
import { useFonts } from "expo-font";
import { Image } from "expo-image";
import * as SecureStore from "expo-secure-store";
import { useEffect, useSyncExternalStore } from "react";
import { BackHandler, Pressable, StyleSheet, View } from "react-native";
import Animated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  Keyframe,
  useReducedMotion,
  ZoomIn,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import Svg, { Defs, RadialGradient, Rect, Stop } from "react-native-svg";

import { AppText as Text } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { whenProtectedDataAvailable } from "../../../lib/protectedData";
import { rootNavigationRef, whenRootNavigationReady } from "../../../lib/rootNavigation";
import { IS_TESSAYA_APP } from "../../../lib/tessayaBrand";
import { SettingsRow } from "../../settings/components/SettingsRow";
import { SettingsSection } from "../../settings/components/SettingsSection";
import { openSettings } from "../../settings/settings-navigation";
import { useTessayaStingHandedOff } from "../launch/TessayaLaunchSting";

// The sting's tile, so its fade reveals the same woad; paper and woad's light dye from the logo kit.
const WOAD = "#14505A";
const WOAD_LIGHT = "#1F6C77";
const WOAD_DEEP = "#0A2F36";
const PAPER = "#EEEDE4";
const DYE = "#5FB3B3";
const SERIF = "Newsreader";
// Stills of the production rig (apps/web/public/companion), 3x: her resting face, then the smile she meets you with.
const FACE = { width: 195, height: 158 };
const SEEN_KEY = "tessaya.welcome.v1";

let visible: boolean | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
function setVisible(next: boolean) {
  visible = next;
  for (const listener of listeners) listener();
}

if (IS_TESSAYA_APP) {
  void whenProtectedDataAvailable()
    .then(() => SecureStore.getItemAsync(SEEN_KEY))
    .then((seen) => {
      if (visible === null) setVisible(seen === null);
    })
    .catch(() => {
      if (visible === null) setVisible(false);
    });
}

/** Settings › About: the way back to the welcome once it has been closed. */
export function MeetTessayaSection() {
  if (!IS_TESSAYA_APP) return null;
  return (
    <SettingsSection title="Tessaya">
      <SettingsRow icon="face.smiling" label="Meet Tessaya" onPress={() => setVisible(true)} />
    </SettingsSection>
  );
}

function closeWelcome() {
  setVisible(false);
  void SecureStore.setItemAsync(SEEN_KEY, "1").catch(() => {});
}

/**
 * The Tessaya build's first run: after the sting, she introduces herself and goes straight to the one QR code
 * that pairs every linked machine (Director, 16 Nov: the start felt too boring). Shown once; About plays it again.
 */
export function TessayaWelcome() {
  const shown = useSyncExternalStore(subscribe, () => visible === true);
  return IS_TESSAYA_APP && shown ? <Welcome /> : null;
}

function Welcome() {
  const insets = useSafeAreaInsets();
  const handedOff = useTessayaStingHandedOff();
  const reducedMotion = useReducedMotion();
  const [fontsLoaded, fontError] = useFonts({ [SERIF]: require("./Newsreader-Regular.ttf") });
  const [, requestCameraPermission] = useCameraPermissions();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Android's back button sits outside React: it closes the welcome rather than the app
  useEffect(() => {
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      closeWelcome();
      return true;
    });
    return () => subscription.remove();
  }, []);

  const scan = async () => {
    // Asked here, the camera is already live when the pairing page opens.
    await requestCameraPermission().catch(() => null);
    closeWelcome();
    whenRootNavigationReady(() => openSettings(rootNavigationRef, "SettingsEnvironmentNew"));
  };

  // Under the sting the content waits, so its entrance plays once the sting fades. Reduce Motion has no sting, and
  // Reanimated skips each entrance for it (ReduceMotion.System).
  const enter = (handedOff || reducedMotion) && (fontsLoaded || fontError !== null);

  return (
    <Animated.View
      exiting={FadeOut.duration(220)}
      style={[StyleSheet.absoluteFill, styles.root]}
      accessibilityViewIsModal
    >
      <Svg
        style={StyleSheet.absoluteFill}
        accessibilityElementsHidden
        importantForAccessibility="no"
      >
        <Defs>
          <RadialGradient id="tessaya-welcome-glow" cx="50%" cy="34%" rx="75%" ry="55%">
            <Stop offset="0%" stopColor={WOAD_LIGHT} />
            <Stop offset="55%" stopColor={WOAD} />
            <Stop offset="100%" stopColor={WOAD_DEEP} />
          </RadialGradient>
        </Defs>
        <Rect width="100%" height="100%" fill="url(#tessaya-welcome-glow)" />
      </Svg>
      {enter ? (
        <View
          style={[
            styles.content,
            { paddingTop: insets.top + 24, paddingBottom: Math.max(insets.bottom, 16) + 16 },
          ]}
        >
          <View style={styles.hero}>
            <Animated.View entering={ZoomIn.springify().damping(11).mass(0.8).delay(80)}>
              <Animated.View entering={HOP} style={FACE}>
                <Image
                  source={require("./face-neutral.webp")}
                  style={StyleSheet.absoluteFill}
                  accessibilityIgnoresInvertColors
                />
                <Animated.View entering={SMILE} style={StyleSheet.absoluteFill}>
                  <Image
                    source={require("./face-happy.webp")}
                    style={StyleSheet.absoluteFill}
                    accessibilityLabel="Tessaya, smiling"
                    accessibilityIgnoresInvertColors
                  />
                </Animated.View>
              </Animated.View>
            </Animated.View>
            <Animated.View entering={rise(420)} style={styles.nameBlock}>
              <Text accessibilityRole="header" style={styles.name}>
                Tessaya
              </Text>
              <View style={styles.status}>
                <View style={styles.dot} />
                <Text style={styles.statusText}>awake</Text>
              </View>
            </Animated.View>
          </View>

          <View style={styles.footer}>
            <Animated.View entering={rise(900)}>
              <Text style={styles.intro}>
                I look after your machines and the agents working on them. Show me the code on your
                computer and I'll bring every one of them here.
              </Text>
            </Animated.View>
            <Animated.View entering={rise(1100)} style={styles.actions}>
              <Pressable
                accessibilityRole="button"
                accessibilityHint="Opens the camera to pair this phone with your machines"
                onPress={() => void scan()}
                style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
              >
                <SymbolView name="qrcode.viewfinder" size={20} tintColor={WOAD} type="monochrome" />
                <Text className="font-t3-medium" style={styles.primaryText}>
                  Scan the code
                </Text>
              </Pressable>
              <Text style={styles.hint}>On your computer: Tessaya › Phone › Add a phone</Text>
              <Pressable
                accessibilityRole="button"
                hitSlop={12}
                onPress={closeWelcome}
                style={({ pressed }) => pressed && styles.pressed}
              >
                <Text style={styles.later}>Not now</Text>
              </Pressable>
            </Animated.View>
          </View>
        </View>
      ) : null}
    </Animated.View>
  );
}

const rise = (delay: number) => FadeInDown.duration(520).delay(delay);
// One hop as she notices you, then still: nothing repaints after the entrance.
const HOP = new Keyframe({
  0: { transform: [{ translateY: 0 }, { scaleX: 1 }, { scaleY: 1 }] },
  30: { transform: [{ translateY: 3 }, { scaleX: 1.05 }, { scaleY: 0.94 }] },
  65: { transform: [{ translateY: -10 }, { scaleX: 0.97 }, { scaleY: 1.04 }] },
  100: { transform: [{ translateY: 0 }, { scaleX: 1 }, { scaleY: 1 }] },
})
  .duration(620)
  .delay(1250);
// The smile swaps in at the bottom of the hop's squash, where the change of face reads as part of the bounce.
const SMILE = FadeIn.duration(120).delay(1430);

const styles = StyleSheet.create({
  root: { backgroundColor: WOAD, zIndex: 999, elevation: 999 },
  content: { flex: 1, paddingHorizontal: 28, justifyContent: "space-between" },
  hero: { flex: 1, alignItems: "center", justifyContent: "center", gap: 18 },
  nameBlock: { alignItems: "center", gap: 6 },
  name: { fontFamily: SERIF, fontSize: 46, lineHeight: 54, color: PAPER, letterSpacing: -0.5 },
  status: { flexDirection: "row", alignItems: "center", gap: 8 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: DYE },
  statusText: { fontSize: 15, color: PAPER, opacity: 0.72 },
  footer: { alignItems: "center", gap: 26 },
  intro: {
    fontFamily: SERIF,
    fontSize: 20,
    lineHeight: 28,
    color: PAPER,
    textAlign: "center",
    maxWidth: 330,
  },
  actions: { alignSelf: "stretch", alignItems: "center", gap: 14 },
  primary: {
    alignSelf: "stretch",
    maxWidth: 360,
    height: 56,
    borderRadius: 28,
    backgroundColor: PAPER,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 10,
  },
  primaryText: { fontSize: 17, color: WOAD },
  pressed: { opacity: 0.8 },
  hint: { fontSize: 13, color: PAPER, opacity: 0.6, textAlign: "center" },
  later: { fontSize: 15, color: PAPER, opacity: 0.85, paddingVertical: 6 },
});

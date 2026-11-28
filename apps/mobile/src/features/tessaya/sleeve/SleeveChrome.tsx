/** The Sleeve's words around her, as in the approved companion mock: time and battery on top, her name, mood and line. */
import { useGT } from "gt-react-native";
import { useBatteryLevel, useBatteryState, BatteryState } from "expo-battery";
import { useEffect, useState } from "react";
import { Pressable, StyleSheet, View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";
import { DYE, PAPER, SERIF, useSerif } from "../layout/woad";

const clock = () =>
  new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

/** Her mood as the mock words it: the brain's neutral reads "steady". */
export const moodWord = (label: string, steady: string) => (label === "neutral" ? steady : label);

export function SleeveTopRow(props: {
  readonly top: number;
  readonly left: number;
  readonly right: number;
  readonly onExit: () => void;
}) {
  const gt = useGT();
  const [now, setNow] = useState(clock);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the wall clock is outside React: one redraw a minute
  useEffect(() => {
    const t = setInterval(() => setNow(clock()), 15_000);
    return () => clearInterval(t);
  }, []);
  const level = useBatteryLevel();
  const state = useBatteryState();
  const charging = state === BatteryState.CHARGING || state === BatteryState.FULL;
  const pct = level < 0 ? null : `${Math.round(level * 100)}%`;
  return (
    <View
      style={[styles.top, { top: props.top + 8, left: props.left + 20, right: props.right + 16 }]}
    >
      <Text style={styles.small}>{now}</Text>
      <View style={styles.topRight}>
        {pct === null ? null : (
          <Text style={styles.small}>{charging ? gt("Charging {pct}", { pct }) : pct}</Text>
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={gt("Back to your phone")}
          accessibilityHint={gt("Asks for Face ID or your PIN")}
          hitSlop={12}
          onPress={props.onExit}
          style={({ pressed }) => [styles.exit, pressed && { opacity: 0.6 }]}
        >
          <Text style={styles.exitText}>{gt("Your phone")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

/** Her name, her mood, and the one line that matters now (what she heard, that she is thinking, or her reply). */
export function SleeveName(props: {
  readonly name: string;
  readonly mood: string;
  readonly line: string | null;
}) {
  const gt = useGT();
  const [fonts, fontError] = useSerif();
  const serif = fonts || fontError !== null ? { fontFamily: SERIF } : null;
  return (
    <View style={styles.nameBlock} pointerEvents="none">
      <Text accessibilityRole="header" style={[styles.name, serif]}>
        {props.name}
      </Text>
      <View style={styles.status}>
        <View style={styles.dot} />
        <Text style={styles.statusText}>{moodWord(props.mood, gt("steady"))}</Text>
      </View>
      {props.line === null ? null : (
        <Text style={styles.line} numberOfLines={4}>
          {props.line}
        </Text>
      )}
    </View>
  );
}

export function SleeveExitSheet(props: {
  readonly bottom: number;
  readonly onBack: () => void;
  readonly onSettings: () => void;
  readonly onCancel: () => void;
}) {
  const gt = useGT();
  return (
    <View style={StyleSheet.absoluteFill}>
      <Pressable
        accessibilityLabel={gt("Stay with her")}
        style={styles.scrim}
        onPress={props.onCancel}
      />
      <View style={[styles.sheet, { paddingBottom: props.bottom + 20 }]}>
        <Text style={styles.sheetTitle}>{gt("This phone is her Sleeve")}</Text>
        <Text style={styles.sheetDetail}>
          {gt(
            "Take it back, or open settings for five minutes. Face ID or your PIN first. You can also say “give me my phone back” on any of your devices.",
          )}
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={props.onBack}
          style={({ pressed }) => [styles.primary, pressed && { opacity: 0.8 }]}
        >
          <Text style={styles.primaryText}>{gt("Give me my phone back")}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={props.onSettings} hitSlop={8}>
          <Text style={styles.secondary}>{gt("Just settings, for five minutes")}</Text>
        </Pressable>
        <Pressable accessibilityRole="button" onPress={props.onCancel} hitSlop={8}>
          <Text style={styles.secondary}>{gt("Stay with her")}</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  top: {
    position: "absolute",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  topRight: { flexDirection: "row", alignItems: "center", gap: 12 },
  small: { fontSize: 13, color: PAPER, opacity: 0.72 },
  exit: {
    borderRadius: 14,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: "rgba(238,237,228,0.14)",
  },
  exitText: { fontSize: 13, color: PAPER },
  nameBlock: { alignItems: "center", gap: 6, paddingHorizontal: 8 },
  name: { fontSize: 34, lineHeight: 42, color: PAPER, letterSpacing: -0.3 },
  status: { flexDirection: "row", alignItems: "center", gap: 7 },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: DYE },
  statusText: { fontSize: 15, color: PAPER, opacity: 0.72 },
  line: { marginTop: 10, fontSize: 16, lineHeight: 22, color: PAPER, textAlign: "center" },
  scrim: { flex: 1, backgroundColor: "rgba(0,0,0,0.4)" },
  sheet: {
    gap: 14,
    paddingHorizontal: 24,
    paddingTop: 24,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    backgroundColor: "#0F1B1E",
  },
  sheetTitle: { fontSize: 18, color: PAPER },
  sheetDetail: { fontSize: 14, lineHeight: 20, color: PAPER, opacity: 0.72 },
  primary: {
    height: 52,
    borderRadius: 26,
    backgroundColor: PAPER,
    alignItems: "center",
    justifyContent: "center",
  },
  primaryText: { fontSize: 17, color: "#14505A" },
  secondary: { fontSize: 15, color: PAPER, opacity: 0.85, textAlign: "center", paddingVertical: 4 },
});

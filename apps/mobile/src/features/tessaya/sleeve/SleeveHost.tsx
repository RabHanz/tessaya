/**
 * Sleeve (M-120): a phone that is only her, full screen and edge to edge. His settings sit behind a dot below the
 * status row: hold it, then Face ID or his PIN. They lock again when the app leaves the front or five minutes on.
 */
import { useEffect, useState } from "react";
import { AppState, Pressable, StatusBar, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { UnlockSheet } from "../lock/UnlockSheet";
import { TalkView } from "../talk/TalkRouteScreen";
import { setSleeveUnlocked, useSleeve, useSleeveCovering } from "./useSleeve";

export function SleeveHost() {
  useSleeve();
  const covering = useSleeveCovering();
  const insets = useSafeAreaInsets();
  const [asking, setAsking] = useState(false);
  const [active, setActive] = useState(AppState.currentState === "active");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the app leaving the front locks his settings again
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      setActive(s === "active");
      if (s !== "active") setSleeveUnlocked(false);
    });
    return () => sub.remove();
  }, []);
  if (!covering) return null;
  return (
    <View className="absolute inset-0 bg-background">
      <StatusBar hidden />
      <TalkView focused={active} sleeve />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Settings. Hold, then confirm it's you"
        delayLongPress={600}
        onLongPress={() => setAsking(true)}
        hitSlop={16}
        style={{
          position: "absolute",
          top: insets.top + 12,
          right: insets.right + 20,
          width: 12,
          height: 12,
          borderRadius: 6,
          backgroundColor: "rgba(127,127,127,0.45)",
        }}
      />
      {asking ? (
        <UnlockSheet
          title="Settings are locked"
          detail="Use Face ID or your PIN to change this Sleeve."
          onUnlocked={() => {
            setAsking(false);
            setSleeveUnlocked(true);
          }}
          onCancel={() => setAsking(false)}
        />
      ) : null}
    </View>
  );
}

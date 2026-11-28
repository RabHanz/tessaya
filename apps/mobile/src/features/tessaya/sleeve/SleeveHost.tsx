/**
 * Sleeve (M-120, M-158): a phone that is only her, full screen and edge to edge, in her woad. "Your phone" at the top
 * offers the way back or five minutes of settings, each after Face ID or his PIN; settings lock again when the app
 * leaves the front or five minutes on.
 */
import { useEffect, useState } from "react";
import { AppState, StatusBar, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { WOAD, WoadGlow } from "../layout/woad";
import { UnlockSheet } from "../lock/UnlockSheet";
import { TalkView } from "../talk/TalkRouteScreen";
import { SleeveExitSheet, SleeveTopRow } from "./SleeveChrome";
import { setSleeveUnlocked, useSleeve, useSleeveCovering } from "./useSleeve";

export function SleeveHost() {
  const sleeve = useSleeve();
  const covering = useSleeveCovering();
  const insets = useSafeAreaInsets();
  const [asking, setAsking] = useState<"choose" | "back" | "settings" | null>(null);
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
    <View className="absolute inset-0" style={{ backgroundColor: WOAD }}>
      <StatusBar hidden />
      <WoadGlow id="tessaya-sleeve-glow" />
      <TalkView focused={active} sleeve />
      <SleeveTopRow
        top={insets.top}
        left={insets.left}
        right={insets.right}
        onExit={() => setAsking("choose")}
      />
      {asking === "choose" ? (
        <SleeveExitSheet
          bottom={insets.bottom}
          onBack={() => setAsking("back")}
          onSettings={() => setAsking("settings")}
          onCancel={() => setAsking(null)}
        />
      ) : null}
      {asking === "back" || asking === "settings" ? (
        <UnlockSheet
          title={asking === "back" ? "Give your phone back to you?" : "Settings are locked"}
          detail={
            asking === "back"
              ? "Use Face ID or your PIN. She stays on your other devices."
              : "Use Face ID or your PIN to change this Sleeve."
          }
          onUnlocked={() => {
            const back = asking === "back";
            setAsking(null);
            setSleeveUnlocked(true);
            if (back) void sleeve.set(false);
          }}
          onCancel={() => setAsking(null)}
        />
      ) : null}
    </View>
  );
}

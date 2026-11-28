/**
 * Sleeve (M-120, M-158): a phone that is only her, full screen and edge to edge, in her woad. "Your phone" at the top
 * offers the way back or five minutes of settings, each after Face ID or his PIN; settings lock again when the app
 * leaves the front or five minutes on.
 */
import { DEFAULT_POLICY } from "@t3tools/tessaya-shared/initiative";
import { makeMotionReader } from "@t3tools/tessaya-shared/sleeveMotion";
import * as Battery from "expo-battery";
import * as Device from "expo-device";
import { activateKeepAwakeAsync, deactivateKeepAwake } from "expo-keep-awake";
import * as ScreenOrientation from "expo-screen-orientation";
import { Accelerometer } from "expo-sensors";
import { useEffect, useRef, useState } from "react";
import { AppState, StatusBar, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { WOAD, WoadGlow } from "../layout/woad";
import { UnlockSheet } from "../lock/UnlockSheet";
import { phoneSend, phoneTalk } from "../../tessel/phoneRoute";
import { AppText as Text } from "../../../components/ui/AppText";
import { onHerPhase } from "../island/herPhase";
import { TalkView } from "../talk/TalkRouteScreen";
import { sleeveListen } from "./sleeveListen";
import { useSleeveActs } from "./useSleeveActs";
import { SleeveExitSheet, SleeveTopRow } from "./SleeveChrome";
import { ALONE_MS, restOf } from "./sleeveMode.logic";
import { setSleeveUnlocked, useSleeve, useSleeveCovering } from "./useSleeve";

const AWAKE_TAG = "tessaya-sleeve";
const charged = (s: Battery.BatteryState) =>
  s === Battery.BatteryState.CHARGING || s === Battery.BatteryState.FULL;

export function SleeveHost() {
  const sleeve = useSleeve();
  const covering = useSleeveCovering();
  const insets = useSafeAreaInsets();
  const [asking, setAsking] = useState<"choose" | "back" | "settings" | null>(null);
  const [active, setActive] = useState(AppState.currentState === "active");
  // turned face down she leaves this body for her others; turned back or picked up, she comes back
  const [away, setAway] = useState(false);
  // her brain's asks of this body (open a call or a text, share, a note), and who the Cast has here: called to this
  // phone from any of her bodies, she comes back in front of him, as that persona
  const [wearing, setWearing] = useState<string | null>(null);
  useSleeveActs(covering && active, (persona) => {
    setWearing(persona);
    setAway(false);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the app leaving the front locks his settings again
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => {
      setActive(s === "active");
      if (s !== "active") setSleeveUnlocked(false);
    });
    return () => sub.remove();
  }, []);
  // a phone stays portrait, and her Sleeve turns with it (on its side it is her dock); a tablet keeps its own rotation
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the screen's orientation lock is the system's, outside React
  useEffect(() => {
    if (Device.deviceType !== Device.DeviceType.PHONE) return;
    void (
      covering
        ? ScreenOrientation.unlockAsync()
        : ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP)
    ).catch(() => undefined);
  }, [covering]);
  // her power (REQ-25-157/158): on its charger the screen stays on; alone two minutes it dims to her dock, and in his
  // quiet hours goes dark and is let sleep. A touch, a raise or a turn with her brings her back at once.
  const [charging, setCharging] = useState(false);
  const [rest, setRest] = useState<"active" | "dock" | "night">("active");
  const restTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const see = () => {
    if (restTimer.current !== null) clearTimeout(restTimer.current);
    setRest("active");
    // shortcut: the household's default quiet hours (22-8); his own once the phone reads his comms settings
    restTimer.current = setTimeout(
      () => setRest(restOf(DEFAULT_POLICY.quietHours, new Date().getHours())),
      ALONE_MS,
    );
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the charger and her phase are outside React; a turn with her is someone there
  useEffect(() => {
    if (!covering) return;
    void Battery.getBatteryStateAsync().then(
      (s) => setCharging(charged(s)),
      () => undefined,
    );
    // put on or taken off its charger: someone is there
    const sub = Battery.addBatteryStateListener((e) => {
      setCharging(charged(e.batteryState));
      see();
    });
    const off = onHerPhase(see);
    restTimer.current = setTimeout(
      () => setRest(restOf(DEFAULT_POLICY.quietHours, new Date().getHours())),
      ALONE_MS,
    );
    return () => {
      sub.remove();
      off();
      if (restTimer.current !== null) clearTimeout(restTimer.current);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- see only touches the timer and state
  }, [covering]);
  const power = charging && active ? rest : "active";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the screen's keep-awake is the system's, outside React
  useEffect(() => {
    if (!covering || !active || !charging || power === "night") return;
    void activateKeepAwakeAsync(AWAKE_TAG).catch(() => undefined);
    return () => void deactivateKeepAwake(AWAKE_TAG).catch(() => undefined);
  }, [covering, active, charging, power]);
  // her body's motion sensor, read on the phone (only moments leave it): raised to him, she listens
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the accelerometer is outside React, held only while she is on screen
  useEffect(() => {
    if (!covering || !active) return;
    const read = makeMotionReader();
    Accelerometer.setUpdateInterval(100);
    const sub = Accelerometer.addListener((a) => {
      const moment = read(a, Date.now());
      if (moment === null) return;
      // her nervous system feels it as any body's handling (PhoneLink, once her route is linked)
      if (moment === "lifted") phoneSend({ t: "motion", kind: "lift" });
      else if (moment === "shaken") phoneSend({ t: "motion", kind: "shake" });
      else
        phoneSend({
          t: "placement",
          placement:
            moment === "raised" ? "handheld" : moment === "facedown" ? "face_down" : "desk",
        });
      if (moment !== "facedown") see();
      if (moment === "facedown") setAway(true);
      else if (moment === "faceup" || moment === "lifted" || moment === "raised") setAway(false);
      if (moment === "raised" && !phoneTalk()) sleeveListen();
    });
    return () => sub.remove();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- see only touches the rest timer and state
  }, [covering, active]);
  if (!covering) return null;
  return (
    <View className="absolute inset-0" style={{ backgroundColor: WOAD }} onTouchStart={see}>
      <StatusBar hidden />
      <WoadGlow id="tessaya-sleeve-glow" />
      <TalkView focused={active} sleeve away={away} wearing={wearing} />
      {away ? (
        <View
          className="absolute inset-0 items-center justify-end"
          style={{ backgroundColor: "rgba(0,0,0,0.88)", paddingBottom: insets.bottom + 48 }}
        >
          <Text style={{ color: "rgba(238,237,228,0.55)", fontSize: 14, textAlign: "center" }}>
            She is with you on your other devices. Turn me over or pick me up to bring her back.
          </Text>
        </View>
      ) : null}
      <SleeveTopRow
        top={insets.top}
        left={insets.left}
        right={insets.right}
        onExit={() => setAsking("choose")}
      />
      {power === "active" ? null : (
        // her dock dims the screen (no brightness control without a native module); night is all but black
        <View
          pointerEvents="none"
          className="absolute inset-0"
          style={{ backgroundColor: power === "dock" ? "rgba(0,0,0,0.62)" : "rgba(0,0,0,0.97)" }}
        />
      )}
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
          owner
          title={asking === "back" ? "Give your phone back to you?" : "Settings are locked"}
          detail={
            asking === "back"
              ? "Face ID, or your PIN. She stays on your other devices."
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

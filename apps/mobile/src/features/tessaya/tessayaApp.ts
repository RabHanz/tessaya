import Constants from "expo-constants";
import { Platform } from "react-native";

import { setTessayaApp } from "./tessayaTabs";

/**
 * Imported first by index.ts: whether this is Tessaya's own build of the phone app (APP_VARIANT=tessaya). A dev client can try it with
 * EXPO_PUBLIC_TESSAYA_APP=1 in Metro's environment; release builds ignore that.
 */
// shortcut: iOS only; Android's tab bar is native (T3WorkspaceNavigationModule.kt) and needs Today and Devices' labels and icons first.
setTessayaApp(
  Platform.OS === "ios" &&
    (Constants.expoConfig?.extra?.appVariant === "tessaya" ||
      (__DEV__ && process.env.EXPO_PUBLIC_TESSAYA_APP === "1")),
);

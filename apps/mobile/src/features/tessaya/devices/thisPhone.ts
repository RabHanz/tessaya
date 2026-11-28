/**
 * This phone as one vessel, said the same by every screen that publishes it: a manifest that differs between callers
 * would flip her items in the registry on each publish.
 */
import { phoneManifest, type PhoneFacts } from "@t3tools/tessaya-shared/phoneDevice";
import * as Application from "expo-application";
import * as Device from "expo-device";
import * as Updates from "expo-updates";

import { sleeveSettings } from "../sleeve/sleeveSettings";

// whether this phone is her Sleeve now, kept by useSleeve as her brain answers
let sleeve = false;
export const setThisPhoneSleeve = (on: boolean) => {
  sleeve = on;
};
// whether his private layer answers on this server (privateLayer's report)
let layer = false;
export const setThisPhonePrivate = (on: boolean) => {
  layer = on;
};

export const thisPhoneFacts = (): PhoneFacts => ({
  installId: `${Device.modelName ?? ""}${Device.deviceName ?? ""}`,
  model: Device.modelName ?? null,
  os: Device.osName === null ? null : `${Device.osName} ${Device.osVersion ?? ""}`.trim(),
  motion: Device.isDevice,
  app: { version: Application.nativeApplicationVersion, update: Updates.updateId },
  sleeve,
  private: layer,
  settings: sleeveSettings(),
});

export const thisPhoneManifest = () => phoneManifest(thisPhoneFacts());
export const thisPhoneId = () => thisPhoneManifest().deviceId;

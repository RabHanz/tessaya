/**
 * The phone telling each of his servers it is in his hand (B-043): the app coming to the front and going away, as a
 * `presence.here` value on this phone's vessel publish. The server notes it for the signed-in member; no location.
 */
import { HERE_ITEM, phoneManifest, phoneValues } from "@t3tools/tessaya-shared/phoneDevice";
import * as Device from "expo-device";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";

import { IS_TESSAYA_APP } from "../lib/tessayaBrand";
import { useEnvironments } from "./environments";
import { tessayaWorkSessions } from "./tessayaWorkSessions";
import { useAtomCommand } from "./use-atom-command";

const QUIET = { reportFailure: false } as const;
/** Still in front: said again this often, so the server's estimate does not fade while he uses it. */
const AGAIN_MS = 5 * 60_000;

export function usePresenceHere() {
  const { environments } = useEnvironments();
  const devicesCall = useAtomCommand(tessayaWorkSessions.devicesCall, QUIET);
  const latest = useRef({ environments, devicesCall });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the app-state listener below reads the newest servers without resubscribing
  useEffect(() => {
    latest.current = { environments, devicesCall };
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to the OS app state, outside React
  useEffect(() => {
    if (!IS_TESSAYA_APP) return;
    const facts = {
      installId: `${Device.modelName ?? ""}${Device.deviceName ?? ""}`,
      model: Device.modelName ?? null,
      os: Device.osName === null ? null : `${Device.osName} ${Device.osVersion ?? ""}`.trim(),
      motion: Device.isDevice,
    };
    const manifest = phoneManifest(facts);
    const say = (value: "foreground" | "background") => {
      for (const env of latest.current.environments)
        void latest.current.devicesCall({
          environmentId: env.environmentId,
          input: {
            kind: "vessel",
            op: "publish",
            args: {
              deviceId: manifest.deviceId,
              manifest,
              values: [...phoneValues(facts), { itemId: HERE_ITEM, value }],
            },
          },
        });
    };
    let timer: ReturnType<typeof setInterval> | null = null;
    const onChange = (state: string | null | undefined) => {
      if (timer !== null) clearInterval(timer);
      timer = null;
      if (state === "active") {
        say("foreground");
        timer = setInterval(() => say("foreground"), AGAIN_MS);
      } else if (state === "background") say("background");
    };
    onChange(AppState.currentState);
    const sub = AppState.addEventListener("change", onChange);
    return () => {
      sub.remove();
      if (timer !== null) clearInterval(timer);
    };
  }, []);
}

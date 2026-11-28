/**
 * What her brain asks her Sleeve to do (device_set on its phone.* items, through the registry's writes), done here and
 * answered, and who the Cast has on this body: called here from any vessel ("come to my phone"), she comes. Held only
 * while she is on screen: a long wait for the next write, then her answer with the next wait.
 */
/* oxlint-disable t3code/no-untranslated-copy -- these answers go to her brain, which words them for him */
import { useAtomValue } from "@effect/atom-react";
import type { DeviceWrite } from "@t3tools/tessaya-contracts";
import * as Notifications from "expo-notifications";
import { useEffect } from "react";
import { Linking, Platform, Share } from "react-native";

import { tessayaEnvironmentIdAtom } from "../../../state/tessayaHousehold";
import { tessayaWorkSessions } from "../../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../../state/use-atom-command";
import { thisPhoneManifest } from "../devices/thisPhone";
import { callUrl, messageUrl } from "./sleeveActs.logic";

type Ack = { readonly id: string; readonly ok: boolean; readonly error?: string };
const WAIT_MS = 15_000;

const open = async (url: string | null, what: string): Promise<Omit<Ack, "id">> => {
  if (url === null) return { ok: false, error: `That is not a ${what} I can open.` };
  return Linking.openURL(url).then(
    () => ({ ok: true }),
    () => ({ ok: false, error: `This phone could not open the ${what}.` }),
  );
};

const run = async (w: DeviceWrite): Promise<Omit<Ack, "id">> => {
  const text = typeof w.value === "string" ? w.value : "";
  switch (w.itemId) {
    case "phone.call":
      return open(callUrl(text), "call");
    case "phone.message":
      return open(messageUrl(text, Platform.OS === "ios"), "text");
    case "phone.share":
      return Share.share({ message: text }).then(
        () => ({ ok: true }),
        () => ({ ok: false, error: "The share sheet did not open." }),
      );
    case "phone.notify": {
      const allowed = await Notifications.getPermissionsAsync().catch(() => null);
      if (allowed?.granted !== true)
        return { ok: false, error: "He has not let the app notify him on this phone." };
      return Notifications.scheduleNotificationAsync({
        content: { title: "Tessaya", body: text },
        trigger: null,
      }).then(
        () => ({ ok: true }),
        () => ({ ok: false, error: "The note could not be shown." }),
      );
    }
    default:
      return { ok: false, error: "This phone does not do that." };
  }
};

/** `come` hears each change of who the Cast has on this phone (a persona called here, or back to its own). */
export function useSleeveActs(on: boolean, come: (wearing: string | null) => void) {
  const environmentId = useAtomValue(tessayaEnvironmentIdAtom);
  const devicesCall = useAtomCommand(tessayaWorkSessions.devicesCall, { reportFailure: false });
  const castCall = useAtomCommand(tessayaWorkSessions.castCall, { reportFailure: false });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a long wait on her brain for writes, held while the Sleeve shows
  useEffect(() => {
    if (!on || environmentId === null) return;
    let stopped = false;
    void (async () => {
      let acks: Array<Ack> = [];
      let worn: string | null | undefined;
      while (!stopped) {
        const cast = await castCall({ environmentId, input: { op: "view" } });
        if (stopped) return;
        if (cast._tag === "Success") {
          const id = thisPhoneManifest().deviceId;
          const now = cast.value.bodies.find((b) => b.id === id)?.wearing ?? null;
          if (now !== worn) {
            worn = now;
            come(now);
          }
        }
        const manifest = thisPhoneManifest();
        const r = await devicesCall({
          environmentId,
          input: {
            kind: "vessel",
            op: "publish",
            args: { deviceId: manifest.deviceId, manifest, acks, waitMs: WAIT_MS },
          },
        });
        acks = [];
        if (stopped) return;
        if (r._tag !== "Success" || !r.value.ok) {
          await new Promise((done) => setTimeout(done, WAIT_MS));
          continue;
        }
        const writes = (r.value.value as { writes?: ReadonlyArray<DeviceWrite> }).writes ?? [];
        for (const w of writes) acks.push({ id: w.id, ...(await run(w)) });
      }
    })();
    return () => {
      stopped = true;
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- one loop per environment while on; come is read fresh
  }, [on, environmentId]);
}

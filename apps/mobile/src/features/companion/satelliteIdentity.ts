import * as Crypto from "expo-crypto";
import * as Device from "expo-device";
import { File, Paths } from "expo-file-system";

const ID = /^phone-[a-z0-9]{6,24}$/;

/** This phone's satellite id, made once and kept (always `phone-…`), and the name it shows in Settings → Hardware. */
export function satelliteIdentity(): { readonly id: string; readonly name: string } {
  const file = new File(Paths.document, "companion-satellite-id");
  let id = "";
  try {
    id = file.exists ? file.textSync().trim() : "";
  } catch {
    id = "";
  }
  if (!ID.test(id)) {
    id = `phone-${Crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
    try {
      file.writeSync(id);
    } catch {
      // A new id next time: the old one only lingers in Hardware as offline.
    }
  }
  return { id, name: Device.modelName?.trim() || "Phone" };
}

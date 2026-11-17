import type { TessayaPersonaChangeResult } from "@t3tools/tessaya-contracts";

import { beginForegroundHandoff } from "../../lib/foreground-handoff";

/** Picks a Character Card file: JSON comes back as text, a PNG as base64, as `import` takes them. Null when cancelled. */
export async function pickCharacterCard(): Promise<string | null> {
  const { getDocumentAsync } = await import("expo-document-picker");
  const endHandoff = beginForegroundHandoff();
  try {
    const picked = await getDocumentAsync({
      type: ["image/png", "application/json"],
      copyToCacheDirectory: true,
    });
    const asset = picked.canceled ? undefined : picked.assets[0];
    if (asset === undefined) return null;
    const { File } = await import("expo-file-system");
    const file = new File(asset.uri);
    const isJson =
      asset.name.toLowerCase().endsWith(".json") || asset.mimeType === "application/json";
    return isJson ? await file.text() : await file.base64();
  } finally {
    endHandoff();
  }
}

/** Writes an exported card to the cache and opens the share sheet with it. */
export async function shareCharacterCard(
  id: string,
  kind: "png" | "json",
  card: NonNullable<TessayaPersonaChangeResult["card"]>,
) {
  const [{ File, Paths }, Sharing] = await Promise.all([
    import("expo-file-system"),
    import("expo-sharing"),
  ]);
  const name = `${id}.card.${kind}`;
  const file = new File(Paths.cache, name);
  file.create({ overwrite: true });
  if (kind === "json") file.write(card.json);
  else file.write(card.png, { encoding: "base64" });
  const endHandoff = beginForegroundHandoff();
  try {
    await Sharing.shareAsync(file.uri, {
      mimeType: kind === "json" ? "application/json" : "image/png",
      dialogTitle: name,
    });
  } finally {
    endHandoff();
  }
}

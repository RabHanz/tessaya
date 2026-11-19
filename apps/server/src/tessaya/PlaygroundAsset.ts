// @effect-diagnostics nodeBuiltinImport:off
/**
 * The playground's licence-clean default body for a public build (CC0, its LICENCE.md beside it on the release): not
 * in the repository, fetched once from the release on first use, checked against its size and hash, kept in userdata.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export const EVERYDAY_BODY = {
  url: "https://github.com/RabHanz/tessaya/releases/download/body-assets-v1/everyday.vrm",
  size: 21_398_752,
  sha256: "ef39bbe9607a6db742cb99897065dc820ada6b90d85a3d5fab31d0ec21218780",
} as const;

let pending: Promise<Uint8Array | null> | null = null;
// the kept file was checked once this process; later reads skip hashing 21 MB
const checked = new Set<string>();

/** The default body's bytes, from userdata or the release; null when it can't be had or doesn't match. */
export const everydayBody = (
  userdata: string,
  asset: { readonly url: string; readonly size: number; readonly sha256: string } = EVERYDAY_BODY,
  get: typeof fetch = fetch,
): Promise<Uint8Array | null> => {
  const file = NodePath.join(userdata, "tessaya", "body", "everyday.vrm");
  const check = (b: Uint8Array) =>
    b.length === asset.size &&
    NodeCrypto.createHash("sha256").update(b).digest("hex") === asset.sha256;
  pending ??= (async () => {
    const kept = await NodeFS.promises.readFile(file).catch(() => null);
    if (kept !== null && (checked.has(file) || check(kept))) {
      checked.add(file);
      return kept;
    }
    const response = await get(asset.url, { signal: AbortSignal.timeout(5 * 60_000) }).catch(
      () => null,
    );
    if (response === null || !response.ok) return null;
    const bytes = new Uint8Array(await response.arrayBuffer());
    if (!check(bytes)) return null;
    await NodeFS.promises.mkdir(NodePath.dirname(file), { recursive: true });
    const part = `${file}.${process.pid}.part`;
    await NodeFS.promises.writeFile(part, bytes);
    await NodeFS.promises.rename(part, file);
    checked.add(file);
    return bytes;
  })()
    .catch(() => null)
    .finally(() => {
      pending = null;
    });
  return pending;
};

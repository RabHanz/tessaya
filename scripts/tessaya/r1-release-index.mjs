// Builds and signs the R1 firmware release list (DEVICE-UTILITY.md §7) from the r1-firmware-smp-* releases: every
// image is downloaded and its release signature checked before it is listed; the list is signed with the same key.
//   node scripts/tessaya/r1-release-index.mjs <releases.json from `gh release list --json tagName,publishedAt`> <outdir>
// Env: R1_OTA_SIGNING_KEY (PEM, or the private scalar in hex); REPO (owner/name). Without the key it only verifies.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const [releasesFile, outDir] = process.argv.slice(2);
const repo = process.env.REPO ?? "RabHanz/tessaya";
const firmwareSource = NodeFS.readFileSync("packages/baton-shared/src/r1Firmware.ts", "utf8");
const publicHex = /R1_FIRMWARE_PUBLIC_KEY =\s*"([0-9a-f]{130})"/.exec(firmwareSource)[1];
const recommended = /firmware: \{\s*version: "([^"]+)"/.exec(firmwareSource)[1];
const jwkOf = (d) => ({
  kty: "EC",
  crv: "P-256",
  x: Buffer.from(publicHex.slice(2, 66), "hex").toString("base64url"),
  y: Buffer.from(publicHex.slice(66), "hex").toString("base64url"),
  ...(d === undefined ? {} : { d: Buffer.from(d, "hex").toString("base64url") }),
});
const publicKey = NodeCrypto.createPublicKey({ key: jwkOf(), format: "jwk" });
const verify = (bytes, sig) =>
  /^[0-9a-f]{128}$/.test(sig) &&
  NodeCrypto.verify(
    "sha256",
    bytes,
    { key: publicKey, dsaEncoding: "ieee-p1363" },
    Buffer.from(sig, "hex"),
  );

const base = (tag) => `https://github.com/${repo}/releases/download/${tag}`;
const get = async (url) => {
  const r = await fetch(url);
  return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
};
/** An image and its `.json` manifest ({size, sha256, sig}), checked; null when absent; throws when it is wrong. */
const image = async (tag, file) => {
  const manifest = await get(`${base(tag)}/${file.replace(/\.(rbl|bin)$/, ".json")}`);
  if (manifest === null) return null;
  const m = JSON.parse(manifest.toString("utf8"));
  const url = `${base(tag)}/${file}`;
  const bytes = await get(url);
  if (bytes === null) throw new Error(`${file}: manifest without the image`);
  const sha256 = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  if (bytes.length !== m.size || sha256 !== m.sha256)
    throw new Error(`${file}: size or sha256 differs`);
  if (!verify(bytes, m.sig)) throw new Error(`${file}: not signed by the release key`);
  return { url, size: m.size, sha256, sig: m.sig };
};

const releases = [];
for (const { tagName, publishedAt } of JSON.parse(NodeFS.readFileSync(releasesFile, "utf8"))) {
  const version = /^r1-firmware-(smp-\d+\.\d+\.\d+)$/.exec(tagName)?.[1];
  if (version === undefined) continue;
  const name = `r1bt-${version}`;
  const rbl = await image(tagName, `${name}.rbl`);
  if (rbl === null) continue;
  releases.push({
    version,
    date: publishedAt.slice(0, 10),
    rbl,
    allapp: await image(tagName, `${name}-all-app.bin`),
  });
  console.log(
    `${version}: ok${releases.at(-1).allapp === null ? " (no cable image)" : ", cable image"}`,
  );
}
const num = (v) => v.replace(/^smp-/, "").split(".").map(Number);
releases.sort((a, b) => {
  const [x, y] = [num(a.version), num(b.version)];
  return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
});
const list = Buffer.from(JSON.stringify({ v: 1, recommended, releases }, null, 1) + "\n");
NodeFS.mkdirSync(outDir, { recursive: true });
NodeFS.writeFileSync(NodePath.join(outDir, "r1-releases.json"), list);
const secret = process.env.R1_OTA_SIGNING_KEY?.trim();
if (!secret) {
  console.log(`unsigned list of ${releases.length} (no key)`);
  process.exit(0);
}
const privateKey = secret.startsWith("-----BEGIN")
  ? NodeCrypto.createPrivateKey(secret)
  : NodeCrypto.createPrivateKey({ key: jwkOf(secret.padStart(64, "0")), format: "jwk" });
const sig = crypto
  .sign("sha256", list, { key: privateKey, dsaEncoding: "ieee-p1363" })
  .toString("hex");
if (!verify(list, sig)) throw new Error("the signing key is not the R1 release key");
NodeFS.writeFileSync(NodePath.join(outDir, "r1-releases.json.sig"), `${sig}\n`);
console.log(`signed list of ${releases.length}; recommended ${recommended}`);

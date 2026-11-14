// Signs one release file with the R1 release key, as the firmware's images are signed: ECDSA P-256 with SHA-256 over
// the exact bytes, raw r||s in hex, into FILE.sig. The desktop checks tessel-flash's SHA256SUMS this way before running it.
//   R1_OTA_SIGNING_KEY=<PEM or hex scalar> node tools/tessel-flash/sign.mjs tools/tessel-flash/dist/SHA256SUMS
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

const file = process.argv[2];
const source = NodeFS.readFileSync("packages/tessaya-shared/src/r1Firmware.ts", "utf8");
const publicHex = /R1_FIRMWARE_PUBLIC_KEY =\s*"([0-9a-f]{130})"/.exec(source)[1];
const jwkOf = (d) => ({
  kty: "EC",
  crv: "P-256",
  x: Buffer.from(publicHex.slice(2, 66), "hex").toString("base64url"),
  y: Buffer.from(publicHex.slice(66), "hex").toString("base64url"),
  ...(d === undefined ? {} : { d: Buffer.from(d, "hex").toString("base64url") }),
});
const secret = process.env.R1_OTA_SIGNING_KEY?.trim();
if (!secret) throw new Error("R1_OTA_SIGNING_KEY is not set");
const privateKey = secret.startsWith("-----BEGIN")
  ? NodeCrypto.createPrivateKey(secret)
  : NodeCrypto.createPrivateKey({ key: jwkOf(secret.padStart(64, "0")), format: "jwk" });
const bytes = NodeFS.readFileSync(file);
const sig = NodeCrypto.sign("sha256", bytes, { key: privateKey, dsaEncoding: "ieee-p1363" });
const publicKey = NodeCrypto.createPublicKey({ key: jwkOf(), format: "jwk" });
if (!NodeCrypto.verify("sha256", bytes, { key: publicKey, dsaEncoding: "ieee-p1363" }, sig))
  throw new Error("the signing key is not the R1 release key");
NodeFS.writeFileSync(`${file}.sig`, `${sig.toString("hex")}\n`);
console.log(`signed ${file}`);

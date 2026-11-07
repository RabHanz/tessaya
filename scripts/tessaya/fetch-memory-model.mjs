#!/usr/bin/env node
// Fetches the memory recall model (MEM-16): bge-small-en-v1.5, int8 ONNX, MIT, from the pinned Hugging Face
// revision, and checks its sha256. The model is not in git (34 MB); vocab.txt beside it is. Usage:
//   node scripts/tessaya/fetch-memory-model.mjs [destination folder]   (default: apps/server/resources/memory-model)
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } = NodeFS;
const { dirname, join, resolve } = NodePath;

const REVISION = "ea104dacec62c0de699686887e3f920caeb4f3e3";
const URL_ = `https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/${REVISION}/onnx/model_quantized.onnx`;
const SHA256 = "6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4";

const root = resolve(dirname(NodeURL.fileURLToPath(import.meta.url)), "../..");
const dir = resolve(process.argv[2] ?? join(root, "apps/server/resources/memory-model"));
const target = join(dir, "model_quantized.onnx");
const sha = (bytes) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");

if (existsSync(target) && sha(readFileSync(target)) === SHA256) {
  console.log(`memory model already at ${target}`);
  process.exit(0);
}
mkdirSync(dir, { recursive: true });
const response = await fetch(URL_, { redirect: "follow" });
if (!response.ok) throw new Error(`memory model download failed: ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const got = sha(bytes);
if (got !== SHA256) throw new Error(`memory model sha256 is ${got}, expected ${SHA256}`);
writeFileSync(`${target}.part`, bytes);
renameSync(`${target}.part`, target);
if (!existsSync(join(dir, "vocab.txt"))) {
  writeFileSync(
    join(dir, "vocab.txt"),
    readFileSync(join(root, "apps/server/resources/memory-model/vocab.txt")),
  );
}
console.log(`memory model at ${target} (${bytes.length} bytes, sha256 ok)`);

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "vite-plus/test";

import { BUNDLE_MARK, fetchPinned, install, type Pinned } from "./R1VoiceInstall.ts";

const sha = (bytes: Uint8Array) => NodeCrypto.createHash("sha256").update(bytes).digest("hex");
const pinOf = (file: string, bytes: Uint8Array, url = `https://example.test/${file}`): Pinned => ({
  file,
  url,
  size: bytes.length,
  sha256: sha(bytes),
});

/** Serves `files` by URL with Range support; the first answer for `cutOnce` breaks off half-way. */
const server = (files: Record<string, Uint8Array>, cutOnce?: string) => {
  const ranges: Array<string | null> = [];
  let cut = cutOnce;
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const bytes = files[url]!;
    const range = new Headers(init?.headers).get("range");
    ranges.push(range);
    const from = range === null ? 0 : Number(/bytes=(\d+)-/.exec(range)![1]);
    const body = bytes.subarray(from);
    const half = url === cut;
    if (half) cut = undefined;
    let sent = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(half ? body.subarray(0, body.length >> 1) : body);
        } else if (half) controller.error(new Error("connection reset"));
        else controller.close();
      },
    });
    return new Response(stream, { status: range === null ? 200 : 206 });
  }) as typeof fetch;
  return { fetchImpl, ranges };
};

const tmp = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "r1-voice-"));

it("resumes a broken download where it stopped, and keeps only bytes that match the pin", async () => {
  const dir = tmp();
  const bytes = NodeCrypto.randomBytes(64 * 1024);
  const pin = pinOf("models/m.onnx", bytes);
  const { fetchImpl, ranges } = server({ [pin.url]: bytes }, pin.url);
  await expect(fetchPinned(dir, pin, () => {}, fetchImpl)).rejects.toThrow();
  await fetchPinned(dir, pin, () => {}, fetchImpl);
  expect(ranges).toEqual([null, `bytes=${bytes.length >> 1}-`]);
  expect(sha(NodeFS.readFileSync(NodePath.join(dir, pin.file)))).toBe(pin.sha256);
  // Checked once: no second download.
  await fetchPinned(dir, pin, () => {}, fetchImpl);
  expect(ranges).toHaveLength(2);
  // Bytes that do not match are thrown away, never put in place.
  const wrong = { ...pinOf("models/w.onnx", bytes), sha256: "0".repeat(64) };
  const other = server({ [wrong.url]: bytes });
  await expect(fetchPinned(dir, wrong, () => {}, other.fetchImpl)).rejects.toThrow("checksum");
  expect(NodeFS.readdirSync(NodePath.join(dir, "models")).toSorted()).toEqual([
    "m.onnx",
    "m.onnx.verified",
  ]);
  NodeFS.rmSync(dir, { recursive: true, force: true });
});

it("unpacks the release bundle and fetches the models, reporting progress, once", async () => {
  const src = tmp();
  NodeFS.mkdirSync(NodePath.join(src, "app"));
  NodeFS.writeFileSync(NodePath.join(src, "app", "main.mjs"), "// loop");
  const tar = NodePath.join(src, "..", `${NodePath.basename(src)}.tar.gz`);
  NodeChildProcess.execFileSync("tar", ["-czf", tar, "-C", src, "."]);
  const tarBytes = NodeFS.readFileSync(tar);
  const model = new TextEncoder().encode("weights");
  const bundle = pinOf("bundle", tarBytes);
  const models = [pinOf("models/a.gguf", model)];
  const { fetchImpl, ranges } = server({ [bundle.url]: tarBytes, [models[0]!.url]: model });
  const dir = tmp();
  const seen: number[] = [];
  const run = () =>
    install({ dir, bundle, models, fetchImpl, onProgress: (p) => seen.push(p.done / p.total) });
  await run();
  expect(NodeFS.readFileSync(NodePath.join(dir, "app", "main.mjs"), "utf8")).toBe("// loop");
  expect(NodeFS.readFileSync(NodePath.join(dir, BUNDLE_MARK), "utf8")).toBe(bundle.sha256);
  expect(NodeFS.readFileSync(NodePath.join(dir, "models", "a.gguf"), "utf8")).toBe("weights");
  expect(seen.at(-1)).toBe(1);
  await run();
  expect(ranges).toHaveLength(2);
  for (const d of [src, dir]) NodeFS.rmSync(d, { recursive: true, force: true });
  NodeFS.rmSync(tar, { force: true });
});

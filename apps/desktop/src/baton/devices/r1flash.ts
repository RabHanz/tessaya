// @effect-diagnostics nodeBuiltinImport:off globalFetch:off
/**
 * The Tessel's cable repair from the desktop (DEVICE-UTILITY.md §3): Tessaya's Hardware page drives the standalone
 * tessel-flash tool (r1flash in older releases), downloaded once per version from our releases and checked against the R1 release key, so the bootrom
 * protocol exists once. The page never passes arguments: it names an operation and this builds the argv. A linked
 * write is never stopped from here; only the console is.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { R1_FIRMWARE_PUBLIC_KEY } from "@t3tools/tessaya-shared/r1Firmware";
import * as Electron from "electron";

import {
  R1FLASH_EVENT_CHANNEL,
  R1FLASH_INPUT_CHANNEL,
  R1FLASH_RUN_CHANNEL,
  R1FLASH_STOP_CHANNEL,
} from "../channels.ts";

export const R1FLASH_VERSION = "0.1.2";
const RELEASES = "https://github.com/RabHanz/tessaya/releases/download";
/** The tool's names, newest first: releases up to 0.1.1 are r1flash, kept for a pin moved back; drop it at the next pin. */
export const FLASH_TOOLS = ["tessel-flash", "r1flash"] as const;

const PORT = /^(?:COM\d{1,3}|\/dev\/(?:tty|cu)\.?[A-Za-z0-9._-]{1,40})$/;
const VERSION = /^smp-\d+\.\d+\.\d+$/;

/** The argv for one checked request, or null when it is not one this page may ask for. Pure. */
export const r1flashArgs = (request: unknown): ReadonlyArray<string> | null => {
  const r = (request ?? {}) as { op?: unknown; port?: unknown; version?: unknown };
  if (r.port !== undefined && (typeof r.port !== "string" || !PORT.test(r.port))) return null;
  const port = typeof r.port === "string" ? ["--port", r.port] : [];
  switch (r.op) {
    case "ports":
      return ["ports", "--json"];
    case "detect":
    case "recover":
    case "backup":
    case "console":
      return [r.op, ...port, "--json"];
    case "flash":
      return typeof r.version === "string" && VERSION.test(r.version)
        ? ["flash", "--version", r.version, ...port, "--json"]
        : null;
    default:
      return null;
  }
};

/** One NDJSON line from r1flash, or null when it is not an event. Pure. */
export const r1flashEvent = (line: string): Record<string, unknown> | null => {
  try {
    const v: unknown = JSON.parse(line);
    return typeof v === "object" && v !== null && typeof (v as { ev?: unknown }).ev === "string"
      ? (v as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
};

/** The binary's name in that tool's releases for this machine. */
export const r1flashAsset = (
  platform: string,
  arch: string,
  tool: (typeof FLASH_TOOLS)[number] = FLASH_TOOLS[0],
): string | null => {
  const os = platform === "win32" ? "windows" : platform === "darwin" ? "darwin" : "linux";
  const cpu = arch === "x64" ? "amd64" : arch === "arm64" ? "arm64" : null;
  if (cpu === null || (os === "windows" && cpu === "arm64")) return null;
  return `${tool}-${os}-${cpu}${os === "windows" ? ".exe" : ""}`;
};

/** The release key's signature over the checksums, raw r||s hex, checked like the R1 checks its firmware. */
export const signedSums = (sums: Buffer, sig: string): boolean => {
  if (!/^[0-9a-f]{128}$/.test(sig)) return false;
  const key = NodeCrypto.createPublicKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: Buffer.from(R1_FIRMWARE_PUBLIC_KEY.slice(2, 66), "hex").toString("base64url"),
      y: Buffer.from(R1_FIRMWARE_PUBLIC_KEY.slice(66), "hex").toString("base64url"),
    },
    format: "jwk",
  });
  return NodeCrypto.verify(
    "sha256",
    sums,
    { key, dsaEncoding: "ieee-p1363" },
    Buffer.from(sig, "hex"),
  );
};

const fetchBytes = async (url: string): Promise<Buffer> => {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`could not download ${url.split("/").at(-1)} (${r.status})`);
  return Buffer.from(await r.arrayBuffer());
};

/** The checked binary on disk, downloaded on first use from the first tool name whose release has this version. */
const ensureBinary = async (host: {
  readonly platform: string;
  readonly arch: string;
}): Promise<string> => {
  for (const tool of FLASH_TOOLS) {
    const asset = r1flashAsset(host.platform, host.arch, tool);
    if (asset === null) throw new Error("tessel-flash has no build for this computer.");
    const release = `${RELEASES}/${tool}-v${R1FLASH_VERSION}`;
    const dir = NodePath.join(Electron.app.getPath("userData"), tool, R1FLASH_VERSION);
    const file = NodePath.join(dir, asset);
    const sums = await fetchBytes(`${release}/SHA256SUMS`).catch(() => null);
    const have = NodeFS.existsSync(file) ? NodeFS.readFileSync(file) : null;
    // Offline with a copy already checked: use it.
    if (sums === null && have !== null) return file;
    // No release under this name (or offline): try the older name.
    if (sums === null) continue;
    const sig = (await fetchBytes(`${release}/SHA256SUMS.sig`)).toString("utf8").trim();
    if (!signedSums(sums, sig))
      throw new Error(`${tool}'s checksums are not signed by the release key.`);
    const want = sums
      .toString("utf8")
      .split("\n")
      .map((l) => l.trim().split(/\s+\*?/))
      .find(([, name]) => name === asset)?.[0];
    const sha = (b: Buffer) => NodeCrypto.createHash("sha256").update(b).digest("hex");
    if (want === undefined) throw new Error(`${tool} ${R1FLASH_VERSION} has no ${asset}.`);
    if (have !== null && sha(have) === want) return file;
    const bytes = await fetchBytes(`${release}/${asset}`);
    if (sha(bytes) !== want) throw new Error(`${tool} did not match its signed checksum.`);
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.writeFileSync(file, bytes, { mode: 0o755 });
    return file;
  }
  throw new Error("tessel-flash could not be downloaded; check the internet connection.");
};

/** Only a top-level page of the app itself, never a browser-panel guest. */
const trusted = (event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent) =>
  event.sender.getType() !== "webview" && event.senderFrame === event.sender.mainFrame;

export function installR1flash(host: { readonly platform: string; readonly arch: string }): void {
  const runs = new Map<number, { child: NodeChildProcess.ChildProcess; op: string }>();
  let next = 0;
  Electron.ipcMain.handle(R1FLASH_RUN_CHANNEL, async (event, request: unknown) => {
    if (!trusted(event)) return { code: 1, error: "Not allowed from this page." };
    const args = r1flashArgs(request);
    if (args === null) return { code: 1, error: "That request is not allowed." };
    // One cable job at a time: two programs on one port corrupt a write.
    if ([...runs.values()].some((r) => r.op !== "ports"))
      return { code: 2, error: "A cable job is already running." };
    let binary: string;
    try {
      binary = await ensureBinary(host);
    } catch (error) {
      return { code: 1, error: error instanceof Error ? error.message : String(error) };
    }
    const id = ++next;
    const sender = event.sender;
    const child = NodeChildProcess.spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"] });
    runs.set(id, { child, op: args[0]! });
    let buffer = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const ev = r1flashEvent(line);
        if (ev !== null && !sender.isDestroyed()) sender.send(R1FLASH_EVENT_CHANNEL, { id, ...ev });
      }
    });
    child.stderr.resume();
    return await new Promise<{ code: number; error?: string }>((resolve) => {
      child.on("error", (error) => {
        runs.delete(id);
        resolve({ code: 1, error: error.message });
      });
      child.on("close", (code) => {
        runs.delete(id);
        resolve({ code: code ?? 1 });
      });
    });
  });
  Electron.ipcMain.on(R1FLASH_INPUT_CHANNEL, (event, line: unknown) => {
    if (!trusted(event) || typeof line !== "string") return;
    for (const run of runs.values())
      if (run.op === "console") run.child.stdin?.write(`${line.slice(0, 200)}\n`);
  });
  // Only the console stops from here: a flash or recovery runs to its end, or the R1 needs the cable again.
  Electron.ipcMain.on(R1FLASH_STOP_CHANNEL, (event) => {
    if (!trusted(event)) return;
    for (const run of runs.values())
      if (run.op === "console" || run.op === "detect") run.child.kill();
  });
}

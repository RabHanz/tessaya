// @effect-diagnostics globalDate:off globalFetch:off globalRandom:off globalTimers:off nodeBuiltinImport:off
/**
 * Pocket TTS (Kyutai, MIT code, CC-BY-4.0 weights and voices, D113): their standalone binary kept
 * loaded and asked over loopback HTTP, so a sentence starts in a third of a second on the i7-8550U.
 * Files come down on first use, hash-checked by voiceModels.ts. It stops after ten quiet minutes,
 * because it holds 700 MB.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { POCKET_CONFIG_FULL, POCKET_CONFIG_QUICK } from "./pocketConfigs.ts";
import type { Synthesise } from "./voiceSpeaker.ts";
import { ensureModel, hashFile, type DownloadableModel } from "./voiceModels.ts";
import { markPhase } from "../lifecycle/mainStall.ts";

/** The voices offered in Settings and the persona file. */
export const POCKET_VOICES = ["anna", "vera", "charles", "paul"] as const;
/** A chosen voice: the full model's four, or the small model for a tight machine. */
export type PocketVoice = (typeof POCKET_ALL_VOICES)[number] | "quick";

const RELEASE = "https://github.com/kyutai-labs/pocket-tts/releases/download/v4.0.1";
const HF = "https://huggingface.co/kyutai/pocket-tts-without-voice-cloning/resolve";
const MODELS = "a7056f505a4a8ca72d8b5fb1440071d6f1a35739";
const TOKENIZER = "00eac05ed3d16bdc3f6b5d598874019c34a89214";
const TOKENIZER_QUICK = "08ffc58775e62aad9409511b9591c9af626270f3";
const VOICES = "a3055dcb533cf2ec90458008a01e7cef550bae2a";

/** Only the Windows build has been run; the others are untested. */
const BINARIES: Record<string, { readonly asset: string; readonly sha256: string }> = {
  "win32-x64": {
    asset: "pocket-tts-3.3.0-x86_64-pc-windows-msvc.zip",
    sha256: "98753041f2e65744b989776f87bccb93f1f574a08afe1890c5427ec94cd6309c",
  },
};

const model = (
  file: string,
  path: string,
  rev: string,
  size: number,
  sha256: string,
): DownloadableModel => ({ file, url: `${HF}/${rev}/languages/${path}`, size, sha256 });

/**
 * Every English voice at the pinned revision: name, bytes, sha256 (from the Hugging Face API). Source recordings and
 * their terms: kyutai/tts-voices; cosette (Expresso) and jean (EARS) come from non-commercial recordings.
 */
const VOICE_TABLE = [
  ["alba", 6244152, "4206b7194018c7e345e5cfd99f147caad36285df858ea153d0188c40d9f261e5"],
  ["anna", 7620408, "4f1a928fc92ae04367324cc5d880745c1e6680bd56bf99e5d26a1e80c2cff421"],
  ["azelma", 7178040, "cc09e106a1acf5fe0b4c5de61b2b7686080b7bab853f9c11bfef219801bf3126"],
  ["bill_boerst", 6539064, "063b245f60f682a2403e4c61d2e8754e0a2916d75b2cd515cc97355a9e7a10a8"],
  ["caro_davy", 5064504, "971a47f7e655e4e377915b2862f2b1242aa4f27659ed936c85387bc2dfe17595"],
  ["charles", 6195000, "21806203b56a8ee954b66a33fcdea636c67cd54760f20f12f7586062d9455337"],
  ["cosette", 6244152, "ee63b91d4614e939fa5eb24df8c43de367c552dfd60c1c6b61582a859e25298a"],
  ["daan", 3884848, "2241724e629acd348f2c810b587441812f1412262b6244378db5f73af430c8ac"],
  ["eponine", 6932280, "897d1d697e433f4ac1f0a8957fd2d69b073e316935c681fe488a7bf63a2b9a7b"],
  ["estelle", 7571256, "c6d0487d2a3e3d830b5dc3595ee9804df4920d87beb6dca042d769474e34db75"],
  ["eve", 6145848, "d31289743fdf306517925afb91e99c27b4d336c127013d2c4d1212791a41cf37"],
  ["fantine", 6440760, "a1803e41334934b199f4c7a2a4cec1069a75c0b3cb100e3cc3b5e76f0b07dd9e"],
  ["george", 5900088, "fc5ff4439cbbb532b69d2762524b55844e03352102f13376f2fa00443bc04090"],
  ["giovanni", 4130608, "abe83e91cc6984dc7d8ae1362fe4282ec095198087db7c2519f7a42dae2d9630"],
  ["jane", 7325496, "495ff63b1757ceb68a7a8e2d369b780e9d60dcd98a25ef784e246c65c9af4d90"],
  ["javert", 6145848, "f60f4603404152370ae5ad4d01fa9ad3e1afd3a5df6122aa3dd88ed95fbfd6f8"],
  ["jean", 6096696, "2d720746d3f2ec131b4dd67c0b101af7a7006798511bb975c707788e9a2467fc"],
  ["juergen", 6096696, "1382e92abb0abf4cd531d33d1ad4e6db0c9ebd10ab1b1533421e151f14190450"],
  ["lola", 5457720, "5be565a67bc85610d7b1d0a44fb7fb658d5d324504a4341a619ef1641f363503"],
  ["marius", 6244152, "6fd2496993221be51edc027820fa465b67221d7e369b8caeab40076040d561dd"],
  ["mary", 5949240, "f05824557190fe66e39837337d65c6c400aa54920bae316e1245eeb4cd447b8b"],
  ["michael", 7128888, "188f29bf53aca645d77accd44455b494a28e17d94b1658fbaec80f679371ad13"],
  ["paul", 6833976, "02b77e48b791c7ece818d7f85b98459bc8dc035104e6327635053ffb56898050"],
  ["peter_yearsley", 3639088, "7410cc6531929ea0ea7daa3a3f083a78239701df31acc60583172585a9304c3e"],
  ["rafael", 6244152, "ce295d539693b6ee3b4dc592e186661502392ceb5e403759a18c3c32acc38dd1"],
  ["stuart_bell", 5064504, "6ccec2880941cd132a9997798c8b0350d3dd547c890e45024873a85b017e5b39"],
  ["vera", 6686520, "6deb7eb7606810edbba1c9639376d6750a8f441e464e279c43341debf5c29765"],
] as const;
export const POCKET_ALL_VOICES = VOICE_TABLE.map(([name]) => name);

const VOICE_FILES = Object.fromEntries(
  VOICE_TABLE.map(([name, size, sha256]) => [
    name,
    model(`${name}.safetensors`, `english/embeddings/${name}.safetensors`, VOICES, size, sha256),
  ]),
) as Record<(typeof POCKET_ALL_VOICES)[number], DownloadableModel>;

const FULL_FILES = [
  model(
    "model.safetensors",
    "english/model.safetensors",
    MODELS,
    219029196,
    "4c56cbd171c63e8a26ea61f5d48b8a0cd8f3c51f4652c0ab9a19bfcced8c931d",
  ),
  model(
    "tokenizer.json",
    "english/tokenizer.json",
    TOKENIZER,
    245020,
    "f498428e1eafee50492f7be13dc9bfafcfc12e508cd0eb1b01c92ecd5d8c6687",
  ),
];

const QUICK_FILES = [
  model(
    "model.safetensors",
    "english_7m_2026-10/model.safetensors",
    MODELS,
    66482920,
    "aea704a2989277c1a700abc16fb1442cb6baa2fa9ad32251ef7a5f91e4eb7d58",
  ),
  model(
    "tokenizer.model",
    "english_7m_2026-10/tokenizer.model",
    TOKENIZER_QUICK,
    59339,
    "d461765ae179566678c93091c5fa6f2984c31bbe990bf1aa62d92c64d91bc3f6",
  ),
  model(
    "anna.safetensors",
    "english_7m_2026-10/embeddings/anna.safetensors",
    VOICES,
    1272208,
    "2834123280d7de036c9c3414b76732e58c0d10f17ab7e99e1ec63cf334f53317",
  ),
];

export interface PocketPlan {
  readonly dir: string;
  readonly files: ReadonlyArray<DownloadableModel>;
  readonly config: string;
  readonly voiceFile: string;
}

/** Which files a voice needs and the config that points at them. */
export const pocketPlan = (root: string, voice: PocketVoice): PocketPlan => {
  const quick = voice === "quick";
  const dir = NodePath.join(root, quick ? "quick" : "english");
  const slash = dir.replaceAll("\\", "/");
  return {
    dir,
    files: quick ? QUICK_FILES : [...FULL_FILES, VOICE_FILES[voice]],
    config: (quick ? POCKET_CONFIG_QUICK : POCKET_CONFIG_FULL).replaceAll("{dir}", slash),
    voiceFile: quick ? "anna.safetensors" : `${voice}.safetensors`,
  };
};

const IDLE_STOP_MS = 10 * 60_000;
const TTS_STALL_MS = 20_000;
const DOWNLOAD_MS = 10 * 60_000;
const READY_MS = 30_000;
/** Two threads gave the same first audio as four at a third less memory. */
const THREADS = "2";

export interface PocketEngine {
  /** The chosen voice, or null while its files are not here, which starts fetching them. */
  readonly synthesise: (voice: PocketVoice) => Synthesise | null;
  /**
   * Resolves true once the voice's files are here (fetching them if need be), false when they
   * cannot be: an unsupported machine, or a download that failed.
   */
  readonly ensure: (voice: PocketVoice) => Promise<boolean>;
  readonly dispose: () => void;
}

export const createPocketEngine = (input: {
  readonly root: string;
  readonly platform: string;
  readonly arch: string;
  readonly onProgress: (message: string | null) => void;
  /** The engine exited: its code and the end of what it wrote to stderr, for the log. */
  readonly onExit?: (exit: { readonly code: number | null; readonly stderr: string }) => void;
}): PocketEngine => {
  const build = BINARIES[`${input.platform}-${input.arch}`];
  // The archive holds one folder named after itself.
  const binary = NodePath.join(
    input.root,
    "bin",
    (build?.asset ?? "").replace(/\.(zip|tar\.gz)$/, ""),
    input.platform === "win32" ? "pocket-tts.exe" : "pocket-tts",
  );
  let server: {
    proc: NodeChildProcess.ChildProcess;
    port: number;
    voice: PocketVoice;
    up: Promise<void>;
  } | null = null;
  let fetching = false;
  let fetchJob: Promise<void> = Promise.resolve();
  const ready = new Set<PocketVoice>();
  let idle: ReturnType<typeof setTimeout> | null = null;

  const stop = () => {
    server?.proc.kill();
    server = null;
  };

  const fetchFiles = async (voice: PocketVoice) => {
    if (fetching || build === undefined) return;
    fetching = true;
    try {
      const plan = pocketPlan(input.root, voice);
      await NodeFSP.mkdir(plan.dir, { recursive: true });
      const total = plan.files.reduce((sum, file) => sum + file.size, 0);
      let done = 0;
      for (const file of plan.files) {
        await ensureModel({
          dir: plan.dir,
          model: file,
          onProgress: (fraction) =>
            input.onProgress(
              `Downloading the voice: ${Math.round(((done + file.size * fraction) / total) * 100)}%`,
            ),
        });
        done += file.size;
      }
      if (!NodeFS.existsSync(binary)) {
        const bin = NodePath.dirname(NodePath.dirname(binary));
        const archive = NodePath.join(bin, build.asset);
        await NodeFSP.mkdir(bin, { recursive: true });
        const { createHash } = await import("node:crypto");
        const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
        // The archive stays after it is unpacked: if the program is removed (a virus scanner does this to a downloaded
        // executable), unpacking the kept, checked archive restores it without going to the network again.
        // Streamed, so a large kept archive never holds the main thread.
        markPhase("pocket-archive-check:begin");
        const kept = NodeFS.existsSync(archive) && (await hashFile(archive)) === build.sha256;
        markPhase("pocket-archive-check:end");
        if (!kept) {
          const response = await fetch(`${RELEASE}/${build.asset}`, {
            signal: AbortSignal.timeout(DOWNLOAD_MS),
          });
          if (!response.ok) throw new Error(`Could not download the voice (${response.status}).`);
          const bytes = Buffer.from(await response.arrayBuffer());
          if (digest(bytes) !== build.sha256) {
            throw new Error("The voice did not match its checksum.");
          }
          await NodeFSP.writeFile(archive, bytes);
        }
        // Windows' own tar reads zip. By full path and a bare name: a Git tar first on PATH takes
        // "D:" for a remote host.
        const tar =
          input.platform === "win32"
            ? NodePath.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32", "tar.exe")
            : "tar";
        await new Promise<void>((resolve, reject) =>
          NodeChildProcess.execFile(tar, ["-xf", build.asset], { cwd: bin }, (error) =>
            error === null ? resolve() : reject(error),
          ),
        );
      }
      await NodeFSP.writeFile(NodePath.join(plan.dir, "config.yaml"), plan.config, "utf8");
      ready.add(voice);
      input.onProgress(null);
    } catch (error) {
      input.onProgress(error instanceof Error ? error.message : "The voice download failed.");
    } finally {
      fetching = false;
    }
  };

  const present = (voice: PocketVoice): boolean => {
    if (ready.has(voice)) return true;
    const plan = pocketPlan(input.root, voice);
    const here =
      NodeFS.existsSync(binary) &&
      NodeFS.existsSync(NodePath.join(plan.dir, "config.yaml")) &&
      plan.files.every((file) => NodeFS.existsSync(NodePath.join(plan.dir, file.file)));
    if (here) ready.add(voice);
    return here;
  };

  const start = (voice: PocketVoice) => {
    if (server?.voice === voice) return server;
    stop();
    const plan = pocketPlan(input.root, voice);
    const port = 49_152 + Math.floor(Math.random() * 16_000);
    const proc = NodeChildProcess.spawn(
      binary,
      [
        "serve",
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--config",
        NodePath.join(plan.dir, "config.yaml"),
        "--default-voice",
        NodePath.join(plan.dir, plan.voiceFile),
      ],
      {
        windowsHide: true,
        stdio: ["ignore", "ignore", "pipe"],
        cwd: plan.dir,
        // A downloaded binary gets what a process needs to start, and none of his variables.
        env: {
          ...Object.fromEntries(
            ["SystemRoot", "TEMP", "TMP", "HOME", "USERPROFILE"].flatMap((key) => {
              const value = process.env[key];
              return value === undefined ? [] : [[key, value]];
            }),
          ),
          RAYON_NUM_THREADS: THREADS,
        },
      },
    );
    const up = (async () => {
      const deadline = Date.now() + READY_MS;
      for (;;) {
        if (proc.exitCode !== null) throw new Error(`The voice stopped (exit ${proc.exitCode}).`);
        const ok = await fetch(`http://127.0.0.1:${port}/health`, {
          signal: AbortSignal.timeout(2_000),
        }).then(
          (r) => r.ok,
          () => false,
        );
        if (ok) return;
        if (Date.now() > deadline) throw new Error("The voice took too long to start.");
        await new Promise((r) => setTimeout(r, 120));
      }
    })();
    const entry = { proc, port, voice, up };
    // Only the last few lines are kept: enough to say why it stopped.
    let stderr = "";
    proc.stderr?.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(-2_000);
    });
    proc.on("exit", (code) => {
      if (server === entry) server = null;
      input.onExit?.({ code, stderr });
    });
    proc.on("error", () => undefined);
    up.catch(() => undefined);
    server = entry;
    return entry;
  };

  const ensure = async (voice: PocketVoice): Promise<boolean> => {
    if (build === undefined) return false;
    // One download at a time: a different voice's waits its turn, then looks again.
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (present(voice)) return true;
      fetchJob = fetching ? fetchJob : fetchFiles(voice);
      await fetchJob;
    }
    return present(voice);
  };

  return {
    ensure,
    synthesise: (voice) => {
      if (build === undefined) return null;
      if (!present(voice)) {
        void ensure(voice);
        return null;
      }
      return (text) => {
        if (idle !== null) clearTimeout(idle);
        idle = setTimeout(stop, IDLE_STOP_MS);
        const abort = new AbortController();
        // A wedged engine must not leave Baton believing it is still speaking.
        let stall: ReturnType<typeof setTimeout> | null = null;
        const alive = () => {
          if (stall !== null) clearTimeout(stall);
          stall = setTimeout(() => abort.abort(), TTS_STALL_MS);
        };
        const stream = (async function* () {
          const { port, up } = start(voice);
          await up;
          alive();
          const response = await fetch(`http://127.0.0.1:${port}/tts`, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ text }).toString(),
            signal: abort.signal,
          });
          if (!response.ok || response.body === null) {
            throw new Error(`The voice answered ${response.status}.`);
          }
          try {
            for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
              alive();
              yield Buffer.from(chunk);
            }
          } finally {
            if (stall !== null) clearTimeout(stall);
          }
        })();
        return { stream, cancel: () => abort.abort() };
      };
    },
    dispose: () => {
      if (idle !== null) clearTimeout(idle);
      stop();
    },
  };
};

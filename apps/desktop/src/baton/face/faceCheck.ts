// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
/**
 * Tessaya's face check on this desktop: the same on-device engine as the owner's Windows face unlock, run as a
 * sidecar (`faceid.exe`, installed with face-unlock) only when Tessaya asks. Bundling it would add ~50 MB (SFace and
 * ONNX Runtime) to every install for one Windows user, so it is found, not shipped. Templates are sealed by the engine
 * (DPAPI plus a TPM key) per member, each with a consent record; frames never leave the sidecar's memory.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  BIOMETRIC_LIMIT_START,
  type BiometricLimit,
  type BiometricReading,
  biometricAllowed,
  faceReading,
  type FaceEngineLine,
  parseFaceEngineLine,
  recordBiometricAttempt,
  walkedAway,
} from "@t3tools/tessaya-shared/biometrics";

export type FaceRun = (
  args: ReadonlyArray<string>,
  onLine: (line: FaceEngineLine) => void,
) => Promise<Extract<FaceEngineLine, { type: "result" }> | null>;

/** Runs the sidecar, streaming its JSON lines; null when it is missing or says nothing usable. */
export const runFaceEngine =
  (exe: string): FaceRun =>
  (args, onLine) =>
    new Promise((resolve) => {
      let last: Extract<FaceEngineLine, { type: "result" }> | null = null;
      let buf = "";
      const child = NodeChildProcess.spawn(exe, [...args], { windowsHide: true });
      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        buf += chunk;
        for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
          const line = parseFaceEngineLine(buf.slice(0, nl).trim());
          buf = buf.slice(nl + 1);
          if (line === null) continue;
          if (line.type === "result") last = line;
          onLine(line);
        }
      });
      const timer = setTimeout(() => child.kill(), 60_000);
      child.on("error", () => resolve(null));
      child.on("close", () => {
        clearTimeout(timer);
        resolve(last);
      });
    });

/** Where face-unlock installs the engine; TESSAYA_FACEID points elsewhere for a dev build. */
export const faceEnginePath = (env: Readonly<Record<string, string | undefined>>): string =>
  env["TESSAYA_FACEID"] ??
  NodePath.join(env["ProgramFiles"] ?? "C:\\Program Files", "FaceUnlock", "faceid.exe");

interface Consent {
  readonly member: string;
  readonly name: string;
  readonly at: string;
}

export const createFaceCheck = (input: {
  readonly stateDir: string;
  readonly platform: string;
  readonly exe: string;
  /** The setting: off means the camera is never opened for Tessaya. */
  readonly on: () => boolean;
  readonly run?: FaceRun;
  readonly progress?: (message: string) => void;
  readonly onNote?: (event: string, data: Record<string, unknown>) => void;
  readonly now?: () => number;
}) => {
  const dir = NodePath.join(input.stateDir, "face");
  const run = input.run ?? runFaceEngine(input.exe);
  const now = input.now ?? Date.now;
  const tmpl = (member: string) => NodePath.join(dir, `${encodeURIComponent(member)}.bin`);
  const consentFile = NodePath.join(dir, "consent.json");
  let limit: BiometricLimit = BIOMETRIC_LIMIT_START;
  let busy = false;

  const consents = (): ReadonlyArray<Consent> => {
    try {
      const v: unknown = JSON.parse(NodeFS.readFileSync(consentFile, "utf8"));
      return Array.isArray(v) ? (v as Consent[]) : [];
    } catch {
      return [];
    }
  };
  const writeConsents = (list: ReadonlyArray<Consent>) => {
    NodeFS.mkdirSync(dir, { recursive: true });
    NodeFS.writeFileSync(consentFile, JSON.stringify(list, null, 1));
  };
  /** Members with both a template and a consent record, in a stable order. */
  const enrolled = (): ReadonlyArray<Consent> =>
    consents().filter((c) => NodeFS.existsSync(tmpl(c.member)));

  const available = (): boolean =>
    input.platform === "win32" && input.on() && NodeFS.existsSync(input.exe);

  const exclusive = async <T>(work: () => Promise<T>, fallback: T): Promise<T> => {
    if (busy || !available()) return fallback;
    busy = true;
    try {
      return await work();
    } finally {
      busy = false;
    }
  };
  const forward = (line: FaceEngineLine) => {
    if (line.type === "progress") input.progress?.(line.message);
  };

  const scan = (): Promise<BiometricReading | null> =>
    exclusive(async () => {
      const list = enrolled();
      const r = await run(
        ["verify", "--passive", ...list.flatMap((c) => ["--template", tmpl(c.member)])],
        () => {},
      );
      if (r === null || r.reason === "camera") return null;
      return faceReading(
        r,
        list.map((c) => c.member),
        r.ok || r.reason === "multiple_faces" || r.reason === "no_match",
      );
    }, null);

  return {
    available,
    scan,
    enrolled: () => enrolled().map((c) => ({ member: c.member, name: c.name, at: c.at })),

    /** Enrols a member who is at the camera; their looking at it while asked is their consent, recorded with it. */
    enrol: (member: { readonly id: string; readonly name: string }) =>
      exclusive(async () => {
        NodeFS.mkdirSync(dir, { recursive: true });
        const r = await run(["enroll", "--out", tmpl(member.id)], forward);
        if (r?.ok !== true) {
          input.onNote?.("face_enrol_failed", { reason: r?.reason ?? "engine" });
          return false;
        }
        writeConsents([
          ...consents().filter((c) => c.member !== member.id),
          { member: member.id, name: member.name, at: new Date(now()).toISOString() },
        ]);
        input.onNote?.("face_enrolled", {});
        return true;
      }, false),

    /** Deletes a member's template and consent. Works with the setting off: deleting must always be possible. */
    remove: async (member: string): Promise<void> => {
      if (NodeFS.existsSync(tmpl(member)) && NodeFS.existsSync(input.exe))
        await run(["delete", "--template", tmpl(member)], () => {});
      NodeFS.rmSync(tmpl(member), { force: true });
      writeConsents(consents().filter((c) => c.member !== member));
      input.onNote?.("face_deleted", {});
    },

    /**
     * While an A3 lease is open: look every few seconds and call `gone` once he has not been seen for 10 s. Only
     * narrows (ends the lease early). Returns the stop function; it also stops itself after calling `gone`.
     */
    watchAway: (member: string, gone: () => void, everyMs = 4_000): (() => void) => {
      let lastSeen: number | null = now();
      const timer = setInterval(() => {
        void scan().then((r) => {
          if (r !== null && r.member === member) lastSeen = now();
          if (walkedAway(lastSeen, now())) {
            clearInterval(timer);
            input.onNote?.("face_walked_away", {});
            gone();
          }
        });
      }, everyMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },

    /** The full check (PAD, head-turn challenge, 3D motion) for one member: an A1 face proof when it passes. */
    prove: (member: string): Promise<BiometricReading | null> =>
      exclusive(async () => {
        if (!biometricAllowed(limit, now())) return null;
        const list = enrolled();
        const at = list.findIndex((c) => c.member === member);
        if (at < 0) return null;
        const r = await run(
          [
            "verify",
            "--require",
            String(at),
            ...list.flatMap((c) => ["--template", tmpl(c.member)]),
          ],
          forward,
        );
        limit = recordBiometricAttempt(limit, r?.ok === true, now());
        input.onNote?.("face_check", {
          ok: r?.ok === true,
          reason: r?.reason ?? "engine",
          ms: r?.wallMs ?? 0,
        });
        if (r === null) return null;
        const reading = faceReading(
          r,
          list.map((c) => c.member),
          r.ok,
        );
        return r.ok ? { ...reading, member } : reading;
      }, null),

    /** Turns face back on after the daily limit switched it off (his explicit act in Settings). */
    resetLimit: () => {
      limit = BIOMETRIC_LIMIT_START;
    },
    limited: () => !biometricAllowed(limit, now()),
  };
};

export type FaceCheck = ReturnType<typeof createFaceCheck>;

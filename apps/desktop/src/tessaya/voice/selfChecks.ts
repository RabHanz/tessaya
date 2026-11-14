/**
 * The window's Check area (D134): what is wrong, in plain words, with a one-line fix. This only
 * turns what Baton already knows (the device list, the wake and speech models, the first-run
 * sign-in detection) into rows. The one live reading, the microphone level, is taken only
 * while he presses its button.
 */
import type { BrainStatus } from "../screen/brainChoice.ts";

export type CheckStatus = "ok" | "warn" | "bad";

export interface CheckResult {
  readonly id: string;
  readonly title: string;
  readonly status: CheckStatus;
  readonly detail: string;
  /** Present when it is not ok. */
  readonly fix?: string;
}

export interface CheckInput {
  readonly mic: {
    readonly devices: number;
    readonly using: string | null;
    readonly listening: boolean;
    readonly trouble: string | null;
  };
  /** Loudest reading, 0 to 1, in his last test; null when he has not tested. */
  readonly micPeak: number | null;
  readonly wake: {
    readonly enabled: ReadonlyArray<string>;
    readonly missing: ReadonlyArray<string>;
    readonly coreLoaded: boolean;
    readonly baseModelsMissing: number;
  };
  readonly speech: { readonly present: boolean; readonly label: string; readonly sizeMb: number };
  readonly signIn: BrainStatus | null;
  /** Electron's media access status for the screen, or null where the OS has none. */
  readonly screenAccess: string | null;
  readonly disk: { readonly freeMb: number | null; readonly neededMb: number };
}

/** Quiet speech peaks around 0.3 on this scale; under 0.05 is a muted or dead input. */
const QUIET_PEAK = 0.05;
const DISK_MARGIN_MB = 1_000;
const free = (mb: number) => (mb < 1_000 ? `${Math.round(mb)} MB` : `${Math.round(mb / 1000)} GB`);

const ok = (id: string, title: string, detail: string): CheckResult => ({
  id,
  title,
  status: "ok",
  detail,
});
const not = (
  id: string,
  title: string,
  status: "warn" | "bad",
  detail: string,
  fix: string,
): CheckResult => ({ id, title, status, detail, fix });

export const runChecks = (i: CheckInput): ReadonlyArray<CheckResult> => {
  const out: CheckResult[] = [];

  out.push(
    i.mic.devices === 0
      ? not(
          "mic",
          "Microphone",
          "bad",
          "No microphone found.",
          "Plug one in or allow microphone access in system settings.",
        )
      : i.mic.trouble !== null
        ? not(
            "mic",
            "Microphone",
            "warn",
            i.mic.trouble,
            "Unplug and replug it, or pick another under Listening.",
          )
        : ok("mic", "Microphone", `Using ${i.mic.using ?? "the system microphone"}.`),
  );

  out.push(
    i.micPeak === null
      ? not(
          "level",
          "Microphone level",
          "warn",
          i.mic.listening ? "Not tested yet." : "Not tested. Tessaya is not listening.",
          i.mic.listening
            ? "Press Test microphone and say a few words."
            : "Turn on Listen for my wake word, then press Test microphone.",
        )
      : i.micPeak < QUIET_PEAK
        ? not(
            "level",
            "Microphone level",
            "bad",
            "Nothing came through.",
            "Check it is not muted, or pick another microphone.",
          )
        : ok("level", "Microphone level", "Your voice came through."),
  );

  out.push(
    i.wake.enabled.length === 0
      ? not(
          "wake",
          "Wake word",
          "warn",
          "No wake word is on.",
          "Turn one on under Listening, More options.",
        )
      : i.wake.baseModelsMissing > 0
        ? not(
            "wake",
            "Wake word",
            "bad",
            "Tessaya's listening models are missing.",
            "Reinstall Tessaya.",
          )
        : i.wake.missing.length > 0
          ? not(
              "wake",
              "Wake word",
              "bad",
              `No model for ${i.wake.missing.join(", ")}.`,
              "Turn that word off, or add its model file to the voice models folder.",
            )
          : i.wake.coreLoaded
            ? ok("wake", "Wake word", `Listening for ${i.wake.enabled.join(", ")}.`)
            : not(
                "wake",
                "Wake word",
                "warn",
                "Models are there but Tessaya is not listening.",
                "Turn on Listen for my wake word.",
              ),
  );

  out.push(
    i.speech.present
      ? ok("speech", "Speech model", `${i.speech.label} is on this computer.`)
      : not(
          "speech",
          "Speech model",
          "bad",
          `${i.speech.label} is not downloaded.`,
          `Choose Download under Dictation, ${i.speech.sizeMb} MB.`,
        ),
  );

  const tool = (
    id: string,
    title: string,
    state: "ready" | "signed-out" | "missing",
    cmd: string,
  ) =>
    state === "ready"
      ? ok(id, title, "Installed and signed in.")
      : state === "signed-out"
        ? not(id, title, "warn", "Installed, not signed in.", `Run ${cmd} in a terminal.`)
        : not(id, title, "warn", "Not installed.", `Install ${title}, then run the checks again.`);
  if (i.signIn === null) {
    out.push(
      not("signin", "Claude Code and Codex", "warn", "Could not check.", "Run the checks again."),
    );
  } else {
    out.push(tool("claude", "Claude Code", i.signIn.claude.state, "claude auth login"));
    out.push(tool("codex", "Codex", i.signIn.codex.state, "codex login"));
  }

  out.push(
    i.screenAccess === null || i.screenAccess === "granted"
      ? ok(
          "screen",
          "Screen capture",
          i.screenAccess === null ? "No permission needed here." : "Allowed.",
        )
      : not(
          "screen",
          "Screen capture",
          "bad",
          "Not allowed.",
          "Allow Tessaya under Screen Recording in system settings.",
        ),
  );

  out.push(
    i.disk.freeMb === null
      ? not(
          "disk",
          "Disk space",
          "warn",
          "Could not read free space.",
          "Check the drive Tessaya is installed on.",
        )
      : i.disk.freeMb < i.disk.neededMb + DISK_MARGIN_MB
        ? not(
            "disk",
            "Disk space",
            "bad",
            `${free(i.disk.freeMb)} free, models need ${Math.round(i.disk.neededMb)} MB.`,
            "Free some space on this drive.",
          )
        : ok("disk", "Disk space", `${free(i.disk.freeMb)} free.`),
  );

  return out;
};

/* oxlint-disable t3code/no-global-process-runtime -- Baton file predating the rule (D82) */
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics globalTimers:off
/**
 * Windows Hello as a consent gate (D151): Windows' UserConsentVerifier through PowerShell, since Electron can't reach
 * it through WebAuthn. A gate the app enforces, not a secret (VAULT.md section 3); elsewhere "unavailable". PowerShell
 * and WinRT take seconds to start, so `warmHello` starts a helper early that waits on stdin for the prompt's message.
 */
import * as NodeChildProcess from "node:child_process";

const SCRIPT = `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
$as = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
$check = $as.MakeGenericMethod([Windows.Security.Credentials.UI.UserConsentVerifierAvailability]).Invoke($null, @([Windows.Security.Credentials.UI.UserConsentVerifier]::CheckAvailabilityAsync()))
$check.Wait()
$ask = $as.MakeGenericMethod([Windows.Security.Credentials.UI.UserConsentVerificationResult])
$message = [Console]::In.ReadLine()
if ($null -eq $message) { exit }
if ([string]$check.Result -ne 'Available') { Write-Output $check.Result; exit }
$t = $ask.Invoke($null, @([Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync($message)))
$t.Wait()
Write-Output $t.Result
`;
const ENCODED = Buffer.from(SCRIPT, "utf16le").toString("base64");

export type HelloResult = "verified" | "declined" | "unavailable";

export const parseHello = (output: string): HelloResult => {
  const word = output.trim().split(/\s+/).pop() ?? "";
  if (word === "Verified") return "verified";
  return /^(DeviceNotPresent|NotConfiguredForUser|DisabledByPolicy|DeviceBusy)$/.test(word)
    ? "unavailable"
    : "declined";
};

interface Helper {
  /** Sends the prompt's message; the helper answers once and exits. */
  readonly ask: (message: string) => void;
  readonly output: Promise<string>;
  readonly stop: () => void;
}

const spawnHelper = (): Helper => {
  const child = NodeChildProcess.spawn(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-EncodedCommand", ENCODED],
    { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] },
  );
  const output = new Promise<string>((resolve) => {
    let out = "";
    child.stdout.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.on("close", () => resolve(out));
    child.on("error", () => resolve(""));
  });
  return {
    ask: (message) => child.stdin.end(`${message.replace(/[\r\n]+/g, " ")}\n`),
    output,
    stop: () => void child.kill(),
  };
};

/** One waiting helper at most; it is used by the next ask, and nothing starts another until `warm` is called again. */
export const createHello = (platform: string, spawn: () => Helper = spawnHelper) => {
  let waiting: Helper | null = null;
  return {
    warm: () => {
      if (platform === "win32" && waiting === null) waiting = spawn();
    },
    cool: () => {
      waiting?.stop();
      waiting = null;
    },
    /** The verifier's raw answer (`parseHello` reads it). */
    ask: async (message: string): Promise<string> => {
      const helper = waiting ?? spawn();
      waiting = null;
      helper.ask(message);
      const timer = setTimeout(helper.stop, 60_000);
      try {
        return await helper.output;
      } finally {
        clearTimeout(timer);
      }
    },
  };
};

const shared = createHello(process.platform);
/** Starts a helper now, so the next Windows Hello prompt appears without PowerShell's start-up. */
export const warmHello = shared.warm;
/** Stops a waiting helper nobody will use. */
export const coolHello = shared.cool;

export const windowsHello = (
  message: string,
  platform: string = process.platform,
  run: (message: string) => Promise<string> = (m) => shared.ask(m),
): Promise<HelloResult> =>
  platform === "win32" ? run(message).then(parseHello) : Promise.resolve("unavailable");

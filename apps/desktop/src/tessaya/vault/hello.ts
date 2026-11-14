/* oxlint-disable t3code/no-global-process-runtime -- Baton file predating the rule (D82) */
// @effect-diagnostics nodeBuiltinImport:off
/**
 * Windows Hello as a consent gate (D151). Electron cannot reach a platform authenticator through WebAuthn,
 * so this asks Windows' UserConsentVerifier through a short PowerShell call. It is a gate the app
 * enforces, not a cryptographic secret (VAULT.md section 3). Anywhere else it answers "unavailable".
 */
import * as NodeChildProcess from "node:child_process";

const SCRIPT = (message: string) => `
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Security.Credentials.UI.UserConsentVerifier, Windows.Security.Credentials.UI, ContentType = WindowsRuntime]
$op = [Windows.Security.Credentials.UI.UserConsentVerifier]::RequestVerificationAsync('${message.replace(/'/g, "")}')
$as = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
$t = $as.MakeGenericMethod([Windows.Security.Credentials.UI.UserConsentVerificationResult]).Invoke($null, @($op))
$t.Wait()
Write-Output $t.Result
`;

export type HelloResult = "verified" | "declined" | "unavailable";

export const parseHello = (output: string): HelloResult => {
  const word = output.trim().split(/\s+/).pop() ?? "";
  if (word === "Verified") return "verified";
  return /^(DeviceNotPresent|NotConfiguredForUser|DisabledByPolicy|DeviceBusy)$/.test(word)
    ? "unavailable"
    : "declined";
};

export const windowsHello = (
  message: string,
  platform: string = process.platform,
  run: (script: string) => Promise<string> = (script) =>
    new Promise((resolve) =>
      NodeChildProcess.execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", script],
        { timeout: 60_000, windowsHide: false },
        (_error, stdout) => resolve(stdout),
      ),
    ),
): Promise<HelloResult> =>
  platform === "win32" ? run(SCRIPT(message)).then(parseHello) : Promise.resolve("unavailable");

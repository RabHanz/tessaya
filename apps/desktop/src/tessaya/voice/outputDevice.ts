// @effect-diagnostics nodeBuiltinImport:off
/**
 * Headphones or speakers, read from Windows' default playback device's form factor. With headphones the
 * microphone cannot hear her, so talking over her is a cut-in. Only a known form factor decides: a Bluetooth
 * speaker is a speaker, and a device that does not say counts as speakers.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export type OutputDevice = "auto" | "headphones" | "speakers";

/** His saved choice. Before Automatic this was a switch: on meant headphones, and off is now Automatic. */
export const outputDeviceFrom = (saved: Readonly<Record<string, unknown>>): OutputDevice =>
  saved["outputDevice"] === "headphones" || saved["outputDevice"] === "speakers"
    ? saved["outputDevice"]
    : saved["outputDevice"] === undefined && saved["headphones"] === true
      ? "headphones"
      : "auto";

// shortcut: reads the console default device (role 0); an app routed to another device in Windows' per-app
// sound settings is not seen. Upgrade to the audio session's own endpoint if he routes Tessaya separately.
const SOURCE = `using System;
using System.Runtime.InteropServices;
[StructLayout(LayoutKind.Sequential)] public struct PropertyKey { public Guid fmtid; public int pid; }
[StructLayout(LayoutKind.Explicit, Size = 24)] public struct PropVariant { [FieldOffset(0)] public ushort vt; [FieldOffset(8)] public uint ui4; }
[Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IPropertyStore { int GetCount(out int count); int GetAt(int i, out PropertyKey key); int GetValue(ref PropertyKey key, out PropVariant value); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(); int OpenPropertyStore(int access, out IPropertyStore store); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-46C5-9B0E-3F2FD7D7C8E0")] class MMDeviceEnumeratorComObject { }
public class TessayaOutput {
  public static string Get() {
    var e = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator; IMMDevice d; e.GetDefaultAudioEndpoint(0, 0, out d);
    IPropertyStore s; d.OpenPropertyStore(0, out s);
    var form = new PropertyKey { fmtid = new Guid("1da5d803-d492-4edd-8c23-e0c0ffee7f0e"), pid = 0 };
    PropVariant f; s.GetValue(ref form, out f);
    return f.vt == 19 ? f.ui4.ToString() : "";
  }
}`;

/**
 * The default render endpoint's PKEY_AudioEndpoint_FormFactor. The C# is compiled once into `dir` (named by its
 * source, so a new version compiles afresh) and only loaded after that, so a read does not compile on the wake path.
 */
export const readScript = (dir: string): string => {
  // A Windows path wherever this runs: the script only ever runs on Windows.
  const dll = NodePath.win32
    .join(
      dir,
      `tessaya-output-${NodeCrypto.createHash("sha256").update(SOURCE).digest("hex").slice(0, 12)}.dll`,
    )
    .replaceAll("'", "''");
  // Built to a file of its own and moved into place, so a read that dies mid-build leaves no half DLL; one that
  // will not load (damaged, or locked out) is deleted and built again rather than failing every read until a release.
  return `$dll = '${dll}'
function Build {
  $tmp = "$dll.$PID.tmp"
  Add-Type -TypeDefinition @'
${SOURCE}
'@ -OutputAssembly $tmp -ErrorAction Stop
  Move-Item -Force -LiteralPath $tmp -Destination $dll
  Remove-Item -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
}
if (-not (Test-Path -LiteralPath $dll)) { Build }
try { Add-Type -LiteralPath $dll -ErrorAction Stop } catch {
  Remove-Item -Force -LiteralPath $dll -ErrorAction SilentlyContinue
  Build
  Add-Type -LiteralPath $dll
}
[TessayaOutput]::Get()`;
};

/** EndpointFormFactor values that are worn, and ones that fill the room. */
const WORN = new Set([3, 5, 6]); // Headphones, Headset, Handset
const ROOM = new Set([1, 2, 8, 9]); // Speakers, LineLevel, SPDIF, DigitalAudioDisplayDevice (a screen's speakers)

/** "3" → headphones, "1" → speakers. Null when the device does not say; anything after the number is ignored. */
export const outputKindOf = (out: string): "headphones" | "speakers" | null => {
  const m = /^\s*(\d+)\b/.exec(out);
  const form = m === null ? Number.NaN : Number(m[1]);
  return WORN.has(form) ? "headphones" : ROOM.has(form) ? "speakers" : null;
};

/** His choice, or what was detected; speakers when neither knows, so talking over her is never taken as a cut-in by guess. */
export const speakerModeOf = (
  chosen: OutputDevice,
  detected: "headphones" | "speakers" | null,
): "headphones" | "speakers" => (chosen === "auto" ? (detected ?? "speakers") : chosen);

const powershell = (script: string): Promise<string> =>
  new Promise((resolve, reject) =>
    NodeChildProcess.execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: 8_000, windowsHide: true },
      (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
    ),
  );

/**
 * Reads the device in the background; `kind` is the last answer. At most once in `everyMs`, except while the last
 * answer was headphones: taking them off must not leave her cutting herself off for long. Windows only.
 */
export const createOutputWatch = (input: {
  readonly platform: string;
  /** Where the compiled reader is kept (`readScript`). */
  readonly dir: string;
  readonly run?: (script: string) => Promise<string>;
  readonly everyMs?: number;
  readonly now?: () => number;
}) => {
  const run = input.run ?? powershell;
  const now = input.now ?? Date.now;
  const everyMs = input.everyMs ?? 15_000;
  let kind: "headphones" | "speakers" | null = null;
  let lastAt = -Infinity;
  let reading: Promise<void> | null = null;
  if (input.platform === "win32") {
    try {
      NodeFS.mkdirSync(input.dir, { recursive: true });
    } catch {
      // The read then fails, and a failed read is unknown: speakers.
    }
  }
  return {
    // While a fresh look is on its way, a headphones answer may be old: she may be playing through speakers now,
    // and taking her own voice for a cut-in is worse than a cut-in that waits a second.
    kind: () => (reading !== null && kind === "headphones" ? null : kind),
    refresh: (): Promise<void> => {
      if (input.platform !== "win32") return Promise.resolve();
      if (reading !== null) return reading;
      if (kind !== "headphones" && now() - lastAt < everyMs) return Promise.resolve();
      lastAt = now();
      // A failed read is not a reading: unknown, which counts as speakers.
      reading = run(readScript(input.dir))
        .then((out) => void (kind = outputKindOf(out)))
        .catch(() => void (kind = null))
        .finally(() => (reading = null));
      return reading;
    },
  };
};

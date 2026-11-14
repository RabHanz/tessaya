// @effect-diagnostics nodeBuiltinImport:off globalTimers:off
/**
 * Lowers or mutes the system volume while he dictates, and puts it back after (Windows, through the
 * default playback device's master volume). The volume he had is written to a file first, so a crash
 * while it is lowered is repaired at the next start. Any failure leaves the volume alone.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

export type DuckMode = "off" | "lower" | "mute";
export const DUCK_LEVEL = 0.15;

const HEAD = `Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
[Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IAudioEndpointVolume { int f(); int g(); int h(); int i(); int SetMasterVolumeLevelScalar(float level, Guid ctx); int j(); int GetMasterVolumeLevelScalar(out float level); int k(); int l(); int m(); int n(); int SetMute([MarshalAs(UnmanagedType.Bool)] bool mute, Guid ctx); int GetMute(out bool mute); }
[Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDevice { int Activate(ref Guid id, int clsCtx, int activationParams, out IAudioEndpointVolume aev); }
[Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
interface IMMDeviceEnumerator { int f(); int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint); }
[ComImport, Guid("BCDE0395-E52F-46C5-9B0E-3F2FD7D7C8E0")] class MMDeviceEnumeratorComObject { }
public class TessayaVolume {
  static IAudioEndpointVolume Endpoint() {
    var e = new MMDeviceEnumeratorComObject() as IMMDeviceEnumerator; IMMDevice d; e.GetDefaultAudioEndpoint(0, 1, out d);
    var id = typeof(IAudioEndpointVolume).GUID; IAudioEndpointVolume v; d.Activate(ref id, 23, 0, out v); return v; }
  public static string Get() { var v = Endpoint(); float l; bool m; v.GetMasterVolumeLevelScalar(out l); v.GetMute(out m); return l.ToString(System.Globalization.CultureInfo.InvariantCulture) + ";" + (m ? "1" : "0"); }
  public static void Set(float level, bool mute) { var v = Endpoint(); v.SetMasterVolumeLevelScalar(level, Guid.Empty); v.SetMute(mute, Guid.Empty); }
}
'@
`;

export const readScript = `${HEAD}[TessayaVolume]::Get()`;
export const setScript = (level: number, mute: boolean): string =>
  `${HEAD}[TessayaVolume]::Set(${Math.max(0, Math.min(1, level)).toFixed(3)}, $${mute ? "true" : "false"})`;

export const parseVolume = (out: string): { level: number; muted: boolean } | null => {
  const m = /^\s*([01](?:\.\d+)?);([01])\s*$/.exec(out);
  return m === null ? null : { level: Number(m[1]), muted: m[2] === "1" };
};

const powershell = (script: string): Promise<string> =>
  new Promise((resolve, reject) =>
    NodeChildProcess.execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: 8_000, windowsHide: true },
      (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
    ),
  );

export const createVolumeDuck = (input: {
  readonly file: string;
  readonly platform: string;
  readonly run?: (script: string) => Promise<string>;
}) => {
  const run = input.run ?? powershell;
  const supported = input.platform === "win32";
  let saved: { level: number; muted: boolean } | null = null;
  const forget = () => NodeFS.rmSync(input.file, { force: true });

  const put = async (level: number, muted: boolean): Promise<void> => {
    await run(setScript(level, muted));
  };
  const restore = async (): Promise<void> => {
    if (saved === null) return;
    const was = saved;
    saved = null;
    try {
      await put(was.level, was.muted);
    } finally {
      forget();
    }
  };

  return {
    supported,
    /** Lowers the volume for the time he is speaking; a second call while ducked changes nothing. */
    start: async (mode: DuckMode): Promise<boolean> => {
      if (!supported || mode === "off" || saved !== null) return false;
      try {
        const now = parseVolume(await run(readScript));
        if (now === null) return false;
        saved = now;
        NodeFS.mkdirSync(NodePath.dirname(input.file), { recursive: true });
        NodeFS.writeFileSync(input.file, JSON.stringify(now));
        await put(mode === "mute" ? now.level : Math.min(now.level, DUCK_LEVEL), mode === "mute");
        return true;
      } catch {
        await restore().catch(() => undefined);
        return false;
      }
    },
    stop: async (): Promise<void> => {
      try {
        await restore();
      } catch {
        // The saved file stays, so the next start tries again.
      }
    },
    /** After a crash while ducked: put back what the file says. */
    recover: async (): Promise<boolean> => {
      if (!supported || !NodeFS.existsSync(input.file)) return false;
      try {
        const was = JSON.parse(NodeFS.readFileSync(input.file, "utf8")) as {
          level?: number;
          muted?: boolean;
        };
        if (typeof was.level !== "number") return (forget(), false);
        await put(was.level, was.muted === true);
        forget();
        return true;
      } catch {
        return false;
      }
    },
  };
};

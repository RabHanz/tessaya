/**
 * Starts a program safely on any system. On Windows an npm program is a .cmd shim: its node script is run
 * directly with the argument list, so a task description is never read by cmd.
 */
export interface LaunchEnv {
  readonly platform: string;
  readonly path: string;
  readonly pathext: string;
  readonly exists: (file: string) => boolean;
  readonly read: (file: string) => string | null;
}

export type LaunchPlan =
  | {
      readonly ok: true;
      readonly file: string;
      readonly args: ReadonlyArray<string>;
      readonly viaCmd: boolean;
    }
  | { readonly ok: false; readonly error: string };

const PLAIN = /^[A-Za-z0-9 ._:\\/=@,+-]*$/;
const sep = (platform: string) => (platform === "win32" ? "\\" : "/");

const join = (platform: string, dir: string, name: string): string =>
  dir.endsWith(sep(platform)) || dir.endsWith("/")
    ? `${dir}${name}`
    : `${dir}${sep(platform)}${name}`;

/** The first program on the path with that name (and, on Windows, one of the allowed endings). */
export const findProgram = (name: string, env: LaunchEnv): string | null => {
  if (/[\\/]/.test(name)) return env.exists(name) ? name : null;
  const dirs = env.path.split(env.platform === "win32" ? ";" : ":").filter(Boolean);
  const endings =
    env.platform === "win32"
      ? [
          "",
          ...env.pathext
            .split(";")
            .filter(Boolean)
            .map((e) => e.toLowerCase()),
        ]
      : [""];
  for (const dir of dirs) {
    for (const ending of endings) {
      const full = join(env.platform, dir.replace(/^"|"$/g, ""), `${name}${ending}`);
      if (env.exists(full)) return full;
    }
  }
  return null;
};

/** The script an npm `.cmd` shim runs: the `%dp0%\...js` path in its last line, made absolute. */
export const scriptOfNpmShim = (shimPath: string, text: string): string | null => {
  const m =
    /"%dp0%\\([^"\r\n]+?\.(?:c?js|mjs))"/i.exec(text) ??
    /"%~dp0\\([^"\r\n]+?\.(?:c?js|mjs))"/i.exec(text);
  if (m === null) return null;
  const dir = shimPath.slice(0, Math.max(shimPath.lastIndexOf("\\"), shimPath.lastIndexOf("/")));
  return `${dir}\\${m[1]}`;
};

export const launchPlan = (
  name: string,
  args: ReadonlyArray<string>,
  env: LaunchEnv,
): LaunchPlan => {
  if (env.platform !== "win32") return { ok: true, file: name, args, viaCmd: false };
  const found = findProgram(name, env);
  if (found === null) return { ok: false, error: `${name} is not installed on this computer.` };
  if (/\.(exe|com)$/i.test(found)) return { ok: true, file: found, args, viaCmd: false };
  if (/\.(cmd|bat)$/i.test(found)) {
    const text = env.read(found);
    const script = text === null ? null : scriptOfNpmShim(found, text);
    if (script !== null && env.exists(script)) {
      const node = findProgram("node", env);
      if (node !== null) return { ok: true, file: node, args: [script, ...args], viaCmd: false };
    }
    // Last resort: cmd.exe, only when nothing in the arguments could be read as a command.
    if (args.every((a) => PLAIN.test(a) && !/[\r\n]/.test(a)))
      return { ok: true, file: found, args, viaCmd: true };
    return {
      ok: false,
      error: `${name} on this computer can only be started through cmd, which is not safe for a task description. Install its native version, or run it on another computer.`,
    };
  }
  return { ok: true, file: found, args, viaCmd: false };
};

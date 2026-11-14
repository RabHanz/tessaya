/* oxlint-disable t3code/no-global-process-runtime -- Baton file predating the rule (D82) */
// @effect-diagnostics nodeBuiltinImport:off
/**
 * "Start Tessaya when I sign in" is the registry's Run entry, which the installer and the switch both write
 * under the app's id (its AppUserModelId, passed in), so the switch reads that entry, not a copy of it in the settings file. Electron can
 * only read the entry under its own default name, so the one under the app's id is read from the registry.
 */
import * as NodeChildProcess from "node:child_process";

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";

interface LoginApi {
  readonly getLoginItemSettings: () => { readonly openAtLogin: boolean };
  readonly setLoginItemSettings: (settings: {
    readonly openAtLogin: boolean;
    readonly name?: string;
  }) => void;
}

/** Whether the Run entry `name` exists. Windows only; elsewhere there is none. Never on the main thread's clock. */
export const runEntryExists = (name: string): Promise<boolean> =>
  process.platform !== "win32"
    ? Promise.resolve(false)
    : new Promise((resolve) => {
        NodeChildProcess.execFile("reg", ["query", RUN_KEY, "/v", name], (error) =>
          resolve(error === null),
        );
      });

/** On when the Run entry exists under the app's id or under Electron's default name. */
export const loginItemOn = async (
  api: LoginApi,
  entry: string,
  exists: (name: string) => Promise<boolean> = runEntryExists,
): Promise<boolean> => {
  try {
    return (await exists(entry)) || api.getLoginItemSettings().openAtLogin;
  } catch {
    return false;
  }
};

/**
 * The switch as Home shows it: read from the registry once at start and after each change, never while
 * Home's state is built (a `reg query` there blocked the main thread on every build, 0.1.66).
 */
export const createLoginItemState = (
  api: LoginApi,
  entry: string,
  exists: (name: string) => Promise<boolean> = runEntryExists,
) => {
  let on = false;
  const refresh = async () => {
    on = await loginItemOn(api, entry, exists);
    return on;
  };
  return {
    on: () => on,
    refresh,
    set: (next: boolean) => {
      setLoginItem(api, entry, next);
      on = next;
      void refresh();
    },
  };
};

/** One entry, under the app's id, for the current exe; the default-named one is cleared so there is never two. */
export const setLoginItem = (api: LoginApi, entry: string, on: boolean): void => {
  api.setLoginItemSettings({ openAtLogin: false });
  api.setLoginItemSettings({ openAtLogin: on, name: entry });
};

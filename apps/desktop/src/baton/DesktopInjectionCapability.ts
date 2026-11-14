/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * What this desktop can honestly type into — §18, answered from the machine
 * rather than from hope.
 *
 * The specification is blunt about Linux: *Wayland may restrict global
 * injection. Prefer application-specific integrations and supported
 * desktop/accessibility/portal mechanisms; never pretend arbitrary global
 * injection is universally available.* This module is where that promise is
 * kept or broken, so it reads the session's own facts — platform, display
 * server, granted permissions, connected integrations — and hands the shared
 * report builder something true.
 *
 * Deliberately a pure function of an environment snapshot, not a reader of
 * `process` at call time: the interesting cases are other people's machines,
 * and the only way to test them here is to be handed their facts.
 */
import type { BatonInjectionReport } from "@t3tools/tessaya-contracts";
import {
  describeInjectionCapabilities,
  type InjectionHostFacts,
} from "@t3tools/tessaya-shared/injection";

export interface DesktopHostEnvironment {
  /** `process.platform`. */
  readonly platform: string;
  /** `process.env`, or the parts of it that matter. */
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * macOS Accessibility / Windows UI Automation, as the OS reports it. The
   * desktop app already asks for this permission for its own screenshot
   * feature, so the answer is known rather than assumed.
   */
  readonly accessibilityPermissionGranted: boolean;
  /** A browser extension, a VS Code window, or Baton's own field is connected. */
  readonly applicationIntegrationConnected: boolean;
  /** Off unless the user turned it on, because §18 puts it last for a reason. */
  readonly keystrokeSimulationAllowed: boolean;
}

const asPlatform = (platform: string): InjectionHostFacts["platform"] => {
  if (platform === "darwin" || platform === "win32" || platform === "linux") return platform;
  return "unknown";
};

/**
 * Which display server a Linux session is running under.
 *
 * `XDG_SESSION_TYPE` is the direct answer when the session manager sets it;
 * `WAYLAND_DISPLAY` is the fallback, because a session started outside a login
 * manager often has the socket and not the variable. Neither present and an
 * X display present means X11. Anything else is `unknown`, which the report
 * treats as "cannot inject" — the honest reading, since a compositor nobody
 * can identify is not one to send synthetic keys to.
 */
export const detectDisplayServer = (
  env: Readonly<Record<string, string | undefined>>,
): "wayland" | "x11" | "unknown" => {
  const declared = env["XDG_SESSION_TYPE"]?.trim().toLowerCase();
  if (declared === "wayland") return "wayland";
  if (declared === "x11") return "x11";
  if ((env["WAYLAND_DISPLAY"] ?? "").trim().length > 0) return "wayland";
  if ((env["DISPLAY"] ?? "").trim().length > 0) return "x11";
  return "unknown";
};

export const desktopInjectionReport = (
  environment: DesktopHostEnvironment,
): BatonInjectionReport => {
  const platform = asPlatform(environment.platform);
  return describeInjectionCapabilities({
    platform,
    displayServer: platform === "linux" ? detectDisplayServer(environment.env) : null,
    applicationIntegrationConnected: environment.applicationIntegrationConnected,
    accessibilityPermissionGranted: environment.accessibilityPermissionGranted,
    // Electron's own clipboard is always there; it is the *paste* that needs a
    // focused field, and that is the target's problem rather than the host's.
    clipboardAvailable: true,
    keystrokeSimulationAllowed: environment.keystrokeSimulationAllowed,
  });
};

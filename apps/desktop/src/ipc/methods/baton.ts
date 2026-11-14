/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * Baton's desktop-side answers.
 *
 * Only one today, and it is the one §18 insists on: **what can this machine
 * actually type into?** The renderer cannot work that out for itself — the
 * display server, the OS accessibility grant and the platform all live in the
 * main process — and guessing produces dictation that silently goes nowhere.
 *
 * The renderer supplies the half it knows: whether an application integration
 * (its own focused field, a connected VS Code or browser extension) is
 * available right now. The main process supplies the half the OS knows. Neither
 * half is invented.
 */
import { BatonInjectionReport } from "@t3tools/tessaya-contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Electron from "electron";

import * as DesktopEnvironment from "../../app/DesktopEnvironment.ts";
import { desktopInjectionReport } from "../../baton/DesktopInjectionCapability.ts";
import * as IpcChannels from "../../baton/channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const BatonInjectionReportRequest = Schema.Struct({
  /** True when the renderer has somewhere of its own to put text. */
  applicationIntegrationConnected: Schema.Boolean,
  /**
   * Simulated keystrokes, which §18 ranks last and which stay off unless the
   * user has explicitly turned them on. Passed in rather than read here so the
   * setting lives with the rest of the client's settings.
   */
  keystrokeSimulationAllowed: Schema.Boolean,
});

export const getBatonInjectionReport = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.BATON_INJECTION_REPORT_CHANNEL,
  payload: BatonInjectionReportRequest,
  result: BatonInjectionReport,
  handler: Effect.fn("desktop.ipc.baton.getInjectionReport")(function* (request) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    // The same call the screenshot feature uses to ask macOS whether it is
    // trusted. `false` means "do not prompt" — a capability report must not
    // pop a permission dialog just because something asked what is possible.
    const accessibilityPermissionGranted =
      environment.platform === "darwin"
        ? Electron.systemPreferences.isTrustedAccessibilityClient(false)
        : false;
    return desktopInjectionReport({
      platform: environment.platform,
      env: process.env,
      accessibilityPermissionGranted,
      applicationIntegrationConnected: request.applicationIntegrationConnected,
      keystrokeSimulationAllowed: request.keystrokeSimulationAllowed,
    });
  }),
});

/* oxlint-disable t3code/no-em-dash-copy, t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * §18's text injection: the abstraction, the preference order, and — the part
 * that matters most — telling the truth about what this machine can do.
 *
 * The specification's own words: *never pretend arbitrary global injection is
 * universally available*, and *surface capability must be reported honestly in
 * the UI*. Those two sentences are the whole design. Dictation that silently
 * does nothing is worse than dictation that refuses, because the user finds out
 * by discovering their sentence went nowhere, usually after saying something
 * they would rather not repeat.
 *
 * So the capability report is computed from facts about the host — platform,
 * display server, which integrations are connected, which permissions were
 * granted — and every unavailable method carries a reason a person can act on.
 *
 * @module batonInjection
 */
import {
  BATON_INJECTION_PREFERENCE,
  type TessayaFocusTarget,
  type TessayaInjectionCapability,
  type TessayaInjectionMethod,
  type TessayaInjectionReport,
  type TessayaPlatform,
} from "@t3tools/tessaya-contracts";

/** §18's interface, verbatim in intent: what any host must implement. */
export interface TextInjectionAdapter {
  readonly method: TessayaInjectionMethod;
  /** Can this adapter put text into that target, right now? */
  readonly canInject: (target: TessayaFocusTarget) => boolean;
  readonly insertText: (input: {
    readonly target: TessayaFocusTarget;
    readonly text: string;
  }) => Promise<void>;
  /** Optional: replace what is selected rather than inserting at the caret. */
  readonly replaceSelection?: (input: {
    readonly target: TessayaFocusTarget;
    readonly text: string;
  }) => Promise<void>;
}

/**
 * The adapter §18 would have you use: the most preferred one that can actually
 * do it, not the first one that exists.
 */
export const chooseInjectionAdapter = (
  adapters: ReadonlyArray<TextInjectionAdapter>,
  target: TessayaFocusTarget,
): TextInjectionAdapter | null => {
  for (const method of BATON_INJECTION_PREFERENCE) {
    const adapter = adapters.find(
      (candidate) => candidate.method === method && candidate.canInject(target),
    );
    if (adapter !== undefined) return adapter;
  }
  return null;
};

export interface InjectionHostFacts {
  readonly platform: TessayaPlatform;
  /** Linux only; null elsewhere. */
  readonly displayServer: "wayland" | "x11" | "unknown" | null;
  /** A host integration — browser extension, VS Code, the client itself — is connected. */
  readonly applicationIntegrationConnected: boolean;
  /** macOS Accessibility, Windows UI Automation: granted, or not asked. */
  readonly accessibilityPermissionGranted: boolean;
  /** Whether this host may use the clipboard as a fallback at all. */
  readonly clipboardAvailable: boolean;
  /** Simulated keystrokes. Off unless the user has explicitly allowed it. */
  readonly keystrokeSimulationAllowed: boolean;
}

/**
 * What this machine can honestly do, per method, with a reason for each no.
 *
 * The Linux case is the one the specification calls out and the one this
 * repository runs on: under Wayland a process cannot type into another
 * application's window, and no amount of wanting it to changes that. The
 * report says so by name rather than offering a method that will fail.
 */
export const describeInjectionCapabilities = (
  facts: InjectionHostFacts,
): TessayaInjectionReport => {
  const capabilities: TessayaInjectionCapability[] = [
    {
      method: "application",
      available: facts.applicationIntegrationConnected,
      reason: facts.applicationIntegrationConnected
        ? ""
        : "no application integration is connected — open the field in Tessaya, VS Code or a browser with the extension.",
    },
    {
      method: "accessibility",
      available: accessibilityAvailable(facts),
      reason: accessibilityReason(facts),
    },
    {
      method: "clipboard",
      available: facts.clipboardAvailable,
      reason: facts.clipboardAvailable ? "" : "this host has no clipboard access.",
    },
    {
      method: "keystrokes",
      available: facts.keystrokeSimulationAllowed && keystrokesPossible(facts),
      reason: keystrokeReason(facts),
    },
  ];
  return {
    platform: facts.platform,
    displayServer: facts.displayServer,
    capabilities,
  };
};

const accessibilityAvailable = (facts: InjectionHostFacts): boolean => {
  if (facts.platform === "linux") {
    // Wayland's whole point is that one client cannot drive another. Offering
    // an accessibility injector here would be a promise the compositor breaks.
    return facts.displayServer === "x11" && facts.accessibilityPermissionGranted;
  }
  if (facts.platform === "unknown") return false;
  return facts.accessibilityPermissionGranted;
};

const accessibilityReason = (facts: InjectionHostFacts): string => {
  if (accessibilityAvailable(facts)) return "";
  if (facts.platform === "linux" && facts.displayServer === "wayland") {
    return "Wayland does not let one application type into another. Use the browser or VS Code integration instead.";
  }
  if (facts.platform === "linux" && facts.displayServer !== "x11") {
    return "this Linux session does not report a display server that allows injection.";
  }
  if (facts.platform === "darwin") {
    return "macOS Accessibility permission has not been granted to Tessaya.";
  }
  if (facts.platform === "win32") {
    return "UI Automation is not available to this process.";
  }
  return "this platform does not expose an accessibility injector.";
};

const keystrokesPossible = (facts: InjectionHostFacts): boolean =>
  !(facts.platform === "linux" && facts.displayServer === "wayland");

const keystrokeReason = (facts: InjectionHostFacts): string => {
  if (facts.keystrokeSimulationAllowed && keystrokesPossible(facts)) return "";
  if (!keystrokesPossible(facts)) {
    return "Wayland does not allow synthetic input from another process.";
  }
  // §18 puts this last for a reason: simulated keys go wherever focus happens
  // to be when they land, which on a slow machine is not where it was.
  return "simulated keystrokes are off; turn them on only if nothing else works.";
};

/**
 * The refusal a user hears when dictation has nowhere to go.
 *
 * It names the method that would have been used and why it is not available,
 * because "I cannot do that" is the answer that makes people repeat themselves.
 */
export const describeInjectionRefusal = (report: TessayaInjectionReport): string => {
  const blocked = report.capabilities.find((capability) => capability.reason.length > 0);
  return blocked === undefined
    ? "There is nowhere to put that text."
    : `I cannot type that in: ${blocked.reason}`;
};

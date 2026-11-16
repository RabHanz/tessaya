// Tessaya's own phone app (APP_VARIANT=tessaya): its own identity, Expo project and Apple team,
// so it installs beside T3 Code and takes updates only from Tessaya's channel.

const fromRepoRoot = (relativePath: string) => `../../${relativePath}`;
// Opaque and square: App Store Connect rejects an icon with an alpha channel.
const icon = fromRepoRoot("assets/baton/tessaya-ios-1024.png");
// The bundle ID is the maintainer's own, so it comes from the shell or the EAS project's
// environment variables, not the repository. Read at import, before the repo .env is applied.
const UNSET_BUNDLE_ID = "com.example.tessaya";
const bundleIdentifier = process.env.TESSAYA_IOS_BUNDLE_ID?.trim() || UNSET_BUNDLE_ID;

export const TESSAYA_VARIANT = {
  appName: "Tessaya",
  scheme: "tessaya",
  iosBundleIdentifier: bundleIdentifier,
  androidPackage: bundleIdentifier,
  relyingParty: "clerk.t3.codes",
  assets: {
    appIcon: icon,
    iosIcon: icon,
    splashIcon: icon,
    androidAdaptiveForeground: "./assets/tessaya-android-icon-foreground.png",
    androidAdaptiveBackgroundColor: "#14505A",
    androidAdaptiveBackgroundImage: undefined,
    androidSplashIcon: "./assets/tessaya-android-splash-icon.png",
    androidMonochromeIcon: "./assets/tessaya-android-icon-mark.png",
    androidNotificationIcon: "./assets/tessaya-android-notification-icon.png",
    androidNotificationColor: "#14505A",
    // The icon's own teal, so launch is one unbroken tile in light and dark.
    splashBackgroundColor: "#14505A",
  },
} as const;

export function tessayaEas() {
  if (bundleIdentifier === UNSET_BUNDLE_ID) {
    throw new Error(
      "APP_VARIANT=tessaya needs TESSAYA_IOS_BUNDLE_ID in the shell or EAS environment.",
    );
  }
  return TESSAYA_EAS;
}

const TESSAYA_EAS = {
  owner: "rabhanz",
  slug: "tessaya",
  projectId: "dba25d42-105c-4f99-9157-643bc3cffc4f",
  appleTeamId: "W6HK93B4Q5",
} as const;

/** Permission prompts, widget names and other native strings say Tessaya, never T3 Code. */
export function tessayaRebrand<T>(value: T): T {
  if (typeof value === "string") return value.replace(/\bT3 Code\b/g, "Tessaya") as T;
  if (Array.isArray(value)) return value.map(tessayaRebrand) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, tessayaRebrand(entry)]),
    ) as T;
  }
  return value;
}

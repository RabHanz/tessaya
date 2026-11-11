import { DEFAULT_HOSTED_APP_URL } from "@t3tools/shared/connectAuth";
import { afterEach, expect, it, vi } from "vite-plus/test";

import appleAppSiteAssociation from "../web/public/.well-known/apple-app-site-association.json";
import assetLinks from "../web/public/.well-known/assetlinks.json";

// Keep config parsing independent of local env files and build credentials.
vi.mock("../../scripts/lib/public-config.ts", () => ({
  loadRepoEnv: () => ({ APP_VARIANT: process.env.APP_VARIANT }),
}));

afterEach(() => {
  vi.unstubAllEnvs();
});

async function loadConfig(variant: string | undefined) {
  vi.resetModules();
  vi.stubEnv("APP_VARIANT", variant);
  return (await import("./app.config.ts")).default;
}

it.each(["prod", ""])("rejects APP_VARIANT=%j before selecting production IDs", async (value) => {
  await expect(loadConfig(value)).rejects.toThrow(
    "APP_VARIANT must be development, preview, production, or tessaya.",
  );
});

it.each([
  [undefined, "com.t3tools.t3code"],
  ["development", "com.t3tools.t3code.dev"],
  ["preview", "com.t3tools.t3code.preview"],
  ["production", "com.t3tools.t3code"],
])("keeps the iOS and Android identifiers for APP_VARIANT=%j", async (value, identifier) => {
  const config = await loadConfig(value);
  expect(config.ios?.bundleIdentifier).toBe(identifier);
  expect(config.android?.package).toBe(identifier);
  // Copied thread links open this app only while app.t3.codes lists it.
  const host = new URL(DEFAULT_HOSTED_APP_URL).host;
  expect(config.ios?.associatedDomains).toContain(`applinks:${host}`);
  expect(appleAppSiteAssociation.applinks.details[0]?.appIDs).toContain(
    `${config.ios?.appleTeamId}.${identifier}`,
  );
  expect(config.android?.intentFilters?.[0]?.data).toEqual([
    { scheme: "https", host, pathPrefix: "/threads/" },
  ]);
  expect(assetLinks.map((link) => link.target.package_name)).toContain(identifier);
});

it("gives the tessaya variant its own identity, Expo project and Apple team", async () => {
  const production = await loadConfig("production");
  await expect(loadConfig("tessaya")).rejects.toThrow("TESSAYA_IOS_BUNDLE_ID");
  vi.stubEnv("TESSAYA_IOS_BUNDLE_ID", "com.example.mine");
  const tessaya = await loadConfig("tessaya");
  expect(production.extra?.eas?.projectId).toBe("d763fcb8-d37c-41ea-a773-b54a0ab4a454");
  expect(tessaya.ios?.bundleIdentifier).toBe("com.example.mine");
  expect(tessaya.ios?.appleTeamId).toBe("W6HK93B4Q5");
  expect(tessaya.owner).toBe("rabhanz");
  expect(tessaya.updates?.url).toBe(`https://u.expo.dev/${tessaya.extra?.eas?.projectId}`);
  expect(tessaya.updates?.url).not.toBe(production.updates?.url);
});

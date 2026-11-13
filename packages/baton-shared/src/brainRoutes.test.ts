import { describe, expect, it } from "vite-plus/test";

import { brainRoute, keyRefusal, type BrainSettings } from "./brainRoutes.ts";

const settings = (over: Partial<BrainSettings> = {}): BrainSettings => ({
  brainCredentials: {},
  brainModels: {},
  brainKeyRoles: {},
  roomBrain: "auto",
  dictationCleanup: { model: null },
  ...over,
});

describe("brain routes", () => {
  it("an empty table reproduces what the settings before it chose", () => {
    const voice = brainRoute(settings(), "voice", "haiku");
    expect(voice.use).toEqual("apiKey:anthropic");
    expect(voice.fallback).toEqual("subscription");
    expect(voice.model).toBe("claude-haiku-5-5");
    expect(brainRoute(settings({ roomBrain: "api" }), "voice", "haiku").fallback).toBeNull();
    expect(brainRoute(settings({ roomBrain: "subscription" }), "voice", "haiku").use).toEqual(
      "subscription",
    );
    expect(brainRoute(settings(), "background", "sonnet").model).toBe("sonnet");
    expect(brainRoute(settings(), "cleanup", "haiku").model).toBe("claude-haiku-5-5");
    expect(
      brainRoute(
        settings({
          dictationCleanup: {
            model: { instanceId: "claudeAgent" as never, model: "claude-sonnet-5-5" },
          },
        }),
        "cleanup",
        "haiku",
      ).model,
    ).toBe("claude-sonnet-5-5");
  });

  it("his row wins, and a row without a fallback never falls back", () => {
    const route = brainRoute(
      settings({
        brainCredentials: { voice: { use: "subscription:work" } },
        brainModels: { voice: { model: "sonnet", effort: "low" } },
      }),
      "voice",
      "haiku",
    );
    expect(route).toEqual({
      role: "voice",
      use: "subscription:work",
      fallback: null,
      model: "sonnet",
      effort: "low",
    });
  });

  it("refuses an API call for a role the key does not serve, and allows the ones it does", () => {
    expect(keyRefusal(settings(), "anthropic", "cleanup")).toBeNull();
    expect(keyRefusal(settings(), "anthropic", "voice")).toBeNull();
    expect(keyRefusal(settings(), "anthropic", "deep")).toMatch(/deep is not allowed/);
    // The subscription carried the room before the table, so the key never served it.
    expect(keyRefusal(settings({ roomBrain: "subscription" }), "anthropic", "voice")).toMatch(
      /voice is not allowed/,
    );
    // His list replaces the old one outright: cleanup only.
    const cleanupOnly = settings({ brainKeyRoles: { anthropic: ["cleanup"] } });
    expect(keyRefusal(cleanupOnly, "anthropic", "voice")).toMatch(/serves: cleanup/);
    expect(
      keyRefusal(settings({ brainKeyRoles: { anthropic: [] } }), "anthropic", "cleanup"),
    ).toMatch(/serves: nothing/);
  });
});

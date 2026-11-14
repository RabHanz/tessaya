import { BrainCredential } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { brainRoute, credentialOf, keyRefusal, type BrainSettings } from "./brainRoutes.ts";

const settings = (over: Partial<BrainSettings> = {}): BrainSettings => ({
  brainCredentials: {},
  brainModels: {},
  brainKeyRoles: {},
  dictationCleanup: { model: null },
  ...over,
});

describe("brain routes", () => {
  it("an empty table: his 13 Nov choices for voice and the key, and what each other role used before", () => {
    expect(brainRoute(settings(), "voice", "haiku")).toEqual({
      role: "voice",
      use: "subscription",
      fallback: null,
      model: "sonnet",
      effort: "low",
    });
    expect(brainRoute(settings(), "background", "sonnet").model).toBe("sonnet");
    expect(brainRoute(settings(), "cleanup", "haiku")).toMatchObject({
      use: "apiKey:anthropic",
      model: "claude-haiku-5-5",
    });
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

  it("his row wins, and falls back only to what it names", () => {
    const route = (row: NonNullable<BrainSettings["brainCredentials"]["voice"]>) =>
      brainRoute(
        settings({
          brainCredentials: { voice: row },
          brainModels: { voice: { model: "claude-haiku-5-5" } },
        }),
        "voice",
        "haiku",
      );
    expect(route({ use: "subscription:work" })).toEqual({
      role: "voice",
      use: "subscription:work",
      fallback: null,
      model: "claude-haiku-5-5",
      effort: null,
    });
    expect(route({ use: "apiKey:anthropic", fallback: "subscription" }).fallback).toBe(
      "subscription",
    );
    // A patch merges rows, so taking a fallback away is said outright.
    expect(route({ use: "apiKey:anthropic", fallback: "none" }).fallback).toBeNull();
  });

  it("refuses an API call for a role the key does not serve, and allows the ones it does", () => {
    expect(keyRefusal(settings(), "anthropic", "cleanup")).toBeNull();
    // His 13 Nov choice: the key pays for cleanup only.
    expect(keyRefusal(settings(), "anthropic", "voice")).toMatch(/voice is not allowed/);
    expect(keyRefusal(settings(), "anthropic", "deep")).toMatch(/serves: cleanup/);
    const withVoice = settings({ brainKeyRoles: { anthropic: ["cleanup", "voice"] } });
    expect(keyRefusal(withVoice, "anthropic", "voice")).toBeNull();
    expect(
      keyRefusal(settings({ brainKeyRoles: { anthropic: [] } }), "anthropic", "cleanup"),
    ).toMatch(/serves: nothing/);
    // A key he has not given roles serves nothing, so naming it on a row never spends it.
    expect(keyRefusal(settings(), "openai", "background")).toMatch(/serves: nothing/);
    expect(
      keyRefusal(settings({ brainKeyRoles: { openai: ["background"] } }), "openai", "background"),
    ).toBeNull();
  });

  it("reads any provider's instance or key, and nothing it can't name", () => {
    const valid = Schema.is(BrainCredential);
    expect(
      ["instance:codex", "apiKey:openai", "apiKey:google", "subscription:work"].every(valid),
    ).toBe(true);
    expect(["apiKey:mistral", "instance:", "instance:-x", "subscription:"].some(valid)).toBe(false);
    expect(credentialOf("instance:codex")).toEqual({ kind: "instance", instanceId: "codex" });
    expect(credentialOf("apiKey:openai")).toEqual({ kind: "apiKey", key: "openai" });
  });
});

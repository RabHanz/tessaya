import { ProviderInstanceId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";

import { makeClaudeSessionLogin, pruneClaudeSessionLogins } from "./ClaudeSessionLogin.ts";

it.layer(NodeServices.layer)("ClaudeSessionLogin", (it) => {
  it.effect("prunes a week-old session dir but never the home or a dir holding real files", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-home-" });
      const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-claude-logins-" });
      yield* fileSystem.makeDirectory(path.join(home, "projects"));
      yield* fileSystem.writeFileString(path.join(home, "projects", "kept.jsonl"), "{}");
      yield* fileSystem.writeFileString(path.join(home, ".credentials.json"), "{}");
      const make = (providerSessionId: string) =>
        makeClaudeSessionLogin({
          root,
          providerSessionId,
          environment: { CLAUDE_CONFIG_DIR: home, CLAUDE_CODE_OAUTH_TOKEN: "token-a" },
          homeDirectory: home,
          onUsageLimits: undefined,
        });
      const login = make("provider-session:a/b");
      const written = make("provider-session:written");
      if (login === null || written === null) return assert.fail("a token login has a dir");
      const env = yield* login.prepare({ CLAUDE_CODE_OAUTH_TOKEN: "token-a", KEEP: "1" });
      assert.deepEqual(env, { KEEP: "1", CLAUDE_CONFIG_DIR: login.dir });
      yield* login.switchTo({
        instanceId: ProviderInstanceId.make("claudeAgent_b"),
        secret: Redacted.make("token-b"),
      });
      const credential = JSON.parse(
        yield* fileSystem.readFileString(path.join(login.dir, ".credentials.json")),
      ) as { readonly claudeAiOauth: { readonly accessToken: string } };
      assert.equal(credential.claudeAiOauth.accessToken, "token-b");
      // A process wrote here after its links went: the dir is kept.
      yield* written.prepare({});
      yield* fileSystem.writeFileString(path.join(written.dir, "late.jsonl"), "{}");

      const mtime = (yield* fileSystem.stat(path.join(login.dir, ".credentials.json"))).mtime;
      const writtenAt = Option.getOrThrow(mtime).getTime();
      yield* TestClock.setTime(writtenAt + 60_000);
      yield* pruneClaudeSessionLogins(root);
      assert.isTrue(yield* fileSystem.exists(login.dir));
      yield* TestClock.setTime(writtenAt + 8 * 86_400_000);
      yield* pruneClaudeSessionLogins(root);
      assert.isFalse(yield* fileSystem.exists(login.dir));
      assert.isTrue(yield* fileSystem.exists(path.join(written.dir, "late.jsonl")));
      assert.equal(
        yield* fileSystem.readFileString(path.join(home, "projects", "kept.jsonl")),
        "{}",
      );
      assert.equal(yield* fileSystem.readFileString(path.join(home, ".credentials.json")), "{}");
    }),
  );

  it("is off for a login that is not a token", () => {
    assert.isNull(
      makeClaudeSessionLogin({
        root: "/unused",
        providerSessionId: "provider-session:c",
        environment: {},
        homeDirectory: "/unused",
        onUsageLimits: undefined,
      }),
    );
  });
});

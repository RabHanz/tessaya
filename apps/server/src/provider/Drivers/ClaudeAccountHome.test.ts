/**
 * A second Claude account gets its own credentials and everybody else's
 * configuration — proven on a real filesystem, because the whole mechanism is
 * filesystem behaviour.
 */
// @effect-diagnostics nodeBuiltinImport:off - the assertions are about links on disk, which the FileSystem service does not expose.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  materializeClaudeAccountHome,
  resolveClaudeAccountHomeLayout,
  type ClaudeAccountHomeLayout,
} from "./ClaudeAccountHome.ts";

const makeRoot = (): string =>
  NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "claude-account-home-"));

const layoutFor = (root: string): ClaudeAccountHomeLayout => ({
  mode: "accountOverlay",
  sharedHomePath: NodePath.join(root, "primary"),
  accountHomePath: NodePath.join(root, "account-b"),
});

const givenPrimary = (root: string): void => {
  const primary = NodePath.join(root, "primary");
  NodeFS.mkdirSync(NodePath.join(primary, "skills", "copy-check"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(primary, "skills", "copy-check", "SKILL.md"),
    "# copy check\n",
  );
  NodeFS.mkdirSync(NodePath.join(primary, "agents"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(primary, "settings.json"), '{"cleanupPeriodDays":30}\n');
  NodeFS.writeFileSync(NodePath.join(primary, "CLAUDE.md"), "# the operating instructions\n");
  NodeFS.writeFileSync(NodePath.join(primary, ".credentials.json"), '{"primary":true}\n');
};

const run = <A, E>(effect: Effect.Effect<A, E, NodeServices.NodeServices>) =>
  effect.pipe(Effect.provide(NodeServices.layer), Effect.scoped);

it.effect("links the configuration and leaves the credentials alone", () =>
  Effect.gen(function* () {
    const root = makeRoot();
    givenPrimary(root);
    const layout = layoutFor(root);

    yield* materializeClaudeAccountHome(layout);

    const account = NodePath.join(root, "account-b");
    for (const entry of ["settings.json", "CLAUDE.md", "skills", "agents", "plugins", "projects"]) {
      const linkPath = NodePath.join(account, entry);
      assert.equal(
        NodeFS.lstatSync(linkPath).isSymbolicLink(),
        true,
        `${entry} should be a link to the shared configuration`,
      );
      assert.equal(NodeFS.readlinkSync(linkPath), NodePath.join(root, "primary", entry));
    }

    // The point of the whole thing: the second account reads the first's
    // skills and instructions, through the link, without a copy.
    assert.equal(
      NodeFS.readFileSync(NodePath.join(account, "skills", "copy-check", "SKILL.md"), "utf8"),
      "# copy check\n",
    );
    assert.equal(
      NodeFS.readFileSync(NodePath.join(account, "CLAUDE.md"), "utf8"),
      "# the operating instructions\n",
    );

    // And the credentials are not linked at all — the account has none yet,
    // which is exactly what `claude auth login` is for.
    assert.equal(NodeFS.existsSync(NodePath.join(account, ".credentials.json")), false);
  }).pipe(run),
);

it.effect("creates a shared directory the primary does not have yet", () =>
  Effect.gen(function* () {
    const root = makeRoot();
    NodeFS.mkdirSync(NodePath.join(root, "primary"), { recursive: true });

    yield* materializeClaudeAccountHome(layoutFor(root));

    // A link to a directory that does not exist is not configuration sharing,
    // it is a broken link. The shared side is created first so both accounts
    // write into one place from the beginning.
    const target = NodePath.join(root, "primary", "skills");
    assert.equal(NodeFS.statSync(target).isDirectory(), true);
    assert.equal(
      NodeFS.lstatSync(NodePath.join(root, "account-b", "skills")).isSymbolicLink(),
      true,
    );
  }).pipe(run),
);

it.effect("runs again without changing anything, because it runs before every session", () =>
  Effect.gen(function* () {
    const root = makeRoot();
    givenPrimary(root);
    const layout = layoutFor(root);

    yield* materializeClaudeAccountHome(layout);
    NodeFS.writeFileSync(NodePath.join(root, "account-b", ".credentials.json"), '{"b":true}\n');
    yield* materializeClaudeAccountHome(layout);

    // Re-materialising is how this survives the CLI replacing a link: it is
    // repaired next session rather than assumed to have held. The account's own
    // credentials are untouched by the repair.
    assert.equal(
      NodeFS.readFileSync(NodePath.join(root, "account-b", ".credentials.json"), "utf8"),
      '{"b":true}\n',
    );
    assert.equal(
      NodeFS.lstatSync(NodePath.join(root, "account-b", "settings.json")).isSymbolicLink(),
      true,
    );
  }).pipe(run),
);

it.effect("repairs a link that points at the wrong place", () =>
  Effect.gen(function* () {
    const root = makeRoot();
    givenPrimary(root);
    const layout = layoutFor(root);
    NodeFS.mkdirSync(NodePath.join(root, "account-b"), { recursive: true });
    NodeFS.symlinkSync(
      NodePath.join(root, "elsewhere"),
      NodePath.join(root, "account-b", "skills"),
    );

    yield* materializeClaudeAccountHome(layout);

    assert.equal(
      NodeFS.readlinkSync(NodePath.join(root, "account-b", "skills")),
      NodePath.join(root, "primary", "skills"),
    );
  }).pipe(run),
);

it.effect("refuses rather than overwrite a real file the account has been using", () =>
  Effect.gen(function* () {
    const root = makeRoot();
    givenPrimary(root);
    NodeFS.mkdirSync(NodePath.join(root, "account-b"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(root, "account-b", "settings.json"), '{"forked":true}\n');

    const result = yield* Effect.result(materializeClaudeAccountHome(layoutFor(root)));

    // Two configurations have forked apart, and only a person can say which one
    // they meant. Deleting the account's own file to restore the link would
    // throw away a setting they made.
    assert.equal(result._tag, "Failure");
    assert.equal(
      NodeFS.readFileSync(NodePath.join(root, "account-b", "settings.json"), "utf8"),
      '{"forked":true}\n',
    );
  }).pipe(run),
);

it.effect("refuses credentials that are a link to another account's", () =>
  Effect.gen(function* () {
    const root = makeRoot();
    givenPrimary(root);
    NodeFS.mkdirSync(NodePath.join(root, "account-b"), { recursive: true });
    NodeFS.symlinkSync(
      NodePath.join(root, "primary", ".credentials.json"),
      NodePath.join(root, "account-b", ".credentials.json"),
    );

    const result = yield* Effect.result(materializeClaudeAccountHome(layoutFor(root)));

    // This is the failure the layout exists to prevent: two "accounts" that are
    // one account wearing two names, which looks like it works until a rate
    // limit or a login says otherwise.
    assert.equal(result._tag, "Failure");
  }).pipe(run),
);

it.effect("adopts a directory another tool created, keeping the original beside it", () =>
  Effect.gen(function* () {
    const root = makeRoot();
    givenPrimary(root);
    const account = NodePath.join(root, "account-b");
    NodeFS.mkdirSync(NodePath.join(account, "plugins", "an-old-plugin"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(account, "plugins", "an-old-plugin", "memory.md"), "kept\n");

    yield* materializeClaudeAccountHome(layoutFor(root), { adoptExisting: true });

    // The link is in place …
    assert.equal(NodeFS.lstatSync(NodePath.join(account, "plugins")).isSymbolicLink(), true);
    // … and nothing was deleted to get it there.
    const kept = NodeFS.readdirSync(account).find((entry) =>
      entry.startsWith("plugins.account-local-"),
    );
    assert.ok(kept !== undefined, "the account's own copy should be kept beside the link");
    assert.equal(
      NodeFS.readFileSync(NodePath.join(account, kept, "an-old-plugin", "memory.md"), "utf8"),
      "kept\n",
    );
  }).pipe(run),
);

const keptProjects = (account: string): string => {
  const kept = NodeFS.readdirSync(account).find((entry) =>
    entry.startsWith("projects.account-local-"),
  );
  assert.ok(kept !== undefined, "the account's own copy should be kept beside the link");
  return NodePath.join(account, kept);
};

it.effect("moves conversations an account wrote on its own into the shared store", () =>
  Effect.gen(function* () {
    const root = makeRoot();
    givenPrimary(root);
    const account = NodePath.join(root, "account-b");
    const shared = NodePath.join(root, "primary", "projects", "-work");
    const local = NodePath.join(account, "projects", "-work");
    NodeFS.mkdirSync(shared, { recursive: true });
    NodeFS.mkdirSync(local, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(local, "b9ddd43a.jsonl"), "b\n");
    // On a clash the newer transcript is the shared one, whichever side it was on.
    const older = 1_767_225_600; // 2026-01-01, in seconds as utimes takes it
    const newer = older + 31 * 86_400;
    for (const [side, name, at] of [
      [shared, "shared-newer.jsonl", newer],
      [local, "shared-newer.jsonl", older],
      [shared, "local-newer.jsonl", older],
      [local, "local-newer.jsonl", newer],
    ] as const) {
      const file = NodePath.join(side, name);
      NodeFS.writeFileSync(file, side === shared ? "shared\n" : "local\n");
      NodeFS.utimesSync(file, at, at);
    }
    // A file link needs elevation on Windows; that failing must not leave projects/ unlinked.
    NodeFS.writeFileSync(NodePath.join(account, "CLAUDE.md"), "# forked\n");

    const result = yield* Effect.result(materializeClaudeAccountHome(layoutFor(root)));

    assert.equal(result._tag, "Failure");
    assert.equal(NodeFS.lstatSync(NodePath.join(account, "projects")).isSymbolicLink(), true);
    // Any account now resumes it, through the shared store.
    assert.equal(NodeFS.readFileSync(NodePath.join(shared, "b9ddd43a.jsonl"), "utf8"), "b\n");
    assert.equal(
      NodeFS.readFileSync(NodePath.join(shared, "shared-newer.jsonl"), "utf8"),
      "shared\n",
    );
    assert.equal(
      NodeFS.readFileSync(NodePath.join(shared, "local-newer.jsonl"), "utf8"),
      "local\n",
    );
    const kept = NodePath.join(keptProjects(account), "-work");
    assert.equal(NodeFS.readFileSync(NodePath.join(kept, "shared-newer.jsonl"), "utf8"), "local\n");
    assert.equal(
      NodeFS.readFileSync(NodePath.join(kept, "local-newer.jsonl.shared-older"), "utf8"),
      "shared\n",
    );
    assert.equal(NodeFS.existsSync(NodePath.join(root, "primary", "projects.merge.lock")), false);
  }).pipe(run),
);

it.effect("waits for a merge already running, and takes over one abandoned", () =>
  Effect.gen(function* () {
    const root = makeRoot();
    givenPrimary(root);
    const account = NodePath.join(root, "account-b");
    const transcript = NodePath.join(account, "projects", "-work", "b9ddd43a.jsonl");
    NodeFS.mkdirSync(NodePath.dirname(transcript), { recursive: true });
    NodeFS.writeFileSync(transcript, "b\n");
    const lock = NodePath.join(root, "primary", "projects.merge.lock");
    NodeFS.mkdirSync(lock, { recursive: true });

    yield* Effect.result(materializeClaudeAccountHome(layoutFor(root)));

    assert.equal(NodeFS.readFileSync(transcript, "utf8"), "b\n");
    assert.equal(NodeFS.lstatSync(NodePath.join(account, "projects")).isDirectory(), true);

    const abandoned = 1_577_836_800; // 2020-01-01
    NodeFS.utimesSync(lock, abandoned, abandoned);
    yield* materializeClaudeAccountHome(layoutFor(root));

    assert.equal(
      NodeFS.readFileSync(
        NodePath.join(root, "primary", "projects", "-work", "b9ddd43a.jsonl"),
        "utf8",
      ),
      "b\n",
    );
    assert.equal(NodeFS.existsSync(lock), false);
  }).pipe(run),
);

it.effect("never follows a link inside the account's conversations", () =>
  Effect.gen(function* () {
    const root = makeRoot();
    givenPrimary(root);
    const account = NodePath.join(root, "account-b");
    const outside = NodePath.join(root, "outside");
    NodeFS.mkdirSync(outside, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(outside, "secret.jsonl"), "x\n");
    NodeFS.mkdirSync(NodePath.join(account, "projects"), { recursive: true });
    NodeFS.symlinkSync(outside, NodePath.join(account, "projects", "loop"));

    yield* materializeClaudeAccountHome(layoutFor(root));

    assert.equal(NodeFS.readFileSync(NodePath.join(outside, "secret.jsonl"), "utf8"), "x\n");
    assert.equal(NodeFS.existsSync(NodePath.join(root, "primary", "projects", "loop")), false);
    assert.equal(
      NodeFS.lstatSync(NodePath.join(keptProjects(account), "loop")).isSymbolicLink(),
      true,
    );
  }).pipe(run),
);

it.effect("does nothing at all for the primary account", () =>
  Effect.gen(function* () {
    const layout = yield* resolveClaudeAccountHomeLayout({ homePath: "" });
    assert.equal(layout.mode, "direct");
    assert.equal(layout.accountHomePath, undefined);
    yield* materializeClaudeAccountHome(layout);
  }).pipe(run),
);

it.effect("never materialises a relative home under the server's cwd", () =>
  Effect.gen(function* () {
    const layout = yield* resolveClaudeAccountHomeLayout({ homePath: "./synthetic config" });
    assert.equal(layout.mode, "direct");
    assert.equal(layout.accountHomePath, undefined);
  }).pipe(run),
);

it.effect("treats an account home equal to the shared one as the primary", () =>
  Effect.gen(function* () {
    const root = makeRoot();
    const shared = NodePath.join(root, "primary");
    const layout = yield* resolveClaudeAccountHomeLayout({ homePath: shared }, shared);
    assert.equal(layout.mode, "direct");
  }).pipe(run),
);

// node --test scripts/tessaya/live/tessaya-claude.test.mjs
import * as NodeAssert from "node:assert/strict";
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";
import * as NodeURL from "node:url";

const wrapper = NodePath.join(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "tessaya-claude",
);

/** A fake HOME with a setup-token login and a fake claude that prints the config dir it was given. */
const sandbox = () => {
  const home = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "tessaya-claude-"));
  NodeFS.mkdirSync(NodePath.join(home, ".claude"));
  NodeFS.writeFileSync(
    NodePath.join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { accessToken: "fake", scopes: [] } }),
  );
  const fake = NodePath.join(home, "fake-claude");
  NodeFS.writeFileSync(fake, '#!/bin/sh\necho "${CLAUDE_CONFIG_DIR:-shared}"\n', { mode: 0o755 });
  return { home, fake };
};

NodeTest.test(
  "the first launch on a machine gets its own dir, though the threads root's parent is missing",
  () => {
    const { home, fake } = sandbox();
    try {
      const env = { ...process.env, HOME: home, TESSAYA_REAL_CLAUDE: fake };
      delete env.CLAUDE_CONFIG_DIR;
      delete env.TESSAYA_CLAUDE_THREADS;
      delete env.CSWAP_DATA;
      const out = NodeChildProcess.execFileSync(wrapper, ["--resume", "abc"], { env })
        .toString()
        .trim();
      NodeAssert.equal(
        out,
        NodePath.join(home, ".local", "share", "tessaya", "claude-threads", "s-abc"),
      );
    } finally {
      NodeFS.rmSync(home, { recursive: true, force: true });
    }
  },
);

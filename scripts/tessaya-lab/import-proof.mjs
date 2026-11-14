// The real server on a throwaway home: Resume of an old stopped session (outside the 30-day window, behind 105 newer
// transcripts) must open a thread holding its first message. Usage: node scripts/tessaya-lab/import-proof.mjs <work dir> [port]
// Pairing: `bin.ts pair` token, exchanged at /oauth/token, then RPCs over a WebSocket. Exit 0 only if it holds.

import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";

const work = NodePath.resolve(process.argv[2] ?? "import-proof-work");
const port = Number(process.argv[3] ?? 3797);
const root = NodePath.resolve(import.meta.dirname, "..", "..");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${detail}`);
};

const home = NodePath.join(work, "t3home");
const profile = NodePath.join(work, "profile");
const project = NodePath.join(work, "project");
NodeFS.rmSync(work, { recursive: true, force: true });
for (const dir of [home, profile, project]) NodeFS.mkdirSync(dir, { recursive: true });
NodeFS.writeFileSync(NodePath.join(project, "BRIEF.md"), "brief");

// 105 transcripts newer than the one we want, which is also 40 days old (outside the 30-day window).
const WANTED = "b9ddd43a-aba4-4dbd-9eda-b47c47989e9e";
const FIRST = `I need you to help me with my printer setup ${NodeCrypto.randomUUID().slice(0, 8)}`;
const transcriptsDir = NodePath.join(profile, ".claude", "projects", "proof-project");
NodeFS.mkdirSync(transcriptsDir, { recursive: true });
const write = (id, first, ageMs) => {
  const file = NodePath.join(transcriptsDir, `${id}.jsonl`);
  const lines = [
    {
      type: "user",
      cwd: project,
      sessionId: id,
      entrypoint: "cli",
      timestamp: "2026-10-30T10:00:00.000Z",
      message: { role: "user", content: first },
    },
    {
      type: "assistant",
      sessionId: id,
      timestamp: "2026-10-30T10:01:00.000Z",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: "Sure." }],
      },
    },
  ];
  NodeFS.writeFileSync(file, `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
  const at = (Date.now() - ageMs) / 1000;
  NodeFS.utimesSync(file, at, at);
};
for (let i = 0; i < 105; i += 1)
  write(NodeCrypto.randomUUID(), `Recent conversation ${i}`, (i + 1) * 60_000);
write(WANTED, FIRST, 40 * 24 * 3_600_000);

// The Director's real case: a 70 MB transcript (long tool output, thousands of records), a few days old.
const BIG = "0b16b16b-0b16-4b16-8b16-0b16b16b16b1";
// And one with more records than the importer's usual budget (100,000 lines), as a very long session has.
const MANY = "0c17c17c-0c17-4c17-8c17-0c17c17c17c1";
const MANY_FIRST = `Many records ${NodeCrypto.randomUUID().slice(0, 8)}`;
{
  const file = NodePath.join(transcriptsDir, `${MANY}.jsonl`);
  const fd = NodeFS.openSync(file, "w");
  const put = (o) => NodeFS.writeSync(fd, `${JSON.stringify(o)}\n`);
  put({
    type: "user",
    cwd: project,
    sessionId: MANY,
    entrypoint: "cli",
    timestamp: "2026-10-30T10:00:00.000Z",
    message: { role: "user", content: MANY_FIRST },
  });
  for (let turn = 0; turn < 40_000; turn += 1) {
    const id = `toolu_${turn}`;
    put({
      type: "assistant",
      sessionId: MANY,
      timestamp: "2026-10-30T10:01:00.000Z",
      message: {
        role: "assistant",
        stop_reason: "tool_use",
        content: [{ type: "tool_use", id, name: "Bash", input: { command: "ls" } }],
      },
    });
    put({
      type: "user",
      sessionId: MANY,
      timestamp: "2026-10-30T10:02:00.000Z",
      message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
    });
    put({
      type: "assistant",
      sessionId: MANY,
      timestamp: "2026-10-30T10:03:00.000Z",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: `Done with ${turn}` }],
      },
    });
  }
  put({
    type: "user",
    sessionId: MANY,
    timestamp: "2026-10-30T10:04:00.000Z",
    message: { role: "user", content: "Last question" },
  });
  NodeFS.closeSync(fd);
  const at = (Date.now() - 5 * 24 * 3_600_000) / 1000;
  NodeFS.utimesSync(file, at, at);
}
const BIG_FIRST = `Help me with my printer setup ${NodeCrypto.randomUUID().slice(0, 8)}`;
{
  const file = NodePath.join(transcriptsDir, `${BIG}.jsonl`);
  const fd = NodeFS.openSync(file, "w");
  const put = (o) => NodeFS.writeSync(fd, `${JSON.stringify(o)}\n`);
  const blob = "x".repeat(2_000);
  put({
    type: "user",
    cwd: project,
    sessionId: BIG,
    entrypoint: "cli",
    timestamp: "2026-10-30T10:00:00.000Z",
    message: { role: "user", content: BIG_FIRST },
  });
  let written = 0;
  for (let turn = 0; written < Number(process.env.BIG_MB ?? 70) * 1024 * 1024; turn += 1) {
    const id = `toolu_${turn}`;
    put({
      type: "assistant",
      sessionId: BIG,
      timestamp: "2026-10-30T10:01:00.000Z",
      message: {
        role: "assistant",
        stop_reason: "tool_use",
        content: [
          { type: "text", text: `Step ${turn}` },
          { type: "tool_use", id, name: "Bash", input: { command: `echo ${turn}` } },
        ],
      },
    });
    for (let part = 0; part < 12; part += 1) {
      put({
        type: "user",
        sessionId: BIG,
        timestamp: "2026-10-30T10:02:00.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: id, content: `${blob}${part}` }],
        },
      });
      written += blob.length + 250;
    }
    put({
      type: "assistant",
      sessionId: BIG,
      timestamp: "2026-10-30T10:03:00.000Z",
      message: {
        role: "assistant",
        stop_reason: "end_turn",
        content: [{ type: "text", text: `Done with ${turn}` }],
      },
    });
    put({
      type: "user",
      sessionId: BIG,
      timestamp: "2026-10-30T10:04:00.000Z",
      message: { role: "user", content: `Next question ${turn}` },
    });
  }
  NodeFS.closeSync(fd);
  const at = (Date.now() - 5 * 24 * 3_600_000) / 1000;
  NodeFS.utimesSync(file, at, at);
}

const env = {
  ...process.env,
  T3CODE_HOME: home,
  T3CODE_PORT: String(port),
  T3CODE_NO_BROWSER: "1",
  HOME: profile,
  USERPROFILE: profile,
  BATON_NO_HERDR: "1",
  BATON_AUTO_RESUME: "off",
};
const server = NodeChildProcess.spawn(
  process.execPath,
  [NodePath.join(root, "apps/server/src/bin.ts")],
  {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  },
);
let log = "";
server.stdout.on("data", (d) => (log += d));
server.stderr.on("data", (d) => (log += d));
const base = `http://127.0.0.1:${port}`;
const finish = (code) => {
  server.kill();
  NodeFS.writeFileSync(NodePath.join(work, "server.log"), log);
  process.exit(code);
};
try {
  for (let i = 0; i < 120; i += 1) {
    if (
      await fetch(`${base}/api/auth/session`).then(
        () => true,
        () => false,
      )
    )
      break;
    if (server.exitCode !== null) throw new Error(`server exited early: ${log.slice(-600)}`);
    await sleep(1000);
  }
  let paired = "";
  for (let attempt = 0; attempt < 10 && paired === ""; attempt += 1) {
    const pair = NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.join(root, "apps/server/src/bin.ts"), "pair", "--base-dir", home, "--ttl", "10m"],
      { env, encoding: "utf8" },
    );
    if (pair.status === 0) paired = pair.stdout;
    else {
      console.log(
        `pair attempt ${attempt + 1} failed: ${`${pair.stdout}${pair.stderr}`.slice(-500)}`,
      );
      await sleep(3000);
    }
  }
  const token =
    /token=([A-Za-z0-9_-]+)/.exec(paired)?.[1] ?? /\b([A-Za-z0-9_-]{20,})\b/.exec(paired)?.[1];
  if (!token) throw new Error(`no token in: ${paired.slice(0, 300)}`);
  const exchanged = await fetch(`${base}/oauth/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
      subject_token: token,
      subject_token_type: "urn:t3:params:oauth:token-type:environment-bootstrap",
      requested_token_type: "urn:ietf:params:oauth:token-type:access_token",
      scope: "orchestration:read orchestration:operate",
      client_label: "import-proof",
    }),
  });
  const access = (await exchanged.json()).access_token;
  check(
    "a pairing token is exchanged for an access token",
    typeof access === "string",
    String(exchanged.status),
  );

  const wsDir = NodeFS.readdirSync(NodePath.join(root, "node_modules", ".pnpm")).find((d) =>
    d.startsWith("ws@8"),
  );
  const { WebSocket } = NodeModule.createRequire(
    NodePath.join(root, "node_modules", ".pnpm", wsDir, "node_modules/"),
  )("ws");
  const socket = new WebSocket(`${base.replace("http", "ws")}/ws?orchestrationProtocol=2`, {
    headers: { authorization: `Bearer ${access}` },
  });
  await new Promise((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  let nextId = 0;
  const pending = new Map();
  socket.on("message", (data) => {
    const message = JSON.parse(String(data));
    if (message._tag === "Ping") return socket.send(JSON.stringify({ _tag: "Pong" }));
    if (message._tag === "Exit") pending.get(message.requestId)?.(message.exit);
  });
  const rpc = (tag, payload) =>
    new Promise((resolve, reject) => {
      const id = String(++nextId);
      const timer = setTimeout(() => reject(new Error(`${tag} timed out`)), 120_000);
      pending.set(id, (exit) => (clearTimeout(timer), resolve(exit)));
      socket.send(JSON.stringify({ _tag: "Request", id, tag, payload, headers: [] }));
    });
  const value = (exit) => (exit?._tag === "Success" ? exit.value : null);

  process.env.USERPROFILE = profile;
  process.env.HOME = profile;
  console.log(
    `homedir under the server's environment: ${NodeOS.homedir()}; transcripts: ${NodeFS.readdirSync(transcriptsDir).length}`,
  );
  console.log(`folders: ${JSON.stringify(await rpc("baton.sessions.folders", {})).slice(0, 400)}`);
  const listExit = await rpc("baton.sessions.list", { limit: 200 });
  const listed = value(listExit);
  check(
    "the catalog lists the transcripts of the throwaway profile",
    (listed?.sessions?.length ?? 0) > 50,
    String(listed?.sessions?.length),
  );

  console.log(
    `server log: ${log
      .split("\n")
      .filter((l) => l.includes("catalog:"))
      .slice(-8)
      .join(" | ")}`,
  );
  const resumed = value(await rpc("baton.sessions.resume", { sessionId: WANTED, cwd: project }));
  check(
    "Resume brings the old session back as a thread",
    resumed?.state === "running" && typeof resumed?.threadId === "string",
    JSON.stringify(resumed),
  );
  check(
    "the thread is the imported one for that session id",
    resumed?.threadId?.endsWith(`:${WANTED}`) === true,
    String(resumed?.threadId),
  );

  if (typeof resumed?.threadId === "string") {
    const projection = await rpc("orchestration.getThreadProjection", {
      threadId: resumed.threadId,
    });
    const text = JSON.stringify(projection);
    check(
      "the thread's history contains the first user message",
      text.includes(FIRST),
      `${text.length} bytes`,
    );
  }
  const started = Date.now();
  const bigExit = await rpc("baton.sessions.resume", { sessionId: BIG, cwd: project });
  const big = value(bigExit);
  console.log(
    `big resume answered in ${Math.round((Date.now() - started) / 1000)} s: ${JSON.stringify(bigExit).slice(0, 500)}`,
  );
  let bigThread = big?.threadId ?? null;
  // A long import may answer "resuming"; the session is then watched through the list until it has a thread.
  for (let i = 0; i < 120 && bigThread === null; i += 1) {
    await sleep(2000);
    const row = value(await rpc("baton.sessions.list", { limit: 200 }))?.sessions?.find(
      (r) => r.id === BIG,
    );
    if (row?.state === "failed") break;
    bigThread = row?.threadId ?? null;
  }
  check(
    "a 70 MB transcript is brought back as a thread",
    typeof bigThread === "string",
    String(bigThread),
  );
  if (typeof bigThread === "string") {
    const text = JSON.stringify(
      await rpc("orchestration.getThreadProjection", { threadId: bigThread }),
    );
    check(
      "its history holds the first message and the latest turn",
      text.includes(BIG_FIRST) && text.includes("Next question"),
      `${text.length} bytes`,
    );
  }
  const many = value(await rpc("baton.sessions.resume", { sessionId: MANY, cwd: project }));
  let manyThread = many?.threadId ?? null;
  for (let i = 0; i < 120 && manyThread === null; i += 1) {
    await sleep(2000);
    const row = value(await rpc("baton.sessions.list", { limit: 200 }))?.sessions?.find(
      (r) => r.id === MANY,
    );
    if (row?.state === "failed") {
      console.log(`many failed: ${row.detail}`);
      break;
    }
    manyThread = row?.threadId ?? null;
  }
  check(
    "a session with 120,000 records is brought back as a thread",
    typeof manyThread === "string",
    String(manyThread),
  );
  socket.close();
  finish(results.every(Boolean) ? 0 : 1);
} catch (error) {
  console.log(`FAIL ${error instanceof Error ? error.message : String(error)}`);
  console.log(log.slice(-1500));
  finish(1);
}

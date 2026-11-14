// @effect-diagnostics nodeBuiltinImport:off globalConsole:off
/**
 * Live check of the shared computer's dispatch shell with the app's own code: usage, then a dummy request that
 * is looked at and denied. Needs --host --user --machine-key --approver-key --repo --branch. Prints no key.
 */
import { sshProviders } from "../../packages/tessaya-shared/src/cloud/sshShell.ts";
import { nodeExec } from "../../packages/tessaya-shared/src/cloud/nodeExec.ts";

const flag = (name: string): string => {
  const at = process.argv.indexOf(name);
  return at < 0 ? "" : (process.argv[at + 1] ?? "");
};
const missing = [
  "--host",
  "--user",
  "--machine-key",
  "--approver-key",
  "--repo",
  "--branch",
].filter((f) => flag(f) === "");
if (missing.length > 0) {
  console.error(`missing: ${missing.join(", ")}`);
  process.exit(2);
}
const claude = sshProviders(
  {
    host: flag("--host"),
    user: flag("--user"),
    machineKey: flag("--machine-key"),
    approverKey: flag("--approver-key"),
  },
  nodeExec,
).find((p) => p.id === "claude")!;

let failed = false;
const say = (ok: boolean, line: string) => {
  if (!ok) failed = true;
  console.log(`${ok ? "ok  " : "FAIL"} ${line}`);
};

const usage = await claude.usage();
if (!usage.ok) say(false, `usage: ${usage.error}`);
else {
  say(true, `usage: ${usage.value.length} accounts`);
  for (const u of usage.value) {
    say(
      !u.rejected,
      `  ${u.provider} ${u.account}: ${u.weeklyPercent === null ? "usage unknown" : `${u.weeklyPercent}% used`}${u.resetsAt === null ? "" : `, resets ${u.resetsAt}`}${u.login === undefined ? "" : `, login ${u.login}`}${u.available === false ? ", not available" : ""}`,
    );
  }
}

const made = await claude.dispatch({
  repo: flag("--repo"),
  branch: flag("--branch"),
  brief: "Tessaya connection test. Do nothing; this request will be denied.",
  label: "tessaya-smoke",
});
if (!made.ok) say(false, `dispatch: ${made.error}`);
else {
  say(
    made.value.state === "awaiting-director",
    `dispatch: request ${made.value.id} is ${made.value.state}`,
  );
  const seen = await claude.status(made.value.id);
  say(
    seen.ok && seen.value.state === "awaiting-director",
    `status: ${seen.ok ? seen.value.state : seen.error}`,
  );
  const listed = await claude.list({ mine: true, label: "tessaya-smoke" });
  say(
    listed.ok && listed.value.some((r) => r.id === made.value.id),
    `list: ${listed.ok ? `${listed.value.length} of mine` : listed.error}`,
  );
  const denied = await claude.deny(made.value.id, "connection test");
  say(denied.ok, `deny: ${denied.ok ? "denied, nothing ran" : denied.error}`);
  const after = await claude.status(made.value.id);
  say(
    after.ok && after.value.state === "denied",
    `status after: ${after.ok ? after.value.state : after.error}`,
  );
}
process.exit(failed ? 1 : 0);

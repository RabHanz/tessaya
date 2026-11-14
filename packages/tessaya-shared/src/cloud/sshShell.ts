/**
 * The shared computer's dispatch shell (advanced transport); the contract is in docs/baton/CLOUD_DISPATCH.md.
 * Use its PUBLIC address: Tailscale SSH ignores the forced command. Arguments are a list; the brief is stdin.
 */
import { jsonLines, jsonObject, requestFrom, safeArg, safeWords, usageFromShell } from "./parse.ts";
import {
  BRIEF_MAX,
  type CloudProvider,
  type CloudRequest,
  type Exec,
  type ExecResult,
  type Outcome,
  type ProviderId,
  type Usage,
} from "./types.ts";

export interface SshSettings {
  readonly host: string;
  readonly user: string;
  /** Paths of key files; never the keys. */
  readonly machineKey: string;
  readonly approverKey: string;
  readonly ssh?: string;
  /** A key kept somewhere other than a file (the Vault): gives a path for the one call and removes it after. */
  readonly keyFor?: (
    role: "machine" | "approver",
  ) => Promise<
    { readonly path: string; readonly done: () => void } | { readonly error: string } | null
  >;
}

export const SSH_PROVIDERS: ReadonlyArray<{
  readonly id: ProviderId;
  readonly label: string;
  readonly driver: string;
}> = [
  { id: "claude", label: "Claude", driver: "claudeAgent" },
  { id: "codex", label: "Codex", driver: "codex" },
  { id: "gemini", label: "Gemini (Jules)", driver: "gemini" },
  { id: "cursor", label: "Cursor", driver: "cursor" },
  { id: "opencode", label: "OpenCode", driver: "opencode" },
  { id: "grok", label: "Grok", driver: "grok" },
];

const TIMEOUT_MS = 30_000;
const fail = <T>(error: string): Outcome<T> => ({ ok: false, error });

/** Plain words for a failed run. Never includes a key's contents. */
export const sshProblem = (r: ExecResult, key: "machine" | "approver"): string => {
  const said = jsonObject(r.stdout);
  if (typeof said?.["refused"] === "string") return said["refused"].slice(0, 240);
  if (typeof said?.["error"] === "string" && said["error"] !== "")
    return said["error"].slice(0, 240);
  if (r.missing)
    return "ssh is not installed on this computer. Install the OpenSSH client, or use the default way of running cloud tasks.";
  if (r.timedOut) return "The shared computer did not answer in time.";
  const err = r.stderr.toLowerCase();
  if (err.includes("permission denied"))
    return key === "approver"
      ? "The approval key was not accepted."
      : "The sending key was not accepted.";
  if (err.includes("no such file") || err.includes("identity file"))
    return key === "approver"
      ? "The approval key file was not found."
      : "The sending key file was not found.";
  if (r.code === 255 || err.includes("could not resolve") || err.includes("connection"))
    return "The shared computer could not be reached.";
  return "The shared computer refused that.";
};

/** One connection, and a provider for each name the shell can offer. */
export const sshProviders = (s: SshSettings, exec: Exec): ReadonlyArray<CloudProvider> => {
  const configured =
    s.host !== "" && s.user !== "" && (s.machineKey !== "" || s.keyFor !== undefined);
  let usage: ReadonlyArray<Usage> = [];
  let ready = new Map<string, { ready: boolean; needs: string | null }>();

  const call = async (
    key: "machine" | "approver",
    sub: ReadonlyArray<string>,
    stdin?: string,
  ): Promise<Outcome<ExecResult>> => {
    if (!configured) return fail("The shared computer is not set up on this computer.");
    const kept = s.keyFor === undefined ? null : await s.keyFor(key);
    if (kept !== null && "error" in kept) return fail(kept.error);
    const keyFile = kept?.path ?? (key === "machine" ? s.machineKey : s.approverKey);
    if (keyFile === "")
      return fail(
        key === "machine"
          ? "The sending key is not set. Add it under Cloud, Advanced."
          : "The approval key is not set. Add it under Cloud, Advanced.",
      );
    let args: string[];
    try {
      args = [
        // -n: do not read the terminal's input when there is no brief to send.
        ...(stdin === undefined ? ["-n"] : []),
        "-i",
        keyFile,
        "-o",
        "BatchMode=yes",
        "-o",
        "IdentitiesOnly=yes",
        "-o",
        "ConnectTimeout=10",
        `${safeArg(s.user, "The user name")}@${safeArg(s.host, "The host name")}`,
        ...sub,
      ];
    } catch (error) {
      return fail(error instanceof Error ? error.message : "That cannot be sent safely.");
    }
    let r: ExecResult;
    try {
      r = await exec(s.ssh ?? "ssh", args, {
        ...(stdin === undefined ? {} : { stdin }),
        timeoutMs: TIMEOUT_MS,
      });
    } finally {
      kept?.done();
    }
    return r.code === 0 ? { ok: true, value: r } : fail(sshProblem(r, key));
  };
  const one = (r: ExecResult, provider: ProviderId): Outcome<CloudRequest> => {
    const o = jsonObject(r.stdout);
    if (o === null) return fail("The shared computer sent something unreadable.");
    if (typeof o["refused"] === "string") return fail(o["refused"].slice(0, 240));
    return { ok: true, value: requestFrom(provider, o) };
  };
  const readUsage = async (): Promise<Outcome<ReadonlyArray<Usage>>> => {
    const r = await call("machine", ["usage"]);
    if (!r.ok) return r;
    const o = jsonObject(r.value.stdout);
    if (o === null) return fail("The shared computer sent something unreadable.");
    const parsed = usageFromShell(o);
    usage = parsed.usage;
    ready = new Map(parsed.ready);
    return { ok: true, value: usage };
  };

  return SSH_PROVIDERS.map(({ id, label, driver }): CloudProvider => ({
    id,
    transport: "ssh",
    label,
    driver,
    capabilities: { resultKind: "pr", cancel: true, usage: true, diff: false, apply: false },
    approval: "remote",
    setup: () => {
      if (!configured)
        return {
          state: "not-set-up",
          why: "No shared computer is chosen.",
          needs: "A host, a user and a key file under Cloud, Advanced.",
        };
      const r = ready.get(id);
      return r === undefined || r.ready
        ? { state: "ready" }
        : {
            state: "not-set-up",
            why: `${label} cannot run on the shared computer yet.`,
            needs: r.needs ?? "",
          };
    },
    detect: async () => {
      if (!configured)
        return {
          installed: false,
          signedIn: false,
          identity: null,
          line: `${label}: the shared computer is not set up.`,
          signInCommand: null,
        };
      if (ready.size === 0) await readUsage();
      const r = ready.get(id);
      const ok = r?.ready === true;
      return {
        installed: ok,
        signedIn: ok,
        identity: null,
        line: ok
          ? `${label}: ready on the shared computer.`
          : `${label}: ${r?.needs ?? "not offered by the shared computer"}`,
        signInCommand: null,
      };
    },
    accounts: () => usage.filter((u) => u.provider === id).map((u) => u.account),
    dispatch: async (input) => {
      const brief = input.brief.trim();
      if (brief === "") return fail("There is nothing to send.");
      if (brief.length > BRIEF_MAX)
        return fail(`A cloud brief is at most ${BRIEF_MAX} characters.`);
      let sub: string[];
      try {
        sub = [
          "dispatch",
          "--provider",
          id,
          "--repo",
          safeArg(input.repo, "The repository"),
          "--branch",
          safeArg(input.branch, "The branch"),
          "--task-file",
          "-",
        ];
      } catch (error) {
        return fail(error instanceof Error ? error.message : "That cannot be sent safely.");
      }
      if (input.label !== undefined) sub.push("--label", safeWords(input.label, 60));
      const r = await call("machine", sub, brief);
      if (!r.ok) return r;
      const made = one(r.value, id);
      return made.ok
        ? {
            ok: true,
            value: {
              ...made.value,
              state: "awaiting-director" as const,
              fromWeb: input.fromWeb === true,
              task: made.value.task ?? brief.split("\n")[0]!.slice(0, 140),
            },
          }
        : made;
    },
    status: async (rid) => {
      const r = await call("machine", ["status", safeWords(rid, 40)]);
      return r.ok ? one(r.value, id) : r;
    },
    list: async (f) => {
      const r = await call("machine", [
        "list",
        ...(f.mine === true ? ["--mine"] : []),
        ...(f.label === undefined ? [] : ["--label", safeWords(f.label, 60)]),
      ]);
      if (!r.ok) return r;
      const o = jsonObject(r.value.stdout);
      const rows = Array.isArray(o?.["requests"])
        ? (o!["requests"] as unknown[]).filter(
            (x): x is Record<string, unknown> => typeof x === "object" && x !== null,
          )
        : jsonLines(r.value.stdout);
      return {
        ok: true,
        value: rows
          .filter((x) => x["refused"] === undefined)
          .map((x) =>
            requestFrom((typeof x["provider"] === "string" ? x["provider"] : id) as ProviderId, x),
          ),
      };
    },
    cancel: async (rid) => {
      const r = await call("machine", ["cancel", safeWords(rid, 40)]);
      return r.ok ? { ok: true, value: null } : r;
    },
    usage: readUsage,
    approve: async (rid, account, answerRef) => {
      const r = await call("approver", [
        "approve",
        safeWords(rid, 40),
        "--provider",
        id,
        "--account",
        safeArg(account, "The account"),
        "--answer-ref",
        safeWords(answerRef, 60),
      ]);
      return r.ok ? one(r.value, id) : r;
    },
    deny: async (rid, reason) => {
      const r = await call("approver", [
        "deny",
        safeWords(rid, 40),
        "--reason",
        safeWords(reason, 80),
      ]);
      return r.ok ? { ok: true, value: null } : r;
    },
  }));
};

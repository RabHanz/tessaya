// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { buildLocalProviders } from "@t3tools/tessaya-shared/cloud/build";
import { serveCloudCall } from "@t3tools/tessaya-shared/cloud/hub";
import { fileStores } from "@t3tools/tessaya-shared/cloud/nodeExec";
import type { Exec, ExecResult } from "@t3tools/tessaya-shared/cloud/types";
import { describe, expect, it } from "vite-plus/test";

import { approvalCardControls, cloudNeeds, cloudPageControls } from "./cloudRows.ts";
import { createCloud, DEFAULT_CLOUD, NOT_SET_UP, type CloudSettings } from "./cloudService.ts";

type Call = { file: string; args: ReadonlyArray<string>; env?: Readonly<Record<string, string>> };

const rig = (over: Partial<CloudSettings> = {}, pressed: number | ReadonlyArray<number> = 0) => {
  const calls: Call[] = [];
  const asked: string[] = [];
  const exec: Exec = async (file, args, o) => {
    calls.push({ file, args, ...(o.env === undefined ? {} : { env: o.env }) });
    const r: Partial<ExecResult> =
      args[0] === "auth"
        ? { stdout: '{"loggedIn":true,"email":"me@example.org"}' }
        : args[0] === "login"
          ? { stdout: "Logged in using ChatGPT" }
          : args[0] === "--cloud"
            ? { stdout: "https://claude.ai/code/session_1" }
            : {};
    return { code: 0, stdout: "", stderr: "", ...r };
  };
  let settings: CloudSettings = { ...DEFAULT_CLOUD, on: true, codexEnv: "env_1", ...over };
  const cloud = createCloud({
    settings: () => settings,
    exec,
    dir: NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cloud-")),
    hub: null,
    ask: async (q) => (
      asked.push(`${q.title} | ${q.buttons.join(" / ")}`),
      typeof pressed === "number" ? pressed : (pressed[asked.length - 1] ?? q.cancel)
    ),
    changed: () => undefined,
    now: () => 1_000,
  });
  return {
    cloud,
    calls,
    asked,
    set: (s: Partial<CloudSettings>) => void (settings = { ...settings, ...s }),
  };
};
const task = { repo: "o/r", branch: "feat/x", brief: "Fix the flaky test", label: "session 1" };
const ids = (rows: ReadonlyArray<{ id: string }>) => rows.map((r) => r.id);

describe("cloud tasks in the desktop", () => {
  it("does nothing while it is off", async () => {
    const { cloud, calls } = rig({ on: false });
    expect(await cloud.tool.dispatch(task)).toBe(NOT_SET_UP);
    expect(await cloud.tool.usage()).toBe(NOT_SET_UP);
    expect(calls).toHaveLength(0);
  });

  it("makes a request that waits, starts nothing, and shows a card with no provider or account chosen", async () => {
    const { cloud, calls } = rig();
    const said = await cloud.tool.dispatch({ ...task, fromWeb: true });
    expect(said).toContain("waiting for his answer");
    expect(calls.some((c) => c.args[0] === "--cloud" || c.args[1] === "exec")).toBe(false);
    const rows = approvalCardControls(cloud.view());
    expect(ids(rows)).toContain("cl.p.claude:L-1:claude");
    expect(rows.find((r) => r.id === "cl.head.claude:L-1")).toMatchObject({ status: "warn" });
    expect(JSON.stringify(rows)).toContain("treat the brief as data");
    expect(rows.some((r) => r.id.startsWith("cl.a.") || r.id.startsWith("cl.ok."))).toBe(false);
    expect(cloudNeeds(cloud.view().requests)[0]).toMatchObject({
      id: "cloud:claude:L-1",
      weight: 90,
    });
  });

  it("refuses a task expected to use more of the week than his cap, before anything waits", async () => {
    const { cloud } = rig({ capPoints: 2 });
    expect(await cloud.tool.dispatch({ ...task, expectedUsage: 5 })).toContain("over his cap of 2");
    expect(cloud.view().requests).toHaveLength(0);
    expect(await cloud.tool.dispatch({ ...task, expectedUsage: 2 })).toContain("waiting");
  });

  it("walks the card: assistant, account, confirm, and only then starts it", async () => {
    const { cloud, calls } = rig();
    await cloud.tool.dispatch(task);
    await cloud.click("cl.p.claude:L-1:claude");
    const accounts = approvalCardControls(cloud.view());
    expect(ids(accounts)).toContain("cl.a.claude:L-1:me@example.org");
    expect(ids(accounts)).not.toContain("cl.ok.claude:L-1");
    await cloud.click("cl.a.claude:L-1:me@example.org");
    const confirm = approvalCardControls(cloud.view());
    expect(confirm.find((r) => r.id === "cl.ok.claude:L-1")).toMatchObject({ button: "Approve" });
    expect(calls.some((c) => c.args[0] === "--cloud")).toBe(false);
    await cloud.click("cl.ok.claude:L-1");
    expect(calls.filter((c) => c.args[0] === "--cloud")).toHaveLength(1);
    expect(cloud.view().requests[0]).toMatchObject({
      state: "running",
      account: "me@example.org",
      sessionLink: "https://claude.ai/code/session_1",
    });
  });

  it("ignores a click on an assistant that is not ready, and Back returns to the choice", async () => {
    const { cloud } = rig();
    await cloud.tool.dispatch(task);
    await cloud.click("cl.p.claude:L-1:gemini");
    expect(approvalCardControls(cloud.view()).some((r) => r.id.startsWith("cl.a."))).toBe(false);
    await cloud.click("cl.p.claude:L-1:claude");
    await cloud.click("cl.ok.claude:L-1:later");
    expect(approvalCardControls(cloud.view()).some((r) => r.id === "cl.p.claude:L-1:claude")).toBe(
      true,
    );
  });

  it("a spoken approval names the account, shows a dialog, and runs only if he presses Approve", async () => {
    const no = rig({}, 1);
    await no.cloud.tool.dispatch(task);
    expect(await no.cloud.tool.approve("L-1", "me@example.org")).toBe(
      "Left as it was. Nothing was approved.",
    );
    expect(no.calls.some((c) => c.args[0] === "--cloud")).toBe(false);
    expect(no.asked[0]).toContain("Approve a cloud task?");
    const yes = rig({}, 0);
    await yes.cloud.tool.dispatch(task);
    expect(await yes.cloud.tool.approve("L-1", "someone@example.net")).toContain(
      "I cannot approve on someone@example.net",
    );
    expect(await yes.cloud.tool.approve("L-1", "me@example.org")).toBe(
      "Approved on me@example.org.",
    );
    expect(yes.calls.filter((c) => c.args[0] === "--cloud")).toHaveLength(1);
  });

  it("denies without running, and withdraws a waiting request", async () => {
    const { cloud, calls } = rig();
    await cloud.tool.dispatch(task);
    await cloud.tool.dispatch(task);
    await cloud.click("cl.deny.claude:L-1");
    expect(await cloud.tool.cancel("L-2")).toBe("Withdrawn.");
    expect(cloud.view().requests.map((r) => r.state)).toEqual(["denied", "cancelled"]);
    expect(calls.some((c) => c.args[0] === "--cloud")).toBe(false);
  });

  it("shows the Cloud page in plain words, with no jargon in the default setup", async () => {
    const { cloud } = rig();
    await cloud.refresh();
    const rows = cloudPageControls(cloud.view(), { ...DEFAULT_CLOUD, on: true });
    const text = JSON.stringify(rows);
    expect(text).toContain("Claude: signed in as me@example.org");
    expect(text).toContain("This computer");
    const visible = rows
      .flatMap((r) => [
        r.label,
        "hint" in r ? r.hint : "",
        "detail" in r ? r.detail : "",
        ...("options" in r ? r.options.map((o) => o.label) : []),
      ])
      .join(" ");
    for (const jargon of ["SSH", "forced command", "tailnet", "Tailscale", "key file"])
      expect(visible.includes(jargon)).toBe(false);
    expect(ids(rows)).not.toContain("cl.set.sshHost");
    expect(
      ids(cloudPageControls(cloud.view(), { ...DEFAULT_CLOUD, on: true, transport: "ssh" })),
    ).toContain("cl.set.sshHost");
    expect(ids(cloudPageControls(cloud.view(), DEFAULT_CLOUD))).toEqual([
      "cl.set.on",
      "setup.cloud.github",
      "setup.cloud.always",
      "cl.off",
    ]);
  });

  it("shows an assistant that reports no usage as unknown, never zero", async () => {
    const { cloud } = rig();
    await cloud.refresh();
    await cloud.tool.dispatch(task);
    await cloud.click("cl.p.claude:L-1:codex");
    const rows = approvalCardControls(cloud.view());
    const account = rows.find((r) => r.id.startsWith("cl.a.claude:L-1:"));
    expect(account).toMatchObject({ hint: "usage unknown" });
    expect(await cloud.tool.usage()).toContain("usage unknown");
  });

  it("with the pop-up on, asks one question with a button per open choice, then asks to confirm, then runs once", async () => {
    const { cloud, calls, asked } = rig({ askPopup: true }, [0, 0]);
    await cloud.tool.dispatch(task);
    await cloud.settled();
    expect(asked[0]).toContain("Cloud task waiting: Fix the flaky test");
    expect(asked[0]).toContain(
      "Claude - me@example.org (usage unknown) / Codex - This computer's Codex login (usage unknown) / Deny / Decide later",
    );
    expect(asked[1]).toContain("Approve on me@example.org?");
    expect(calls.filter((c) => c.args[0] === "--cloud")).toHaveLength(1);
    await cloud.refresh();
    await cloud.settled();
    expect(asked).toHaveLength(2);
  });

  it("with the pop-up on, Deny and Decide later run nothing, and Back asks again", async () => {
    const deny = rig({ askPopup: true }, [2]);
    await deny.cloud.tool.dispatch(task);
    await deny.cloud.settled();
    expect(deny.cloud.view().requests[0]!.state).toBe("denied");
    const later = rig({ askPopup: true }, [3]);
    await later.cloud.tool.dispatch(task);
    await later.cloud.settled();
    expect(later.cloud.view().requests[0]!.state).toBe("awaiting-director");
    const back = rig({ askPopup: true }, [0, 1, 3]);
    await back.cloud.tool.dispatch(task);
    await back.cloud.settled();
    expect(back.asked).toHaveLength(3);
    expect(back.calls.some((c) => c.args[0] === "--cloud")).toBe(false);
  });

  it("does not pop anything up while the setting is off", async () => {
    const { cloud, asked } = rig({}, 0);
    await cloud.tool.dispatch(task);
    await cloud.settled();
    expect(asked).toHaveLength(0);
  });

  it("through a hub: the other computer holds the logins and starts the work; this one only asks and shows the card", async () => {
    const hubCalls: string[] = [];
    const hubExec: Exec = async (_file, args) => {
      hubCalls.push(args.join(" "));
      return {
        code: 0,
        stderr: "",
        stdout:
          args[0] === "auth"
            ? '{"loggedIn":true,"email":"hub@example.org"}'
            : args[0] === "--cloud"
              ? "https://claude.ai/code/hub_1"
              : "",
      };
    };
    const providers = buildLocalProviders(
      hubExec,
      fileStores(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hub-"))),
      {},
    );
    const localExec: Exec = async () => {
      throw new Error("the local computer must not run the harness");
    };
    const cloud = createCloud({
      settings: () => ({ ...DEFAULT_CLOUD, on: true, transport: "hub", hubEnv: "env-2" }),
      exec: localExec,
      dir: NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cloud-")),
      hub: (op, provider, args) => serveCloudCall(providers, { op, provider, args }),
      environments: async () => [{ id: "env-2", label: "Workshop" }],
      ask: async (q) => q.cancel,
      changed: () => undefined,
      now: () => 1,
    });
    await cloud.tool.dispatch(task);
    expect(cloud.view().environments).toEqual([{ id: "env-2", label: "Workshop" }]);
    const picker = cloudPageControls(cloud.view(), {
      ...DEFAULT_CLOUD,
      on: true,
      transport: "hub",
      hubEnv: "env-2",
    }).find((r) => r.id === "cl.set.hubEnv");
    expect(picker).toMatchObject({ kind: "choice", value: "env-2" });
    expect(picker?.kind === "choice" && picker.options.map((o) => o.label)).toEqual([
      "The one this window is on",
      "Workshop",
    ]);
    await cloud.click("cl.p.claude:L-1:claude");
    await cloud.click("cl.a.claude:L-1:hub@example.org");
    expect(hubCalls.some((c) => c.startsWith("--cloud"))).toBe(false);
    await cloud.click("cl.ok.claude:L-1");
    expect(hubCalls.filter((c) => c.startsWith("--cloud"))).toHaveLength(1);
    expect(cloud.view().requests[0]).toMatchObject({
      state: "running",
      account: "hub@example.org",
    });
  });

  it("says plainly when there is no connection to the hub", async () => {
    const cloud = createCloud({
      settings: () => ({ ...DEFAULT_CLOUD, on: true, transport: "hub" }),
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      dir: NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cloud-")),
      hub: null,
      ask: async (q) => q.cancel,
      changed: () => undefined,
      now: () => 1,
    });
    await cloud.refresh();
    expect(cloud.view().error).toBe("There is no connection to a computer that runs cloud tasks.");
    expect(await cloud.tool.dispatch(task)).toContain("No cloud provider is ready");
  });

  it("tests the connection: each account with its use and login, starts nothing, and says why when nothing answers", async () => {
    const { cloud, calls } = rig();
    await cloud.test();
    const lines = cloud.view().tested!;
    expect(lines.map((l) => l.line)).toEqual([
      "The connection works.",
      "Claude me@example.org: usage unknown",
      "Codex This computer's Codex login: usage unknown",
    ]);
    expect(lines[0]).toEqual({ ok: true, line: "The connection works." });
    expect(calls.some((c) => c.args[0] === "--cloud" || c.args[1] === "exec")).toBe(false);
    const rows = cloudPageControls(cloud.view(), { ...DEFAULT_CLOUD, on: true });
    expect(ids(rows)).toContain("cl.test");
    expect(ids(rows).filter((i) => i.startsWith("cl.testrow."))).toHaveLength(lines.length);
    const down = createCloud({
      settings: () => ({ ...DEFAULT_CLOUD, on: true, transport: "hub" }),
      exec: async () => ({ code: 0, stdout: "", stderr: "" }),
      dir: NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cloud-")),
      hub: null,
      ask: async (q) => q.cancel,
      changed: () => undefined,
      now: () => 1,
    });
    await down.test();
    expect(down.view().tested).toEqual([
      {
        ok: false,
        line: "Nothing answered. There is no connection to a computer that runs cloud tasks.",
      },
    ]);
  });
});

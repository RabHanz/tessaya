// @effect-diagnostics nodeBuiltinImport:off
/**
 * The Memory tab's state and actions (D150): what the server holds, what he is looking at, and what
 * each button does. The window only draws `controls()` and reports clicks to `act`. When the server
 * does not answer, his plain notes folder is shown as before, so the tab is never empty by accident.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { MemoryItem, MemoryVersion } from "@t3tools/tessaya-shared/memory";

import type { HomeControl } from "../home/batonHome.ts";
import type { MemoryCall } from "./memoryClient.ts";
import type { MemorySync, SyncPeer } from "./memorySync.ts";
import { memoryControls, memoryIdOf } from "./memoryRows.ts";
import { noteControls } from "./noteRows.ts";
import type { NotesStore } from "./memoryNotes.ts";

const reason = (error: unknown): string =>
  error instanceof Error ? error.message : "That did not work.";

export const createMemoryTab = (input: {
  readonly call: MemoryCall;
  readonly sync: MemorySync;
  readonly notes: NotesStore;
  readonly stateDir: string;
  readonly refresh: () => void;
  /** Show a file he can open. */
  readonly reveal: (path: string) => void;
}) => {
  let items: ReadonlyArray<MemoryItem> | null = null;
  let usedIds: ReadonlySet<string> = new Set();
  let query = "";
  let filter = "all";
  let usedOnly = false;
  let status = "";
  let loading = false;
  let pullOn = false;
  let peers: ReadonlyArray<SyncPeer> = [];
  let history: { readonly id: string; readonly versions: ReadonlyArray<MemoryVersion> } | null =
    null;
  const loadHistory = async (id: string): Promise<void> => {
    try {
      const out = (await input.call("history", { id, admin: true })) as {
        versions?: ReadonlyArray<MemoryVersion>;
      } | null;
      history = { id, versions: out?.versions ?? [] };
    } catch (error) {
      status = reason(error);
    }
    input.refresh();
  };

  const load = async (): Promise<void> => {
    if (loading) return;
    loading = true;
    try {
      // His own view: the server honours it only from the desktop app's own session.
      const listed = (await input.call("list", {
        admin: true,
        includeSuperseded: true,
        includeProposed: true,
        limit: 2_000,
      })) as { items?: ReadonlyArray<MemoryItem> } | null;
      items = listed?.items ?? [];
      const used = (await input.call("used", {}).catch(() => null)) as {
        items?: ReadonlyArray<MemoryItem>;
      } | null;
      usedIds = new Set((used?.items ?? []).map((i) => i.id));
      peers = input.sync.enabled() ? await input.sync.peers().catch(() => []) : [];
      pullOn =
        (
          (await input.call("pull", { action: "status" }).catch(() => null)) as {
            enabled?: boolean;
          } | null
        )?.enabled === true;
    } catch {
      items = null;
    } finally {
      loading = false;
      input.refresh();
    }
  };

  /** Runs one server call, says how it went, and draws the new state. */
  const run = async (op: string, args: Record<string, unknown>, done: string): Promise<void> => {
    try {
      await input.call(op, args);
      status = done;
    } catch (error) {
      status = reason(error);
    }
    await load();
  };

  const act = (id: string, value: string | boolean | null): boolean => {
    const text = typeof value === "string" ? value : "";
    let target: string | null;
    if (id === "m.query") {
      query = text;
      input.refresh();
    } else if (id === "m.kind") {
      filter = text === "" ? "all" : text;
      input.refresh();
    } else if (id === "m.used") {
      usedOnly = value === true;
      input.refresh();
    } else if (id === "m.export") {
      void input
        .call("export", {})
        .then((out) => {
          const file = NodePath.join(input.stateDir, "memory-export.md");
          NodeFS.writeFileSync(file, (out as { markdown?: string }).markdown ?? "");
          status = `Saved to ${file}`;
          input.reveal(file);
        })
        .catch((error: unknown) => void (status = reason(error)))
        .finally(input.refresh);
    } else if (id === "m.import") {
      if (text.trim() === "") return true;
      void input
        .call("import", { folder: text.trim() })
        .then((out) => {
          const r = out as { files: number; added: number; refused: number; unchanged: number };
          status = `Read ${r.files} files: ${r.added} added, ${r.unchanged} unchanged, ${r.refused} not kept.`;
        })
        .catch((error: unknown) => void (status = reason(error)))
        .then(load);
    } else if (id === "m.syncOn") {
      void input.sync
        .setEnabled(value === true)
        .then(() => void (status = value === true ? "Sync is on." : "Sync is off."))
        .catch((error: unknown) => void (status = reason(error)))
        .finally(input.refresh);
    } else if (id === "m.pullOn") {
      void run(
        "pull",
        { action: value === true ? "enable" : "disable" },
        value === true
          ? "Pulling learnings daily; they wait for your yes."
          : "Not pulling learnings.",
      );
    } else if (id === "m.pull") {
      void input
        .call("pull", { action: "run" })
        .then((out) => void (status = (out as { message: string }).message))
        .catch((e: unknown) => void (status = reason(e)))
        .then(load);
    } else if (id === "m.syncPair") {
      void input.sync
        .issue()
        .then(
          (code) =>
            void (status = `On the other machine, in its Memory tab, enter ${code} in this server's row. It works once, within five minutes.`),
        )
        .catch((error: unknown) => void (status = reason(error)))
        .finally(input.refresh);
    } else if ((target = memoryIdOf(id, "m.syncLink")) !== null) {
      if (text.trim() === "") return true;
      void input.sync
        .link(target, text.trim())
        .then(
          () =>
            void (status =
              "Paired: its walled memory now syncs too, and this server can search its history index."),
        )
        .catch((error: unknown) => void (status = reason(error)))
        .then(load);
    } else if ((target = memoryIdOf(id, "m.syncForget")) !== null) {
      void input.sync
        .forget(target)
        .then(
          () =>
            void (status =
              'Stopped here. To end it there too, revoke "Tessaya memory sync" in that server\'s Sharing & access.'),
        )
        .catch((error: unknown) => void (status = reason(error)))
        .then(load);
    } else if (id === "m.sync") {
      void input.sync
        .run()
        .then((line) => void (status = line))
        .then(load);
    } else if ((target = memoryIdOf(id, "m.history")) !== null) {
      // The same button closes it.
      if (history?.id === target) {
        history = null;
        input.refresh();
      } else void loadHistory(target);
    } else if ((target = memoryIdOf(id, "m.restore")) !== null) {
      const at = target.lastIndexOf(":");
      const itemId = target.slice(0, at);
      const version = Number(target.slice(at + 1));
      if (itemId === "" || !Number.isInteger(version)) return true;
      void run(
        "restore",
        { id: itemId, version },
        `Restored version ${version} as the newest.`,
      ).then(() => loadHistory(itemId));
    } else if ((target = memoryIdOf(id, "m.edit")) !== null) {
      void run("edit", { id: target, text }, "Saved.");
    } else if ((target = memoryIdOf(id, "m.pin")) !== null) {
      void run(
        "pin",
        { id: target, pinned: value === true },
        value === true ? "Pinned." : "Unpinned.",
      );
    } else if ((target = memoryIdOf(id, "m.forget")) !== null) {
      void run("forget", { id: target }, "Forgotten.");
    } else if ((target = memoryIdOf(id, "m.household")) !== null) {
      void run("edit", { id: target, visibility: "household" }, "Every persona can recall it now.");
    } else if ((target = memoryIdOf(id, "m.accept")) !== null) {
      void run("accept", { id: target }, "Kept.");
    } else return false;
    return true;
  };

  return {
    /** Opening the tab reads the server; it is read again after every change. */
    load,
    act,
    /** How many live memories, once the server has answered. */
    count: (): number | null =>
      items === null ? null : items.filter((i) => i.supersededBy === null && !i.proposed).length,
    controls: (): ReadonlyArray<HomeControl> =>
      items === null
        ? noteControls(input.notes.list())
        : memoryControls({
            items,
            query,
            filter,
            usedIds,
            usedOnly,
            syncOn: input.sync.enabled(),
            peers,
            pullOn,
            status,
            history,
          }),
  };
};

export type MemoryTab = ReturnType<typeof createMemoryTab>;

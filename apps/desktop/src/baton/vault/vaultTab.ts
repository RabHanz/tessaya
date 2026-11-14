// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
/**
 * The Vault tab's state and actions (D151). The window draws `controls()` and reports clicks to `act`.
 * A value reaches the window only when he asks to reveal it, only after Windows Hello where it exists,
 * and only for fifteen seconds.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  VAULT_CATEGORIES,
  auditLine,
  type VaultCategory,
  type VaultPolicy,
} from "@t3tools/tessaya-shared/vault";

import type { HomeControl } from "../home/batonHome.ts";
import { CLIPBOARD_CLEAR_MS } from "./vaultHost.ts";
import type { HelloResult } from "./hello.ts";
import { VaultError, type Vault } from "./vaultStore.ts";

export const REVEAL_MS = 15_000;

const reason = (e: unknown): string =>
  e instanceof VaultError || e instanceof Error ? e.message : "That did not work.";

export const createVaultTab = (input: {
  readonly vault: Vault;
  readonly hello: (message: string) => Promise<HelloResult>;
  readonly clipboard: {
    readonly read: () => string | Promise<string>;
    readonly write: (t: string) => void;
    readonly clear: () => void;
  };
  readonly audit: (line: string) => void;
  readonly readAudit: () => ReadonlyArray<string>;
  readonly stateDir: string;
  readonly refresh: () => void;
  readonly reveal: (path: string) => void;
  /** Asks where to save the recovery key and writes it there; the path, or null if he cancelled. */
  readonly saveRecovery?: (key: string) => Promise<string | null>;
  /** Prints the recovery key; true if it went to a printer. */
  readonly printRecovery?: (key: string) => Promise<boolean>;
  readonly now?: () => number;
}) => {
  const now = input.now ?? Date.now;
  let status = "";
  let recovery: string | null = null;
  let helloOk = true;
  let shown: { id: string; value: string } | null = null;
  let hideTimer: ReturnType<typeof setTimeout> | undefined;
  let copied: string | null = null;

  const note = (name: string, how: string, outcome: "revealed" | "copied") =>
    input.audit(
      auditLine({
        at: new Date(now()).toISOString(),
        name,
        purpose: "himself",
        target: "vault window",
        how,
        outcome,
      }),
    );
  const hide = () => {
    shown = null;
    clearTimeout(hideTimer);
  };
  /** Clears the clipboard only if it still holds what the vault put there. */
  const clearCopied = () => {
    const mine = copied;
    copied = null;
    if (mine !== null)
      void Promise.resolve(input.clipboard.read()).then((now) => {
        if (now === mine) input.clipboard.clear();
      });
  };
  const say = (s: string) => {
    status = s;
    input.refresh();
  };
  const guard = (f: () => void): void => {
    try {
      f();
    } catch (e) {
      status = reason(e);
    }
    input.refresh();
  };
  /** Hello where this computer has it; where it does not, being unlocked already is the proof. */
  const confirmed = async (message: string): Promise<boolean> => {
    const r = await input.hello(message);
    helloOk = r !== "unavailable";
    return r === "verified" || r === "unavailable";
  };

  const act = (id: string, value: string | boolean | null): boolean => {
    const text = typeof value === "string" ? value : "";
    let target: string | null;
    const after = (id2: string) => (id.startsWith(`${id2}:`) ? id.slice(id2.length + 1) : null);
    if (id === "vt.create") {
      guard(() => void (recovery = input.vault.create(text).recoveryKey));
    } else if (id === "vt.recoverySave" || id === "vt.recoveryPrint") {
      const key = recovery;
      const task =
        key === null
          ? undefined
          : id === "vt.recoverySave"
            ? input
                .saveRecovery?.(key)
                .then((p) => (p === null ? "" : `Saved to ${p}. Keep it off this computer.`))
            : input.printRecovery?.(key).then((ok) => (ok ? "Sent to the printer." : ""));
      void (task ?? Promise.resolve("That is not available here."))
        .then((m) => void (status = m))
        .catch((e: unknown) => void (status = reason(e)))
        .finally(input.refresh);
    } else if (id === "vt.recoveryDone") {
      recovery = null;
      input.refresh();
    } else if (id === "vt.unlock") {
      guard(() => {
        input.vault.unlockWithPassphrase(text);
        status = "";
      });
    } else if (id === "vt.unlockRecovery") {
      guard(() => {
        input.vault.unlockWithRecovery(text);
        status = "";
      });
    } else if (id === "vt.unlockHello") {
      void input.vault
        .unlockWithOs(() => confirmed("Unlock the Tessaya vault").then((ok) => ok && helloOk))
        .then(() => void (status = ""))
        .catch((e: unknown) => void (status = reason(e)))
        .finally(input.refresh);
    } else if (id === "vt.lock") {
      hide();
      input.vault.lock();
      input.refresh();
    } else if (id === "vt.add") {
      guard(() => {
        const f = JSON.parse(text) as {
          name: string;
          label: string;
          category: string;
          value: string;
        };
        const category = (VAULT_CATEGORIES as ReadonlyArray<string>).includes(f.category)
          ? (f.category as VaultCategory)
          : "key";
        input.vault.add({ name: f.name, label: f.label, category, value: f.value });
        status = `Saved ${f.name}.`;
      });
    } else if ((target = after("vt.reveal")) !== null) {
      void confirmed("Show a secret from the Tessaya vault")
        .then((ok) => {
          const item = ok ? input.vault.valueOf(target!) : null;
          if (item === null)
            return say(
              ok ? "There is no such secret." : "Windows Hello did not confirm it is you.",
            );
          shown = { id: item.id, value: item.value };
          clearTimeout(hideTimer);
          hideTimer = setTimeout(() => {
            hide();
            input.refresh();
          }, REVEAL_MS);
          hideTimer.unref();
          note(item.name, "reveal", "revealed");
          input.refresh();
        })
        .catch((e: unknown) => say(reason(e)));
    } else if ((target = after("vt.copy")) !== null) {
      void confirmed("Copy a secret from the Tessaya vault")
        .then((ok) => {
          const item = ok ? input.vault.valueOf(target!) : null;
          if (item === null)
            return say(
              ok ? "There is no such secret." : "Windows Hello did not confirm it is you.",
            );
          input.clipboard.write(item.value);
          copied = item.value;
          setTimeout(() => clearCopied(), CLIPBOARD_CLEAR_MS).unref();
          note(item.name, "copy", "copied");
          say("Copied. It clears from the clipboard in 10 seconds.");
        })
        .catch((e: unknown) => say(reason(e)));
    } else if ((target = after("vt.policy")) !== null) {
      guard(() => {
        const policy: VaultPolicy = text.startsWith("domain:")
          ? { mode: "domain", minutes: Math.min(240, Math.max(1, Number(text.slice(7)) || 10)) }
          : text === "never"
            ? { mode: "never" }
            : { mode: "ask" };
        input.vault.update(target!, { policy });
      });
    } else if ((target = after("vt.delete")) !== null) {
      guard(() => {
        if (shown?.id === target) hide();
        status = input.vault.remove(target!) ? "Deleted." : "There is no such secret.";
      });
    } else if (id === "vt.export") {
      guard(() => {
        const file = NodePath.join(input.stateDir, "vault-export.json");
        NodeFS.writeFileSync(file, input.vault.exportBlob(text), { mode: 0o600 });
        status = `Saved the encrypted export to ${file}`;
        input.reveal(file);
      });
    } else if (id === "vt.import") {
      guard(() => {
        const f = JSON.parse(text) as { path: string; passphrase: string };
        const added = input.vault.importBlob(NodeFS.readFileSync(f.path, "utf8"), f.passphrase);
        status = `Added ${added} secrets.`;
      });
    } else return false;
    return true;
  };

  return {
    act,
    /** Locking, however it happens, closes any value on show, clears what we copied and redraws at once. */
    onLock: () => {
      hide();
      clearCopied();
      input.refresh();
    },
    controls: (): ReadonlyArray<HomeControl> => {
      const unlocked = input.vault.isUnlocked();
      const bar: HomeControl = {
        id: "vt.bar",
        section: "Vault",
        label: "Vault",
        kind: "vaultBar",
        state: !input.vault.exists() ? "none" : unlocked ? "unlocked" : "locked",
        status,
        recovery,
        hello: helloOk,
        activity: input.readAudit().slice(-15).toReversed(),
      };
      if (!unlocked) return [bar];
      return [
        bar,
        ...input.vault.list().map((i): HomeControl => ({
          id: `vt:${i.id}`,
          section: "Secrets",
          label: i.name,
          hint: `${i.label === "" ? i.category : i.label} · ${i.category} · ${
            i.policy.mode === "self"
              ? "you type it yourself"
              : i.policy.mode === "never"
                ? "only you may use it"
                : i.policy.mode === "domain"
                  ? `allowed for a site for ${i.policy.minutes} minutes after a yes`
                  : "asks you each time"
          }`,
          kind: "vaultItem",
          policy: i.policy.mode === "domain" ? `domain:${i.policy.minutes}` : i.policy.mode,
          locked: i.policy.mode === "self",
          revealed: shown?.id === i.id ? shown.value : null,
        })),
      ];
    },
  };
};

export type VaultTab = ReturnType<typeof createVaultTab>;

// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off
/**
 * What the assistant can do with the vault (D151): list names, use a secret without seeing it, and file a
 * secret it was just told about. The value goes from the vault to the action; the model gets a sentence.
 */
import * as NodeChildProcess from "node:child_process";

import {
  VAULT_CATEGORIES,
  auditLine,
  grantKey,
  scrubText,
  useDecision,
  type VaultAuditEntry,
  type VaultCategory,
} from "@t3tools/tessaya-shared/vault";

import type { HelloResult } from "./hello.ts";
import { pendingSecret, type PendingSecret } from "./pendingSecret.ts";
import type { Vault } from "./vaultStore.ts";

export const CLIPBOARD_CLEAR_MS = 10_000;
const COMMAND_MS = 60_000;
const OUTPUT_MAX = 20_000;

export interface VaultHostPorts {
  readonly vault: Vault;
  /** The yes/no he gives, spoken or on screen. Shows name, purpose and target; never the value. Default answer is no. */
  readonly confirm: (title: string, detail: string) => Promise<boolean>;
  /** Types into the focused field. */
  readonly type: (text: string) => Promise<void>;
  readonly clipboard: {
    readonly read: () => string | Promise<string>;
    readonly write: (text: string) => void;
    readonly clear: () => void;
  };
  /** This turn read something from outside. */
  readonly tainted: () => boolean;
  readonly audit: (line: string) => void;
  /** Brings the Vault tab forward so he can unlock it. */
  readonly askToUnlock: () => void;
  /** The device's own check that it is him (Windows Hello), after his yes and before the value leaves the vault. */
  readonly hello?: (message: string) => Promise<HelloResult>;
  readonly now?: () => number;
  readonly pending?: PendingSecret;
  /** Runs one command with extra environment; the default is a child process. */
  readonly run?: (command: string, env: Record<string, string>) => Promise<string>;
}

const runCommand = (command: string, env: Record<string, string>): Promise<string> =>
  new Promise((resolve) => {
    NodeChildProcess.exec(
      command,
      {
        env: { ...process.env, ...env },
        timeout: COMMAND_MS,
        maxBuffer: OUTPUT_MAX * 4,
        windowsHide: true,
      },
      (error, stdout, stderr) =>
        resolve(
          `${stdout}${stderr}${error === null ? "" : `\n(exit ${error.code ?? "error"})`}`.slice(
            0,
            OUTPUT_MAX,
          ),
        ),
    );
  });

export const createVaultHost = (ports: VaultHostPorts) => {
  const now = ports.now ?? Date.now;
  const grants = new Map<string, number>();
  const pending = ports.pending ?? pendingSecret;

  const note = (e: Omit<VaultAuditEntry, "at">) =>
    ports.audit(auditLine({ at: new Date(now()).toISOString(), ...e }));
  const locked = () => {
    ports.askToUnlock();
    return "The vault is locked. I opened the Vault tab; he can unlock it there, then ask again.";
  };

  return {
    /** Names, labels, categories and policies; never a value. */
    list: async (): Promise<string> => {
      if (!ports.vault.isUnlocked())
        return ports.vault.exists()
          ? locked()
          : "There is no vault yet. He can make one in the Vault tab.";
      const items = ports.vault.list();
      return items.length === 0
        ? "The vault is empty."
        : items
            .map(
              (i) =>
                `${i.name}: ${i.label || i.category} (${i.category}, ${i.policy.mode === "self" ? "he types it himself" : i.policy.mode === "never" ? "only he may use it" : "asks him first"})`,
            )
            .join("\n");
    },

    use: async (args: {
      readonly name: string;
      readonly purpose: string;
      readonly target: string;
      readonly how: "type" | "paste" | "env";
      readonly command?: string | undefined;
      readonly envName?: string | undefined;
    }): Promise<string> => {
      if (!ports.vault.isUnlocked()) return locked();
      const item = ports.vault.valueOf(args.name);
      const entry = { name: args.name, purpose: args.purpose, target: args.target, how: args.how };
      if (item === null)
        return `There is no secret called ${args.name}. Use vault_list for the names.`;
      const decision = useDecision({
        item,
        target: args.target,
        grants,
        now: now(),
        tainted: ports.tainted(),
      });
      if (decision.kind === "refuse") {
        note({ ...entry, outcome: "refused" });
        return decision.why;
      }
      if (decision.kind === "ask") {
        const yes = await ports.confirm(
          `Use ${item.name}?`,
          `Purpose: ${args.purpose}\nWhere: ${args.target}\nHow: ${args.how === "type" ? "type it into the focused field" : args.how === "paste" ? "put it on the clipboard for 10 seconds" : "give it to one command"}${ports.tainted() ? "\n\nThis follows something I read, so I am asking." : ""}\n\nYou will not see it and neither will I.`,
        );
        const verified = yes
          ? ((await ports.hello?.(`Let Tessaya use ${item.name} for ${args.target}`)) ??
            "unavailable")
          : "declined";
        if (!yes || verified === "declined") {
          note({ ...entry, outcome: "declined" });
          return yes
            ? "Windows Hello did not confirm it is him. Nothing was used."
            : "He said no. Nothing was used.";
        }
        if (item.policy.mode === "domain")
          grants.set(grantKey(item.name, args.target), now() + item.policy.minutes * 60_000);
      }
      try {
        let said: string;
        if (args.how === "type") {
          await ports.type(item.value);
          said = `Typed ${item.name} into the focused field.`;
        } else if (args.how === "paste") {
          ports.clipboard.write(item.value);
          setTimeout(() => {
            void Promise.resolve(ports.clipboard.read()).then((now) => {
              if (now === item.value) ports.clipboard.clear();
            });
          }, CLIPBOARD_CLEAR_MS).unref();
          said = `${item.name} is on the clipboard and will be cleared in 10 seconds. Paste it now.`;
        } else {
          if (args.command === undefined || args.command.trim() === "")
            return "Say which command to run.";
          const envName = /^[A-Z_][A-Z0-9_]{0,63}$/.test(args.envName ?? "")
            ? args.envName!
            : "SECRET";
          const out = await (ports.run ?? runCommand)(args.command, { [envName]: item.value });
          said = `Ran it with ${item.name} as ${envName}. Output (secrets removed):\n${scrub(out)}`;
        }
        note({ ...entry, outcome: "used" });
        return said;
      } catch (error) {
        note({ ...entry, outcome: "failed" });
        return scrub(error instanceof Error ? error.message : "That did not work.");
      }
    },

    /** The text a secret was said in, held here and nowhere else, for a yes to file it. */
    offer: (text: string, what: string): string => {
      pending.set(text, now());
      return `That looks like ${what}. Want it in the vault? If he says yes, call vault_save_pending with a short name. It has not been kept anywhere.`;
    },
    hasPending: (): boolean => pending.peek(now()) !== null,

    savePending: async (name: string, category: string): Promise<string> => {
      const text = pending.peek(now());
      if (text === null) return "There is no secret waiting to be filed.";
      if (!ports.vault.isUnlocked()) return locked();
      const cat = (VAULT_CATEGORIES as ReadonlyArray<string>).includes(category)
        ? (category as VaultCategory)
        : "key";
      try {
        ports.vault.add({ name, label: "", category: cat, value: text });
      } catch (error) {
        return error instanceof Error ? error.message : "It could not be saved.";
      }
      pending.clear();
      note({
        name,
        purpose: "saved from a conversation",
        target: "vault",
        how: "save",
        outcome: "saved",
      });
      return `Filed as ${name}. It is only in the vault now.`;
    },

    /** Replaces any vault value in text headed for the model, a log or History. */
    scrub,
  };

  function scrub(text: string): string {
    return scrubText(text, ports.vault.secrets());
  }
};

export type VaultHost = ReturnType<typeof createVaultHost>;

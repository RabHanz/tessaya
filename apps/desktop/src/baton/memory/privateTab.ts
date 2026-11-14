// @effect-diagnostics globalTimers:off globalDate:off
/**
 * The People area's state and actions: private stores, each under its PIN. The window draws `controls()` and reports
 * clicks to `act`. A PIN only passes through to the server; what a store holds stays in memory here while it is open
 * and on show, and goes when it locks, when another store is picked, or when the tab closes.
 */
import type { BatonPrivateStore } from "@t3tools/tessaya-contracts";
import type { MemoryItem } from "@t3tools/tessaya-shared/memory";

import type { HomeControl } from "../home/batonHome.ts";
import { text } from "../home/strings.ts";
import type { HelloResult } from "../vault/hello.ts";
import type { PrivateMemory } from "./privateMemoryClient.ts";
import {
  EVERYDAY,
  openNow,
  privateControls,
  storeName,
  type PrivateAuditRow,
} from "./privateRows.ts";

/** A copied recovery code leaves the clipboard after this, if it is still there. */
export const RECOVERY_CLIPBOARD_MS = 30_000;

/** A recovery code (groups of four, dashed); after a restore on another computer only it opens a store, so only it sets a new PIN. */
const RECOVERY_SHAPE = /^[a-z0-9]{4}(-[a-z0-9]{1,4}){8,}$/i;

const reason = (e: unknown): string => (e instanceof Error ? e.message : text("pv.failed"));

const parse = (value: string): Record<string, string> => {
  try {
    const out = JSON.parse(value) as unknown;
    return typeof out === "object" && out !== null ? (out as Record<string, string>) : {};
  } catch {
    return {};
  }
};

const slug = (name: string) =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "") || "store";

export const createPrivateTab = (input: {
  readonly memory: Pick<PrivateMemory, "call" | "people" | "onLocked">;
  readonly hello: (message: string) => Promise<HelloResult>;
  readonly clipboard: {
    readonly read: () => string | Promise<string>;
    readonly write: (t: string) => void;
    readonly clear: () => void;
  };
  /** Asks where to save it and writes it there; the path, or null if he cancelled. */
  readonly saveFile: (name: string, contents: string) => Promise<string | null>;
  readonly everydayCount: () => number | null;
  /** The people Voice ID has saved (Settings > Voice). */
  readonly voices?: () => ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly refresh: () => void;
  /** Face check: someone besides the person checked is in view, so what is in the store stays hidden. */
  readonly onlooker?: () => Promise<boolean>;
  readonly now?: () => number;
}) => {
  const now = input.now ?? Date.now;
  let stores: ReadonlyArray<BatonPrivateStore> | null = null;
  let selected = EVERYDAY;
  let items: { readonly store: string; readonly list: ReadonlyArray<MemoryItem> } | null = null;
  let audit: {
    readonly store: string;
    readonly intact: boolean;
    readonly rows: ReadonlyArray<PrivateAuditRow>;
  } | null = null;
  let query = "";
  let status = "";
  let recovery: { readonly name: string; readonly code: string } | null = null;
  let confirmDelete = false;
  const admin = new Set<string>();
  // Bumped whenever what was read is dropped, so a read still on its way is not kept.
  let epoch = 0;

  const drop = () => {
    epoch++;
    items = null;
    audit = null;
    query = "";
    confirmDelete = false;
  };
  const storeOf = (id: string) => stores?.find((s) => s.id === id);

  const readAudit = async (store: BatonPrivateStore) => {
    const out = (await input.memory.call(
      "audit",
      store.kind === "owner" ? {} : { storeId: store.id },
    )) as { intact: boolean; rows: ReadonlyArray<PrivateAuditRow> };
    return { store: store.id, intact: out.intact, rows: out.rows };
  };

  const load = async (): Promise<void> => {
    try {
      stores = await input.memory.people();
    } catch {
      stores = null;
      drop();
      input.refresh();
      return;
    }
    const store = storeOf(selected);
    if (store === undefined) {
      selected = EVERYDAY;
      drop();
    } else if (!openNow(store, now())) {
      admin.delete(store.id);
      drop();
    } else if ((await input.onlooker?.()) === true) {
      status = text("pv.onlooker");
      drop();
    } else {
      const at = epoch;
      try {
        const out = (await input.memory.call("list", {
          storeId: store.id,
          ...(store.kind === "owner" ? { includeProposed: true } : {}),
        })) as { items: ReadonlyArray<MemoryItem> };
        const log = audit?.store === store.id ? await readAudit(store) : null;
        if (at === epoch) {
          items = { store: store.id, list: out.items };
          if (log !== null) audit = log;
        }
      } catch (e) {
        status = reason(e);
        drop();
      }
    }
    input.refresh();
  };

  /** Runs one server call, says how it went, and reads the stores again. */
  const run = async (op: string, args: Record<string, unknown>, done: string): Promise<void> => {
    try {
      await input.memory.call(op, args);
      status = done;
    } catch (e) {
      status = reason(e);
    }
    await load();
  };

  const open = async (storeId: string, args: Record<string, string>): Promise<void> => {
    try {
      // His store opens every other: on Windows, Hello confirms it is him first; where it is not set up, the PIN alone.
      if (
        storeOf(storeId)?.kind === "owner" &&
        (await input.hello(text("pv.hello"))) === "declined"
      ) {
        status = text("pv.hello.no");
        return input.refresh();
      }
      await input.memory.call("unlock", { storeId, ...args });
      admin.delete(storeId);
      status = "";
    } catch (e) {
      status = reason(e);
    }
    await load();
  };

  const made = async (args: Record<string, string>, name: string, asAdmin: boolean) => {
    try {
      const out = (await input.memory.call("setup", args)) as {
        store: BatonPrivateStore;
        recoveryCode: string;
      };
      recovery = { name, code: out.recoveryCode };
      drop();
      selected = out.store.id;
      if (asAdmin) admin.add(out.store.id);
      status = "";
    } catch (e) {
      status = reason(e);
    }
    await load();
  };

  const act = (id: string, value: string | boolean | null): boolean => {
    if (!id.startsWith("m.pv.")) return false;
    const textValue = typeof value === "string" ? value : "";
    const after = (prefix: string) =>
      id.startsWith(`m.pv.${prefix}:`) ? id.slice(prefix.length + 6) : null;
    /** `<storeId>/<itemId>`: a store id is a UUID, so the first slash splits them. */
    const itemOf = (prefix: string) => {
      const ref = after(prefix);
      const at = ref?.indexOf("/") ?? -1;
      return ref === null || at < 1 ? null : { storeId: ref.slice(0, at), id: ref.slice(at + 1) };
    };
    let target: string | null;
    let item: { storeId: string; id: string } | null;
    if ((target = after("pick")) !== null) {
      drop();
      selected = target;
      status = "";
      void load();
    } else if ((target = after("unlock")) !== null) {
      if (textValue !== "") void open(target, { pin: textValue });
    } else if ((target = after("recover")) !== null) {
      if (textValue.trim() !== "") void open(target, { recoveryCode: textValue.trim() });
    } else if ((target = after("admin")) !== null) {
      const storeId = target;
      void input.memory
        .call("unlock", { storeId })
        .then(() => {
          admin.add(storeId);
          status = "";
        })
        .catch((e: unknown) => void (status = reason(e)))
        .then(load);
    } else if (id === "m.pv.setup") {
      const f = parse(textValue);
      if (f.pin !== f.again) {
        status = text("pv.pins.differ");
        input.refresh();
      } else void made({ name: text("pv.owner"), pin: f.pin ?? "" }, text("pv.owner"), false);
    } else if (id === "m.pv.addPerson") {
      const f = parse(textValue);
      const personId = (f.personId ?? "").trim();
      // Their name as Voice ID saved it, unless he typed another.
      const name =
        (f.name ?? "").trim() || (input.voices?.().find((v) => v.id === personId)?.name ?? "");
      if (name === "" || personId === "") status = text("pv.add.missing");
      else if (f.pin !== f.again) status = text("pv.pins.differ");
      else {
        void made({ personId, name, pin: f.pin ?? "" }, name, true);
        return true;
      }
      input.refresh();
    } else if (id === "m.pv.recoverySave") {
      const r = recovery;
      if (r === null) return true;
      void input
        .saveFile(
          `tessaya-recovery-${slug(r.name)}.txt`,
          `${text("pv.recovery.file", { name: r.name })}\n\n${r.code}\n`,
        )
        .then((path) => void (status = path === null ? "" : text("pv.recovery.saved", { path })))
        .catch((e: unknown) => void (status = reason(e)))
        .finally(input.refresh);
    } else if (id === "m.pv.recoveryCopy") {
      const code = recovery?.code;
      if (code === undefined) return true;
      input.clipboard.write(code);
      setTimeout(() => {
        void Promise.resolve(input.clipboard.read()).then((held) => {
          if (held === code) input.clipboard.clear();
        });
      }, RECOVERY_CLIPBOARD_MS).unref();
      status = text("pv.recovery.copied");
      input.refresh();
    } else if (id === "m.pv.recoveryDone") {
      recovery = null;
      status = "";
      input.refresh();
    } else if ((target = after("lock")) !== null) {
      admin.delete(target);
      drop();
      void run("lock", { storeId: target }, text("pv.locked.now"));
    } else if (id === "m.pv.query") {
      query = textValue;
      input.refresh();
    } else if ((target = after("export")) !== null) {
      const store = storeOf(target);
      if (store === undefined) return true;
      // A PIN again even while open; a store he opened as admin exports with his own open store.
      void input.memory
        .call("export", { storeId: target, ...(textValue === "" ? {} : { pin: textValue }) })
        .then((out) =>
          input.saveFile(
            `tessaya-private-${slug(storeName(store))}.md`,
            (out as { markdown: string }).markdown,
          ),
        )
        .then((path) => void (status = path === null ? "" : text("pv.export.saved", { path })))
        .catch((e: unknown) => void (status = reason(e)))
        .finally(input.refresh);
    } else if ((target = after("changePin")) !== null) {
      const f = parse(textValue);
      if (f.newPin !== f.again) {
        status = text("pv.pins.differ");
        input.refresh();
      } else
        void run(
          "changePin",
          {
            storeId: target,
            ...(RECOVERY_SHAPE.test(f.pin ?? "") ? { recoveryCode: f.pin } : { pin: f.pin ?? "" }),
            newPin: f.newPin ?? "",
          },
          text("pv.pin.changed"),
        );
    } else if ((target = after("recall")) !== null) {
      void run(
        "setRecall",
        { storeId: target, recallOff: value !== true },
        text(value === true ? "pv.recall.on" : "pv.recall.off"),
      );
    } else if ((target = after("audit")) !== null) {
      const store = storeOf(target);
      if (audit?.store === target || store === undefined) {
        audit = null;
        input.refresh();
        return true;
      }
      const at = epoch;
      void readAudit(store)
        .then((log) => {
          if (at === epoch) audit = log;
        })
        .catch((e: unknown) => void (status = reason(e)))
        .finally(input.refresh);
    } else if ((target = after("delete")) !== null) {
      if (!confirmDelete) {
        confirmDelete = true;
        input.refresh();
        return true;
      }
      drop();
      selected = EVERYDAY;
      void run("remove", { storeId: target }, text("pv.deleted"));
    } else if ((item = itemOf("edit")) !== null) {
      if (textValue.trim() !== "") void run("edit", { ...item, text: textValue }, text("pv.saved"));
    } else if ((item = itemOf("forget")) !== null) {
      void run("forget", item, text("pv.forgotten"));
    } else if ((item = itemOf("accept")) !== null) {
      void run("accept", item, text("pv.kept"));
    } else return false;
    return true;
  };

  /** The screen locked or the machine slept: everything read from the stores goes, and the window shows them locked. */
  input.memory.onLocked(() => {
    drop();
    admin.clear();
    stores = stores?.map((s) => ({ ...s, open: false, openUntil: null })) ?? null;
    input.refresh();
  });

  return {
    load,
    act,
    /** The tab closed or the window went: drop what was read, and the recovery code with it. */
    close: () => {
      drop();
      recovery = null;
      status = "";
    },
    /** Everyday memory is on show (or there are no private stores to pick). */
    everyday: () => stores === null || selected === EVERYDAY,
    controls: (): ReadonlyArray<HomeControl> => {
      if (stores === null) return [];
      const at = now();
      const store = storeOf(selected);
      if (
        items !== null &&
        (store === undefined || !openNow(store, at) || items.store !== selected)
      )
        drop();
      return privateControls({
        stores,
        selected,
        items: items?.list ?? null,
        query,
        status,
        recovery,
        admin,
        audit,
        confirmDelete,
        everydayCount: input.everydayCount(),
        voices: input.voices?.() ?? [],
        now: at,
      });
    },
  };
};

export type PrivateTab = ReturnType<typeof createPrivateTab>;

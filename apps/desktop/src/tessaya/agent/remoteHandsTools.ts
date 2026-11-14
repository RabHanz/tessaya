// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalRandom:off
/**
 * The tool table a remote session gets (docs/baton/REMOTE_HANDS.md): the assistant's own hands, rebuilt on UI Automation
 * patterns and background capture so nothing needs focus or a visible window, plus a few operations on the app. The gate and
 * the allowlist sit in front of every call; this file only does the work, through the sidecar and injected deps.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { REMOTE_HANDS_TOOLS, createHandleRegistry } from "@t3tools/tessaya-shared/remoteHands";

import type {
  FocusState,
  LocatedElement,
  UiTree,
  WindowPicture,
} from "../voice/dictationSidecar.ts";
import type { TessayaTool } from "./tessayaMcp.ts";
import { bmpToPng } from "./bmpToPng.ts";
import { buildTessayaTools, treeText, typeByValue, type ToolHost } from "./tessayaTools.ts";

export interface RemoteHandsDeps {
  readonly sidecar: {
    readonly locate: (input: {
      label: string;
      x: number;
      y: number;
      foreground?: boolean;
      window?: string;
      invoke?: boolean;
      ref?: number;
      tree?: number;
    }) => Promise<LocatedElement>;
    readonly uiTree: (window?: string, find?: string, number?: boolean) => Promise<UiTree>;
    readonly focusState?: (window?: string) => Promise<FocusState>;
    readonly setValue: (
      window: string,
      text: string,
    ) => Promise<{ readonly set: boolean; readonly name?: string; readonly error?: string }>;
    readonly captureWindow: (input: {
      window?: string;
      handle?: number;
      out: string;
    }) => Promise<WindowPicture>;
  };
  /** Where window pictures are written before they become PNGs. */
  readonly scratchDir: string;
  /** Pointer and keyboard input in the foreground, behind the mouse guard; absent means remote sessions get none. */
  readonly foreground?: {
    readonly clickAt: (to: { x: number; y: number }, double: boolean) => Promise<void>;
    /** Into the window with the keyboard; it refuses when that window changes under it. */
    readonly type: (text: string) => Promise<void>;
    readonly press: (keys: ReadonlyArray<string>) => Promise<void>;
    /** Whether the window titled like this has the keyboard now. */
    readonly keyboardIn: (window: string) => Promise<boolean>;
    /** The window he was using gets the keyboard back after a pointer click; false when Windows would not allow it. */
    readonly restoreFocus: (run: () => Promise<void>) => Promise<boolean>;
  };
  readonly ops: {
    readonly version: () => string;
    /** Names a remote session may read, mapped to files. */
    readonly logs: Readonly<Record<string, string>>;
    readonly processes: () => Promise<
      ReadonlyArray<{ readonly name: string; readonly pid: number }>
    >;
    readonly stop: (pid: number) => Promise<void>;
    readonly update: (version: string) => Promise<string>;
    readonly pages: ReadonlyArray<string>;
    readonly openPage: (page: string) => Promise<string>;
  };
  readonly newId?: () => string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const POLL_MS = 150;
const LOG_TAIL_BYTES = 256_000;

export const buildRemoteHandsTools = (deps: RemoteHandsDeps): ReadonlyArray<TessayaTool> => {
  // This session's last numbered tree: its numbers are the only ones its clicks may use.
  let lastTree: number | undefined;
  const located = (label: string | number, window: string | undefined, invoke: boolean) =>
    deps.sidecar.locate({
      label: typeof label === "number" ? "" : label,
      x: 0,
      y: 0,
      ...(window === undefined ? { foreground: true } : { window }),
      ...(invoke ? { invoke: true } : {}),
      ...(typeof label === "number" ? { ref: label, tree: lastTree ?? 0 } : {}),
    });

  /** Keys only ever go where the keyboard is, so a named window must be the one that has it. */
  const keyboard = async (what: string, window: string | undefined) => {
    const fg = deps.foreground;
    if (fg === undefined)
      throw new Error(`${what} needs the foreground and is not allowed for remote sessions here.`);
    if (window !== undefined && !(await fg.keyboardIn(window))) {
      throw new Error(
        `"${window}" has no text box that takes text without the keyboard, and another window has the keyboard, so nothing was sent. Ask him to click into "${window}".`,
      );
    }
    return fg;
  };

  const host: ToolHost = {
    capture: async () => {
      throw new Error("Use window_capture.");
    },
    uiTree: async (window, find) => {
      const tree = await deps.sidecar.uiTree(window, find, true);
      if (typeof tree.error === "string")
        throw new Error(`The window's controls can't be read: ${tree.error}`);
      lastTree = tree.tree;
      return treeText(tree);
    },
    ...(deps.sidecar.focusState === undefined
      ? {}
      : {
          focusState: async (window?: string) => {
            const state = await deps.sidecar.focusState!(window);
            return typeof state.error === "string"
              ? null
              : { window: state.window ?? "", focus: state.focus ?? null };
          },
        }),
    clickElement: async (target, double, window) => {
      const found = await located(target, window, !double);
      const label = typeof target === "number" ? `line ${target}` : target;
      if (found.stale === true)
        throw new Error(
          `The window changed since ui_tree, so ${label} may be another control now. Read ui_tree again.`,
        );
      if (!found.found)
        throw new Error(
          `No control is named "${label}" in ${window === undefined ? "the window with the keyboard" : `the window "${window}"`}.`,
        );
      if (found.invoked !== undefined)
        return `Pressed ${found.name ?? label} (${found.invoked}, no pointer, no focus change)${found.state ? `; it now reads ${found.state}` : ""}.`;
      if (found.covered_by !== undefined) {
        throw new Error(
          `"${found.name ?? label}" is covered by "${found.covered_by}", so a click would land there.`,
        );
      }
      const fg = deps.foreground;
      if (fg === undefined || found.x === undefined || found.y === undefined) {
        throw new Error(
          `"${label}" has no pattern to act on and pointer clicks are not allowed for remote sessions here.`,
        );
      }
      const to = { x: found.x, y: found.y };
      const restored = await fg.restoreFocus(() => fg.clickAt(to, double));
      return `Clicked ${found.name ?? label} (pointer; ${restored ? "focus given back" : "the window he was using could not be given the keyboard back"}).`;
    },
    waitFor: async (label, seconds, window) => {
      const until = Date.now() + seconds * 1000;
      do {
        const found = await located(label, window, false).catch(() => null);
        if (found?.found === true) return `${found.name ?? label} is there.`;
        await sleep(POLL_MS);
      } while (Date.now() < until);
      return `No control named "${label}" appeared in ${seconds} seconds.`;
    },
    // A targeted window has no keyboard owner to watch; its title stands in, so a dialog that replaces it stops a batch.
    windowKey: async (window) => (await deps.sidecar.uiTree(window)).window ?? "",
    click: async () => {
      throw new Error("Raw coordinates are not a remote hands tool.");
    },
    scroll: async () => {
      throw new Error("Scrolling is not a remote hands tool.");
    },
    drag: async () => {
      throw new Error("Dragging is not a remote hands tool.");
    },
    type: async (text, window) => {
      const added =
        window === undefined ? null : await typeByValue(deps.sidecar.setValue, window, text);
      if (added !== null) return added;
      const fg = await keyboard("Typing", window);
      await fg.type(text);
      return window === undefined ? "Typed where the keyboard is." : `Typed into "${window}".`;
    },
    press: async (keys, window) => {
      const fg = await keyboard("Keys", window);
      await fg.press(keys);
      return window === undefined ? "Pressed where the keyboard is." : `Pressed in "${window}".`;
    },
    sessions: async () => "none",
    session: async () => "none",
    send: async () => "none",
    fleet: async () => "none",
    dictation: async () => "none",
    assistantModel: async () => "none",
    memory: async () => "none",
    conversationSearch: async () => "none",
    remember: async () => "none",
    forget: async () => "none",
    jobs: async () => "none",
    target: async () => "none",
  };

  const handles = createHandleRegistry<number>(
    deps.newId ?? (() => `p${Math.random().toString(36).slice(2, 8)}`),
  );
  const text = (t: string) => ({ text: t });
  const arg = (a: Readonly<Record<string, unknown>>, key: string): string => {
    const v = a[key];
    if (typeof v !== "string" || v === "" || v.length > 300)
      throw new Error(`${key} must be a short, non-empty string.`);
    return v;
  };
  const obj = (properties: Record<string, unknown>, required: string[] = []) => ({
    type: "object",
    properties,
    required,
    additionalProperties: false,
  });

  const extra: TessayaTool[] = [
    {
      name: "window_capture",
      description:
        "A picture of one window by part of its title, drawn by the window itself: it works when the window is covered or in the background and never brings it forward. Default: the window with the keyboard.",
      inputSchema: obj({ window: { type: "string" } }),
      run: async (a) => {
        const out = NodePath.join(deps.scratchDir, `capture-${Date.now()}.bmp`);
        const window = typeof a["window"] === "string" ? a["window"] : undefined;
        const done = await deps.sidecar.captureWindow({
          ...(window === undefined ? {} : { window }),
          out,
        });
        if (typeof done.error === "string") throw new Error(done.error);
        try {
          const png = bmpToPng(NodeFS.readFileSync(out));
          return {
            text: `Window ${window ?? "with the keyboard"}`,
            images: [{ data: png.toString("base64"), mimeType: "image/png" }],
          };
        } finally {
          NodeFS.rmSync(out, { force: true });
        }
      },
    },
    {
      name: "app_version",
      description: "The version of the app running here.",
      inputSchema: obj({}),
      run: async () => text(deps.ops.version()),
    },
    {
      name: "log_tail",
      description: `The last lines of a named log: ${Object.keys(deps.ops.logs).join(", ") || "none are configured"}.`,
      inputSchema: obj(
        { name: { type: "string" }, lines: { type: "integer", minimum: 1, maximum: 500 } },
        ["name"],
      ),
      run: async (a) => {
        const file = deps.ops.logs[arg(a, "name")];
        if (file === undefined) throw new Error(`No log is named ${String(a["name"])}.`);
        const n = Math.max(
          1,
          Math.min(500, typeof a["lines"] === "number" ? Math.floor(a["lines"]) : 50),
        );
        const size = NodeFS.statSync(file).size;
        const fd = NodeFS.openSync(file, "r");
        try {
          const len = Math.min(size, LOG_TAIL_BYTES);
          const buf = Buffer.alloc(len);
          NodeFS.readSync(fd, buf, 0, len, size - len);
          return text(
            buf
              .toString("utf8")
              .split(/\r?\n/)
              .filter((l) => l !== "")
              .slice(-n)
              .join("\n"),
          );
        } finally {
          NodeFS.closeSync(fd);
        }
      },
    },
    {
      name: "process_list",
      description:
        "The processes Tessaya can stop, each with an id. process_stop takes only an id from here.",
      inputSchema: obj({}),
      run: async () => {
        handles.clear();
        const list = await deps.ops.processes();
        return text(list.map((p) => `${handles.add(p.pid)}: ${p.name}`).join("\n") || "none");
      },
    },
    {
      name: "process_stop",
      description: "Stop a process by an id process_list returned.",
      inputSchema: obj({ id: { type: "string" } }, ["id"]),
      run: async (a) => {
        const pid = handles.get(arg(a, "id"));
        if (pid === undefined)
          throw new Error("That is not an id process_list returned. List again.");
        await deps.ops.stop(pid);
        return text("Stopped.");
      },
    },
    {
      name: "app_update",
      description:
        "Start the app's own updater to a given version (it downloads, then restarts itself at a quiet moment).",
      inputSchema: obj({ version: { type: "string" } }, ["version"]),
      run: async (a) => text(await deps.ops.update(arg(a, "version"))),
    },
    {
      name: "open_page",
      description: `Open a page in the app's own window: ${deps.ops.pages.join(", ")}.`,
      inputSchema: obj({ page: { enum: [...deps.ops.pages] } }, ["page"]),
      run: async (a) => {
        const page = arg(a, "page");
        if (!deps.ops.pages.includes(page)) throw new Error(`No page is named ${page}.`);
        return text(await deps.ops.openPage(page));
      },
    },
  ];

  const hands = buildTessayaTools(host, { remote: true }).filter((t) =>
    REMOTE_HANDS_TOOLS.has(t.name),
  );
  return [...hands, ...extra];
};

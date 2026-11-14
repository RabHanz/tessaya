// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { REMOTE_HANDS_TOOLS } from "@t3tools/tessaya-shared/remoteHands";
import { describe, expect, it } from "vite-plus/test";

import { buildRemoteHandsTools, type RemoteHandsDeps } from "./remoteHandsTools.ts";

const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hands-"));
const make = (
  over: Partial<RemoteHandsDeps["sidecar"]> = {},
  foreground?: RemoteHandsDeps["foreground"],
) => {
  const stopped: number[] = [];
  const deps: RemoteHandsDeps = {
    sidecar: {
      locate: async (i) => ({
        found: true,
        name: i.label,
        x: 5,
        y: 6,
        ...(i.invoke ? { invoked: "invoke" } : {}),
      }),
      uiTree: async () => ({ window: "Notepad", controls: ["button: Save"] }),
      captureWindow: async () => ({}),
      setValue: async () => ({ set: false }),
      ...over,
    },
    scratchDir: dir,
    ...(foreground === undefined ? {} : { foreground }),
    ops: {
      version: () => "1.2.3",
      logs: { main: NodePath.join(dir, "main.log") },
      processes: async () => [{ name: "notepad.exe", pid: 4242 }],
      stop: async (pid) => void stopped.push(pid),
      update: async (v) => `updating to ${v}`,
      pages: ["settings", "home"],
      openPage: async (p) => `opened ${p}`,
    },
    newId: (() => {
      let n = 0;
      return () => `p${(n += 1)}`;
    })(),
  };
  const tools = new Map(buildRemoteHandsTools(deps).map((t) => [t.name, t]));
  return { tools, stopped };
};

describe("remote hands tools", () => {
  it("offers exactly the allowlist and no raw-coordinate tool", () => {
    const { tools } = make();
    expect(new Set(tools.keys())).toEqual(new Set(REMOTE_HANDS_TOOLS));
  });

  it("acts through a control's pattern with no pointer, and refuses a pointer click without the foreground", async () => {
    const { tools } = make();
    expect(
      (await tools.get("click_element")!.run({ label: "Save", window: "Notepad", why: "w" })).text,
    ).toContain("no pointer");
    const bare = make({ locate: async (i) => ({ found: true, name: i.label, x: 5, y: 6 }) });
    await expect(bare.tools.get("click_element")!.run({ label: "Save", why: "w" })).rejects.toThrow(
      "pointer clicks are not allowed",
    );
  });

  it("clicks only by the numbers of its own last tree; a window check reads an unnumbered tree", async () => {
    const asked: unknown[] = [];
    const reads: unknown[] = [];
    const { tools } = make({
      uiTree: async (_w, _f, number) => (
        reads.push(number === true),
        { window: "Notepad", controls: ["[1] button: Save"], ...(number ? { tree: 9 } : {}) }
      ),
      locate: async (i) => (
        asked.push([i.ref, i.tree]),
        i.ref === 2
          ? { found: false, stale: true }
          : { found: true, name: "Save", invoked: "toggle", state: "[checked]" }
      ),
    });
    await tools.get("ui_tree")!.run({});
    expect((await tools.get("click_element")!.run({ id: 1, why: "w" })).text).toContain(
      "it now reads [checked]",
    );
    await expect(tools.get("click_element")!.run({ id: 2, why: "w" })).rejects.toThrow(
      "Read ui_tree again",
    );
    await tools
      .get("act_batch")!
      .run({ steps: [{ tool: "press_keys", args: { keys: ["a"] } }] })
      .catch(() => null);
    expect(asked).toEqual([
      [1, 9],
      [2, 9],
    ]);
    // The model's tree, the batch's window check (unnumbered), the tree the batch ends with (the model reads it).
    expect(reads).toEqual([true, false, true]);
  });

  it("falls back to a pointer click only through the foreground deps, and says when focus could not be given back", async () => {
    const log: string[] = [];
    const { tools } = make(
      { locate: async (i) => ({ found: true, name: i.label, x: 5, y: 6 }) },
      {
        clickAt: async (to) => void log.push(`click ${to.x},${to.y}`),
        type: async () => {},
        press: async () => {},
        keyboardIn: async () => true,
        restoreFocus: async (run) => {
          log.push("save focus");
          await run().finally(() => log.push("restore focus"));
          return false;
        },
      },
    );
    const said = await tools.get("click_element")!.run({ label: "Save", why: "w" });
    expect(log).toEqual(["save focus", "click 5,6", "restore focus"]);
    expect(said.text).toContain("could not be given the keyboard back");
  });

  it("types into a named window by its value, and never into another window that has the keyboard", async () => {
    const typed: string[] = [];
    const foreground = (holds: boolean): RemoteHandsDeps["foreground"] => ({
      clickAt: async () => {},
      type: async (text) => void typed.push(text),
      press: async () => {},
      keyboardIn: async () => holds,
      restoreFocus: async (run) => (await run(), true),
    });
    const byValue = make(
      {
        setValue: async (window, text) => (
          typed.push(`${window}<-${text}`),
          { set: true, name: "Text editor" }
        ),
      },
      foreground(false),
    );
    expect(
      (await byValue.tools.get("type_text")!.run({ text: "x", window: "Notepad", why: "w" })).text,
    ).toContain("no keyboard, no focus change");
    const noValue = make({}, foreground(false));
    await expect(
      noValue.tools.get("type_text")!.run({ text: "y", window: "Notepad", why: "w" }),
    ).rejects.toThrow("another window has the keyboard");
    await expect(
      noValue.tools.get("press_keys")!.run({ keys: ["ctrl", "s"], window: "Notepad", why: "w" }),
    ).rejects.toThrow("another window has the keyboard");
    expect(typed).toEqual(["Notepad<-x"]);
  });

  it("stops only a process id process_list returned, and reads only named logs", async () => {
    const { tools, stopped } = make();
    await expect(tools.get("process_stop")!.run({ id: "p1" })).rejects.toThrow(
      "not an id process_list returned",
    );
    expect((await tools.get("process_list")!.run({})).text).toBe("p1: notepad.exe");
    await tools.get("process_stop")!.run({ id: "p1" });
    expect(stopped).toEqual([4242]);
    NodeFS.writeFileSync(NodePath.join(dir, "main.log"), "a\nb\nc\n");
    expect((await tools.get("log_tail")!.run({ name: "main", lines: 2 })).text).toBe("b\nc");
    await expect(tools.get("log_tail")!.run({ name: "../etc/passwd" })).rejects.toThrow(
      "No log is named",
    );
  });

  it("runs a batch on a named window and stops when its title changes", async () => {
    const titles = ["Notepad", "Save As"];
    const { tools } = make({
      uiTree: async () => ({ window: titles.shift() ?? "Save As", controls: [] }),
    });
    const out = await tools.get("act_batch")!.run({
      steps: [
        { tool: "click_element", args: { label: "A", window: "Notepad", why: "w" } },
        { tool: "click_element", args: { label: "B", window: "Notepad", why: "w" } },
      ],
    });
    expect(out.text).toContain("Stopped before step 2");
  });
});

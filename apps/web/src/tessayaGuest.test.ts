// @effect-diagnostics nodeBuiltinImport:off - reads the source tree to walk the guest page's imports.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { describe, expect, it, vi } from "vite-plus/test";

const SRC = import.meta.dirname;
const STATIC = /(?:\bfrom\s*|\bimport\s+)["']((?:\.{1,2}|~)\/[^"']+)["']/g;
const ANY = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)["']((?:\.{1,2}|~)\/[^"']+)["']/g;

const resolveModule = (from: string, specifier: string): string | null => {
  const base = specifier.startsWith("~/")
    ? NodePath.join(SRC, specifier.slice(2))
    : NodePath.resolve(NodePath.dirname(from), specifier);
  const candidates = [
    base,
    ...["ts", "tsx"].flatMap((ext) => [`${base}.${ext}`, `${base}/index.${ext}`]),
  ];
  return (
    candidates.find((path) => NodeFS.statSync(path, { throwIfNoEntry: false })?.isFile()) ?? null
  );
};

/**
 * What the guest loads: the entry's own imports (lazy ones too) and everything they import statically. A lazy import
 * deeper down loads only when that code runs, such as a removed environment's draft cleanup.
 */
const moduleGraph = (entry: string): ReadonlySet<string> => {
  const seen = new Set<string>();
  const queue = [entry];
  for (let file = queue.pop(); file !== undefined; file = queue.pop()) {
    if (seen.has(file) || !/\.tsx?$/.test(file)) continue;
    seen.add(file);
    for (const [, specifier] of NodeFS.readFileSync(file, "utf8").matchAll(
      file === entry ? ANY : STATIC,
    )) {
      const resolved = specifier === undefined ? null : resolveModule(file, specifier);
      if (resolved !== null) queue.push(resolved);
    }
  }
  return new Set([...seen].map((path) => NodePath.relative(SRC, path)));
};

describe("Tessaya's guest page", () => {
  // Each of these writes client state T3's own window owns, or starts the services the main window runs.
  it("never loads a store or service T3's window owns", () => {
    const graph = moduleGraph(NodePath.join(SRC, "tessayaGuest.tsx"));
    expect(graph.has("components/settings/HardwareSettings.tsx")).toBe(true);
    for (const owned of [
      "components/panes/tessayaPanesStore.ts",
      "uiStateStore.ts",
      "appInit.tsx",
      "routeTree.gen.ts",
      "main.tsx",
    ])
      expect(graph.has(owned), owned).toBe(false);
  });

  it("is what bootstrap loads for a guest address, and only for one", async () => {
    const { isTessayaGuest } = await import("./tessayaGuestFlag");
    expect(isTessayaGuest("?tessayaGuest=1")).toBe(true);
    expect(isTessayaGuest("")).toBe(false);
    expect(isTessayaGuest("?batonWindow=abc")).toBe(false);
  });

  // Toasts reach the drafts store, so the guest loads it; it must hold none of T3's drafts and write none back.
  it.each([
    ["", true],
    ["?tessayaGuest=1", false],
  ])("the drafts store at %j writes to storage: %s", async (search, writes) => {
    const written: string[] = [];
    vi.stubGlobal("location", { search });
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: (key: string) => written.push(key),
      removeItem: (key: string) => written.push(key),
    });
    vi.useFakeTimers();
    vi.resetModules();
    try {
      const { useComposerDraftStore } = await import("./composerDraftStore");
      const { scopeThreadRef } = await import("@t3tools/client-runtime/environment");
      const { EnvironmentId, ThreadId } = await import("@t3tools/contracts");
      const thread = scopeThreadRef(EnvironmentId.make("env"), ThreadId.make("thread"));
      useComposerDraftStore.getState().setPrompt(thread, "typed in T3's window");
      vi.advanceTimersByTime(1000);
      expect(written.includes("t3code:composer-drafts:v1")).toBe(writes);
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

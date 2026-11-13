import { PRIVATE_ASSISTANT_OPS } from "@t3tools/baton-contracts";
import { describe, expect, it } from "vite-plus/test";

import { HTML, MANIFEST, SCRIPT, SERVICE_WORKER } from "./BatonTessayaPage.ts";

describe("the phone page files", () => {
  it("has a script and a service worker that parse, and a page with no inline script", () => {
    expect(() => new Function(SCRIPT)).not.toThrow();
    expect(() => new Function(SERVICE_WORKER)).not.toThrow();
    expect(HTML).toContain('<script src="/tessaya/app.js"></script>');
    expect(HTML).not.toMatch(/<script>/);
  });
  it("is installable: a manifest whose start page is inside its scope, with the Woad icon set", () => {
    const m = JSON.parse(MANIFEST) as {
      start_url: string;
      scope: string;
      display: string;
      icons: Array<{ src: string; purpose?: string }>;
    };
    expect(m.start_url.startsWith(m.scope)).toBe(true);
    expect(m.display).toBe("standalone");
    expect(m.icons.map((i) => i.src)).toEqual([
      "/icon-192.png",
      "/icon-512.png",
      "/maskable-512.png",
    ]);
  });
  it("sets text only through textContent, never as markup", () => {
    for (const markup of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write"])
      expect(SCRIPT).not.toContain(markup);
  });
  it("keeps what a private store holds in memory only: no browser storage, no service worker cache", () => {
    for (const storage of ["localStorage", "sessionStorage", "indexedDB", "caches"])
      expect(SCRIPT + SERVICE_WORKER).not.toContain(storage);
  });
  it("has a Memories view that asks only for the ops the phone is allowed", () => {
    expect(SCRIPT).toContain('["mem", "Memories"]');
    const ops = [...SCRIPT.matchAll(/op: "(\w+)"/g)].map((m) => m[1]!);
    expect(ops).toEqual(expect.arrayContaining(["people", "list", "unlock", "setup", "export"]));
    for (const op of ops) expect(PRIVATE_ASSISTANT_OPS.has(op), op).toBe(false);
  });

  it("lets an invite code join, and a member's phone sets up only its own memory", () => {
    expect(SCRIPT).toContain('fetch("/api/auth/browser-session"');
    expect(SCRIPT).toContain('op: "setup", personId: member.id');
  });
});

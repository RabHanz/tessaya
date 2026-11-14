// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { createCloudKeys, type KeyProtection } from "./cloudKeys.ts";

const KEY = "sk-live-abcdef123456";
/** Stands in for safeStorage: reversible, and never the plain text. */
const os: KeyProtection = {
  protect: (plain) => `wrapped:${Buffer.from(plain).toString("base64")}`,
  unprotect: (wrapped) => {
    if (!wrapped.startsWith("wrapped:")) throw new Error("cannot decrypt");
    return Buffer.from(wrapped.slice(8), "base64").toString();
  },
};

const setup = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "cloud-keys-"));
  const file = NodePath.join(dir, "voice", "cloud-keys.json");
  return {
    dir,
    file,
    [Symbol.dispose]: () => NodeFS.rmSync(dir, { recursive: true, force: true }),
  };
};

describe("his cloud speech keys", () => {
  it("keeps a key wrapped by the OS, never in the clear, one per provider", () => {
    using t = setup();
    const keys = createCloudKeys(t.file, () => os);
    keys.set("openai", `  ${KEY}  `);
    expect(keys.get("openai")).toBe(KEY);
    expect(keys.has("gemini")).toBe(false);
    expect(NodeFS.readFileSync(t.file, "utf8")).not.toContain(KEY);
    keys.clear("openai");
    expect(keys.get("openai")).toBeNull();
  });

  it("refuses a paste that is not a key, and keeps the one it had", () => {
    using t = setup();
    const keys = createCloudKeys(t.file, () => os);
    keys.set("gemini", KEY);
    expect(() => keys.set("gemini", "my key is sk-live abc")).toThrow(
      /does not look like an API key/,
    );
    expect(() => keys.set("gemini", "short")).toThrow(/does not look like an API key/);
    expect(keys.get("gemini")).toBe(KEY);
  });

  it("unwraps once, and a refused key is not used again until he saves or removes one", () => {
    using t = setup();
    let unwrapped = 0;
    const counting: KeyProtection = {
      ...os,
      unprotect: (w) => ((unwrapped += 1), os.unprotect(w)),
    };
    const keys = createCloudKeys(t.file, () => counting);
    keys.set("openai", KEY);
    for (let i = 0; i < 5; i += 1) keys.get("openai");
    expect(unwrapped).toBe(1);
    keys.refuse("openai");
    expect(keys.get("openai")).toBeNull();
    expect(keys.has("openai")).toBe(true);
    expect(keys.refused("openai")).toBe(true);
    keys.set("openai", `${KEY}x`);
    expect(keys.refused("openai")).toBe(false);
    expect(keys.get("openai")).toBe(`${KEY}x`);
  });

  it("refuses to keep a key where the OS cannot encrypt it (Linux basic_text)", () => {
    using t = setup();
    const keys = createCloudKeys(t.file, () => null);
    expect(() => keys.set("openai", KEY)).toThrow(/cannot encrypt/);
    expect(NodeFS.existsSync(t.file)).toBe(false);
  });

  it("treats a key that will not unwrap, or a damaged file, as no key", () => {
    using t = setup();
    NodeFS.mkdirSync(NodePath.dirname(t.file), { recursive: true });
    NodeFS.writeFileSync(t.file, JSON.stringify({ openai: "from another computer" }));
    expect(createCloudKeys(t.file, () => os).get("openai")).toBeNull();
    NodeFS.writeFileSync(t.file, "{not json");
    expect(createCloudKeys(t.file, () => os).get("openai")).toBeNull();
  });
});

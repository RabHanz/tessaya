import { describe, expect, it } from "vite-plus/test";

import { createLoginItemState, loginItemOn, setLoginItem } from "./loginItem.ts";

const ENTRY = "app.id.example";

const registry = (initial: ReadonlyArray<string>) => {
  const entries = new Set(initial);
  return {
    entries,
    api: {
      getLoginItemSettings: () => ({ openAtLogin: entries.has("default") }),
      setLoginItemSettings: (s: { openAtLogin: boolean; name?: string }) => {
        const name = s.name ?? "default";
        if (s.openAtLogin) entries.add(name);
        else entries.delete(name);
      },
    },
  };
};

describe("the sign-in switch", () => {
  it("reads on when the installer's entry under the app's id exists, though the settings file never said so", async () => {
    expect(await loginItemOn(registry([ENTRY]).api, ENTRY, async (name) => name === ENTRY)).toBe(
      true,
    );
    expect(await loginItemOn(registry([]).api, ENTRY, async () => false)).toBe(false);
  });
  it("reads on for Electron's default-named entry too", async () => {
    expect(await loginItemOn(registry(["default"]).api, ENTRY, async () => false)).toBe(true);
  });
  it("is read from the registry only on refresh and after a change, never when Home asks", async () => {
    let reads = 0;
    const state = createLoginItemState(registry([ENTRY]).api, ENTRY, async () => {
      reads += 1;
      return true;
    });
    for (let i = 0; i < 5; i += 1) state.on();
    expect(reads).toBe(0);
    expect(await state.refresh()).toBe(true);
    expect(state.on()).toBe(true);
    state.set(false);
    expect(state.on()).toBe(false);
    expect(reads).toBe(2);
  });
  it("keeps exactly one entry, under the app's id, and none when switched off", () => {
    const r = registry(["default"]);
    setLoginItem(r.api, ENTRY, true);
    expect([...r.entries]).toEqual([ENTRY]);
    setLoginItem(r.api, ENTRY, false);
    expect([...r.entries]).toEqual([]);
  });
});

import { describe, expect, it } from "vite-plus/test";

import {
  chooseDictationCleanup,
  DEFAULT_DICTATION_CLEANUP,
  dictationCleanupCatchUp,
  followDictationCleanup,
} from "./dictationCleanup.ts";

describe("dictationCleanupCatchUp", () => {
  it("hands the newest choice to every environment behind it, and nothing once they agree", () => {
    const on = chooseDictationCleanup(DEFAULT_DICTATION_CLEANUP, { enabled: true }, 1_000);
    const off = chooseDictationCleanup(on, { enabled: false }, 2_000);
    const copies = [
      { environmentId: "laptop", cleanup: on },
      { environmentId: "box", cleanup: off },
      { environmentId: "fresh", cleanup: DEFAULT_DICTATION_CLEANUP },
    ];
    expect(dictationCleanupCatchUp(copies)).toEqual({ newest: off, behind: ["laptop", "fresh"] });
    expect(
      dictationCleanupCatchUp(copies.map((copy) => ({ ...copy, cleanup: off }))).behind,
    ).toEqual([]);
    expect(dictationCleanupCatchUp([])).toEqual({ newest: null, behind: [] });
  });

  it("stamps a choice after the copy it changes, even from a clock that runs behind", () => {
    const later = chooseDictationCleanup(DEFAULT_DICTATION_CLEANUP, { enabled: true }, 5_000);
    expect(chooseDictationCleanup(later, { engine: "tessaya" }, 4_000).updatedAt).toBe(5_001);
  });
});

describe("followDictationCleanup", () => {
  it("carries a browser's old switch in until someone chooses, then follows each change of the setting", () => {
    expect(followDictationCleanup(DEFAULT_DICTATION_CLEANUP, null, true)).toBe("adopt");
    expect(followDictationCleanup(DEFAULT_DICTATION_CLEANUP, null, false)).toBeNull();
    const off = chooseDictationCleanup(DEFAULT_DICTATION_CLEANUP, { enabled: false }, 1);
    // Chosen off elsewhere: the old "on" here goes.
    expect(followDictationCleanup(off, null, true)).toBe("off");
    const on = chooseDictationCleanup(off, { enabled: true }, 2);
    expect(followDictationCleanup(on, off, false)).toBe("on");
    // Flipped here while the setting has not changed yet: left alone until its write comes back.
    expect(followDictationCleanup(on, { ...on }, false)).toBeNull();
  });
});

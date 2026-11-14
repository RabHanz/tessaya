import { describe, expect, it } from "vite-plus/test";

import { createDictationHold } from "./dictationHold.ts";

describe("voice dictation's window and Esc", () => {
  const rig = () => {
    let held = 0;
    let ended = 0;
    const press: Array<() => void> = [];
    const hold = createDictationHold<string>(
      (onPress) => {
        held += 1;
        press.push(onPress);
        return () => {
          held -= 1;
        };
      },
      () => {
        ended += 1;
      },
    );
    return { hold, held: () => held, ended: () => ended, press };
  };

  it("holds Esc once while dictating, and Esc ends it", () => {
    const r = rig();
    r.hold.start("Notepad");
    r.hold.start("Notepad");
    expect(r.held()).toBe(1);
    r.press[0]!();
    expect(r.ended()).toBe(1);
  });

  it("keeps the window until the last words are pasted, then lets it go", () => {
    const r = rig();
    r.hold.start("Notepad");
    r.hold.stop();
    expect(r.held()).toBe(0);
    expect(r.hold.target()).toBe("Notepad");
  });

  it("leaves no Esc and no window behind when the voice is turned off mid-dictation", () => {
    const r = rig();
    r.hold.start("Notepad");
    r.hold.clear();
    expect(r.held()).toBe(0);
    expect(r.hold.target()).toBe(null);
    r.hold.clear();
    expect(r.held()).toBe(0);
  });

  it("gives the wake's window to one turn only", () => {
    const r = rig();
    r.hold.setTarget("Chrome");
    expect(r.hold.takeTarget()).toBe("Chrome");
    expect(r.hold.takeTarget()).toBe(null);
  });
});

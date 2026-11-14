// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeVM from "node:vm";

import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_OS_PACK, mergePack } from "@t3tools/baton-shared/osPack";

import { bodyOf } from "./desktopMascot.ts";

/** The shipped Character Studio rig (apps/web/public/companion), loaded as the stage page loads it. */
const loadRig = () => {
  const dir = NodePath.join(__dirname, "..", "..", "..", "..", "web", "public", "companion");
  const g: Record<string, unknown> = {};
  const context = NodeVM.createContext({
    window: g,
    self: g,
    Math,
    console,
    performance: { now: () => 0 },
  });
  for (const file of ["rig.js", "bodies.js"])
    NodeVM.runInContext(NodeFS.readFileSync(NodePath.join(dir, file), "utf8"), context);
  return g["TCS"] as {
    drawFace: (R: object, F: object, pal: object, time: number, spinT: number) => { svg: string };
    NEUTRAL: Record<string, number>;
    CHARACTERS: Record<string, { face: Record<string, number>; pal: object }>;
    PERSONAS: Record<string, { character: string; traits: Record<string, number> }>;
  };
};

const eyeOutlines = (svg: string): ReadonlyArray<ReadonlyArray<number>> =>
  [...svg.matchAll(/data-l="eye-base"[^>]*><path d="([^"]+)"/g)].map((m) =>
    (m[1]!.match(/-?\d+(\.\d+)?/g) ?? []).map(Number),
  );

const TCS = loadRig();
// "lu" is the upper lid: a blink or a sleepy eye closes the same outline down to a line, never a separate bar
const STYLES = ["arc", "sarc", "chev", "star", "heart", "spiral", "lu"];
const CASES = Object.keys(TCS.PERSONAS).flatMap((persona) =>
  STYLES.map((style) => ({ persona, style })),
);

describe("the companion's eyes", () => {
  // Every persona's eye style, morphed in from the open eye in small steps of its sprung weight.
  it.each(CASES)(
    "$persona: open → $style morphs through in-betweens, never swapping or jumping",
    ({ persona, style }) => {
      const ch = TCS.CHARACTERS[TCS.PERSONAS[persona]!.character]!;
      const f = ch.face;
      const F = {
        uid: "t",
        R: f["R"],
        curv: f["curv"] ?? 1,
        cx: 0,
        cy: f["y"] ?? 0,
        ex: f["ex"],
        eyY: f["eyY"],
        ew: f["ew"],
        eh: f["eh"],
        mY: f["mY"],
        mw: f["mw"],
        bg: f["bg"] ?? 10,
        bw: f["bw"],
        yawMax: f["yawMax"] ?? 2,
      };
      let last: ReadonlyArray<ReadonlyArray<number>> | null = null;
      let worst = 0;
      for (let i = 0; i <= 50; i++) {
        const outlines = eyeOutlines(
          TCS.drawFace({ ...TCS.NEUTRAL, [style]: i / 50 }, F, ch.pal, 0, 0).svg,
        );
        // one outline per eye at every weight: a swap to another layer would drop it
        expect(outlines).toHaveLength(2);
        if (last !== null)
          outlines.forEach((nums, e) => {
            expect(nums).toHaveLength(last![e]!.length);
            for (let k = 0; k < nums.length; k++)
              worst = Math.max(worst, Math.abs(nums[k]! - last![e]![k]!));
          });
        last = outlines;
      }
      // a 2% step of the weight moves no point of the outline by more than a small share of the eye
      expect(worst).toBeLessThan(Number(f["ew"]) * 0.12);
    },
  );
});

describe("the body a persona wears (SPINE-UNIFY §10, P3)", () => {
  it("is the persona record's, which for the default pack is the studio's own; a custom persona gets one too", () => {
    for (const p of DEFAULT_OS_PACK.personas) {
      const preset = TCS.PERSONAS[p.name.toLowerCase()]!;
      expect(bodyOf(DEFAULT_OS_PACK.personas, p.name)).toEqual({
        persona: p.name.toLowerCase(),
        character: preset.character,
        traits: preset.traits,
      });
    }
    const pack = mergePack({
      roles: {
        nova: "---\nname: Nova\nvoice: eve\ncharacter: loom\ntraits: warmth 0.2\n---\nbrief",
      },
    });
    expect(bodyOf(pack.personas, "nova")).toEqual({
      persona: "custom",
      character: "loom",
      traits: { warmth: 0.2 },
    });
    expect(TCS.CHARACTERS["loom"]).toBeDefined();
    expect(bodyOf(pack.personas, "nobody")).toEqual({ persona: "custom" });
  });
});

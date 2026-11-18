// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";

import { describe, expect, it } from "vite-plus/test";

import { SPEECH_JS, visemesBlock, withBlock } from "./companion-visemes.ts";

describe("the Studio's mouth shapes", () => {
  it("speech.js carries the generated block as it is built now (run node scripts/companion-visemes.ts)", async () => {
    const speech = NodeFS.readFileSync(SPEECH_JS, "utf8");
    expect(withBlock(speech, await visemesBlock())).toBe(speech);
  });
});

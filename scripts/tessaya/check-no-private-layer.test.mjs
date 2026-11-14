// node --test scripts/tessaya/check-no-private-layer.test.mjs : a clean bundle passes; each marker of a private layer fails it.
import * as NodeAssert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeTest from "node:test";

import { check } from "./check-no-private-layer.mjs";

const bundle = (files) => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "layer-check-"));
  for (const [name, text] of Object.entries(files)) {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(dir, name)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, name), text);
  }
  return dir;
};

NodeTest.test("a public bundle with only the seam passes", () => {
  const dir = bundle({
    "bin.mjs": "const internalBuild = () => false; if (!internalBuild()) return [];",
    "assets/app.js": "export const x = 1;",
  });
  NodeAssert.deepEqual(check([dir]), []);
});

NodeTest.test(
  "a canary, a private package or an internal build anywhere fails it, binaries included",
  () => {
    const cases = {
      "a.js": 'const CANARY = "tessaya-private-canary-5d1e9a7c4b2f";',
      "b.js": 'import x from "@tessaya-private/companion";',
      "c.js": "var __TESSAYA_INTERNAL__ = true;",
      "nested/app.asar": Buffer.concat([
        Buffer.from([0, 255, 1]),
        Buffer.from("tessaya-private-canary-00ff"),
      ]),
    };
    for (const [name, text] of Object.entries(cases)) {
      const problems = check([bundle({ [name]: text })]);
      NodeAssert.equal(problems.length, 1, name);
      NodeAssert.match(problems[0], new RegExp(NodePath.basename(name).replace(".", "\\.")));
    }
  },
);

NodeTest.test("a path that was not built is a failure, not a pass", () => {
  NodeAssert.equal(check([NodePath.join(NodeOS.tmpdir(), "no-such-build-dir")]).length, 1);
});

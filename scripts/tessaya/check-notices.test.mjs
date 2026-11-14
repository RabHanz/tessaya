/* oxlint-disable t3code/namespace-node-imports -- Baton file predating the rule (D82) */
// node --test scripts/tessaya/check-notices.test.mjs : the check passes on this repo and catches each way a new dependency goes unaccounted for.
import assert from "node:assert/strict";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { test } from "node:test";

import { check } from "./check-notices.mjs";

const copyRoot = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "notices-"));
  const put = (file, text) => {
    NodeFS.mkdirSync(NodePath.dirname(NodePath.join(dir, file)), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dir, file), text);
  };
  const real = NodePath.resolve(import.meta.dirname, "../..");
  for (const file of [
    "docs/baton/notices.json",
    "docs/baton/THIRD_PARTY_NOTICES.md",
    "apps/desktop/package.json",
    "native/baton-dictation/Cargo.toml",
    "tools/r1flash/go.mod",
    "apps/desktop/src/baton/home/fonts.ts",
    "packages/baton-voice/package.json",
    "packages/baton-shared/package.json",
    "packages/baton-contracts/package.json",
  ]) {
    put(file, NodeFS.readFileSync(NodePath.join(real, file), "utf8"));
  }
  for (const f of NodeFS.readdirSync(NodePath.join(real, "docs/baton/licences")))
    put(`docs/baton/licences/${f}`, "x");
  for (const f of NodeFS.readdirSync(NodePath.join(real, "native/baton-dictation/models")))
    put(`native/baton-dictation/models/${f}`, "");
  return { dir, put, read: (f) => NodeFS.readFileSync(NodePath.join(dir, f), "utf8") };
};

test("this repository is accounted for", () => {
  assert.deepEqual(check(), []);
});

test("a new npm package, crate or model without an entry fails", () => {
  const r = copyRoot();
  const voice = JSON.parse(r.read("packages/baton-voice/package.json"));
  voice.dependencies["some-new-lib"] = "1.0.0";
  r.put("packages/baton-voice/package.json", JSON.stringify(voice));
  r.put(
    "native/baton-dictation/Cargo.toml",
    `${r.read("native/baton-dictation/Cargo.toml")}`.replace(
      "[dependencies]\n",
      '[dependencies]\nnew-crate = "1"\n',
    ),
  );
  r.put("native/baton-dictation/models/newword.onnx", "");
  r.put(
    "tools/r1flash/go.mod",
    `${r.read("tools/r1flash/go.mod")}require example.com/newmod v1.0.0\n`,
  );
  const problems = check(r.dir);
  assert.equal(problems.length, 4);
  assert.ok(problems.some((p) => p.startsWith("go:example.com/newmod")));
  assert.ok(problems.some((p) => p.startsWith("npm:some-new-lib")));
  assert.ok(problems.some((p) => p.startsWith("crate:new-crate")));
  assert.ok(problems.some((p) => p.startsWith("model:newword.onnx")));
});

test("an entry the notices never mention, or with no licence text, fails", () => {
  const r = copyRoot();
  r.put(
    "docs/baton/THIRD_PARTY_NOTICES.md",
    r.read("docs/baton/THIRD_PARTY_NOTICES.md").replaceAll("Newsreader", "N"),
  );
  NodeFS.rmSync(NodePath.join(r.dir, "docs/baton/licences/CC-BY-4.0.txt"));
  NodeFS.writeFileSync(
    NodePath.join(r.dir, "docs/baton/notices.json"),
    JSON.stringify({
      ...JSON.parse(r.read("docs/baton/notices.json")),
      entries: {
        ...JSON.parse(r.read("docs/baton/notices.json")).entries,
        "crate:hound": { name: "hound", licence: "CC-BY-4.0", mention: "hound" },
      },
    }),
  );
  const problems = check(r.dir);
  assert.ok(problems.some((p) => p.includes("never mentions")));
  assert.ok(problems.some((p) => p.includes("licence text")));
});

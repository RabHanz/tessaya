import * as Babel from "@babel/core";
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

const require = NodeModule.createRequire(import.meta.url);
const tessayaBrand = require("./tessayaBrandBabel.cjs");

const repoRoot = NodePath.resolve(import.meta.dirname, "../../..");
// Everything Metro bundles from the workspace for the phone app.
const BUNDLED_ROOTS = [
  "apps/mobile/src",
  "packages/client-runtime/src",
  "packages/shared/src",
  "packages/contracts/src",
];
const T3_NAME = /\bT3 (Code|Connect|Account)\b|\b(Open|in) T3\b/;

function sourceFiles(dir) {
  return NodeFS.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = NodePath.join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(full);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

/** The strings a file contributes to the Tessaya bundle (comments are stripped by the minifier). */
function bundledStrings(filename, code) {
  const seen = [];
  const collect = () => ({
    visitor: {
      StringLiteral: (node) => void seen.push(node.node.value),
      TemplateElement: (node) => void seen.push(node.node.value.cooked ?? node.node.value.raw),
      JSXText: (node) => void seen.push(node.node.value),
    },
  });
  Babel.transformSync(code, {
    filename,
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: filename.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"] },
    plugins: [tessayaBrand, collect],
  });
  return seen;
}

it("leaves no T3 name in the Tessaya bundle's strings except the About credit", () => {
  const leaks = [];
  let credit = "";
  for (const root of BUNDLED_ROOTS) {
    for (const file of sourceFiles(NodePath.join(repoRoot, root))) {
      const code = NodeFS.readFileSync(file, "utf8");
      if (!code.includes("T3")) continue;
      for (const text of bundledStrings(file, code)) {
        if (NodePath.basename(file).startsWith("upstreamCredit.")) credit += text;
        else if (T3_NAME.test(text)) leaks.push(`${NodePath.relative(repoRoot, file)}: ${text}`);
      }
    }
  }
  expect(leaks).toEqual([]);
  expect(credit).toContain("Built on T3 Code (open source, MIT)");
  expect(credit).toContain("Copyright (c) 2026 T3 Tools Inc.");
});

it("rewrites names without touching identifiers that only contain T3", () => {
  expect(tessayaBrand.rebrand("Open system Settings to disable notifications for T3 Code.")).toBe(
    "Open system Settings to disable notifications for Tessaya.",
  );
  expect(tessayaBrand.rebrand("T3 Code Mobile")).toBe("Tessaya");
  expect(tessayaBrand.rebrand("Deregister it under T3 Account → T3 Connect")).toBe(
    "Deregister it under Connect account → Connect",
  );
  expect(tessayaBrand.rebrand("t3-code font-t3-bold T3Mark")).toBe("t3-code font-t3-bold T3Mark");
});

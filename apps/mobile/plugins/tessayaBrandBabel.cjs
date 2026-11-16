// Tessaya (APP_VARIANT=tessaya) shows no T3 name: user-facing strings are rewritten at bundle time,
// so upstream screens stay untouched. The one credit lives in a file this skips (upstreamCredit.ts).
const path = require("node:path");

const REWRITES = [
  [/\bT3 Code (Mobile|Beta)\b/g, "Tessaya"],
  [/\bT3 Code\b/g, "Tessaya"],
  [/\bT3 Account\b/g, "Connect account"],
  [/\bT3 Connect\b/g, "Connect"],
  [/\b(Open|in) T3\b/g, "$1 Tessaya"],
];

function rebrand(text) {
  return REWRITES.reduce((out, [pattern, to]) => out.replace(pattern, to), text);
}

function skipped(filename) {
  return (
    !filename ||
    filename.includes(`${path.sep}node_modules${path.sep}`) ||
    path.basename(filename).startsWith("upstreamCredit.")
  );
}

module.exports = function tessayaBrandBabel() {
  return {
    name: "tessaya-brand",
    visitor: {
      Program(_path, state) {
        state.tessayaSkip = skipped(state.filename);
      },
      StringLiteral(node, state) {
        if (state.tessayaSkip || node.parentPath.isImportDeclaration()) return;
        const next = rebrand(node.node.value);
        if (next !== node.node.value) {
          node.node.value = next;
          delete node.node.extra;
        }
      },
      TemplateElement(node, state) {
        if (state.tessayaSkip) return;
        const { raw, cooked } = node.node.value;
        node.node.value = { raw: rebrand(raw), cooked: cooked == null ? cooked : rebrand(cooked) };
      },
      JSXText(node, state) {
        if (state.tessayaSkip) return;
        const next = rebrand(node.node.value);
        if (next !== node.node.value) {
          node.node.value = next;
          delete node.node.extra;
        }
      },
    },
  };
};

module.exports.rebrand = rebrand;

// The site runs the app's own character engine and three.js, copied in at build time, never kept as a second copy.
import * as NodeFS from "node:fs";
import * as NodeModule from "node:module";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const siteDir = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
const companionDir = NodePath.join(siteDir, "..", "web", "public", "companion");
const sharedDir = NodePath.join(siteDir, "public", "shared");
for (const name of ["rig.js", "bodies.js", "props.js", "speech.js"]) {
  NodeFS.copyFileSync(NodePath.join(companionDir, name), NodePath.join(sharedDir, name));
}
const threeBuild = NodePath.dirname(NodeModule.createRequire(import.meta.url).resolve("three"));
for (const name of ["three.module.min.js", "three.core.min.js"]) {
  NodeFS.copyFileSync(NodePath.join(threeBuild, name), NodePath.join(sharedDir, name));
}

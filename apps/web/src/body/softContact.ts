import * as THREE from "three";
import type { SoftContact } from "@t3tools/tessaya-shared/bodyRig";

const MAX_CONTACTS = 4;
const PARS = `uniform vec4 uContact[${MAX_CONTACTS}];uniform vec4 uContactNormal[${MAX_CONTACTS}];uniform int uContactCount;`;
// after skinning, in world space: skin at a contact gives along its normal, most at the centre and nothing at the
// edge; only the giving side's surface (what is at or below the contact plane), never what presses it
const DISPLACE = `
  if (uContactCount > 0) {
    vec3 cw = (modelMatrix * vec4(transformed, 1.0)).xyz;
    vec3 moved = cw;
    for (int i = 0; i < ${MAX_CONTACTS}; i++) {
      if (i >= uContactCount) break;
      vec3 n = uContactNormal[i].xyz;
      vec3 d = cw - uContact[i].xyz;
      float s = dot(d, n);
      float r = uContact[i].w;
      float side = clamp(1.0 - length(d - s * n) / r, 0.0, 1.0);
      float near = s > 0.005 ? 0.0 : clamp(1.0 + s / (0.5 * r), 0.0, 1.0);
      float k = side * side * (3.0 - 2.0 * side) * near;
      moved -= n * k * uContactNormal[i].w;
    }
    transformed = (inverse(modelMatrix) * vec4(moved, 1.0)).xyz;
  }`;

/**
 * Soft contact on every material of a model: where her parts meet, the skin gives a little. Costs nothing at rest
 * (uniforms change only on frames already drawn, and with no contact the shader skips the loop).
 */
export const softenOnContact = (root: THREE.Object3D) => {
  const uniforms = {
    uContact: { value: Array.from({ length: MAX_CONTACTS }, () => new THREE.Vector4()) },
    uContactNormal: { value: Array.from({ length: MAX_CONTACTS }, () => new THREE.Vector4()) },
    uContactCount: { value: 0 },
  };
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh) return;
    for (const mat of [mesh.material].flat()) {
      if (mat.userData["softContact"] === true) continue;
      mat.userData["softContact"] = true;
      // MToon compiles its own defines here: run it first, then add ours
      const before = mat.onBeforeCompile.bind(mat);
      mat.onBeforeCompile = (shader, renderer) => {
        before(shader, renderer);
        Object.assign(shader.uniforms, uniforms);
        shader.vertexShader = shader.vertexShader
          .replace("#include <common>", `#include <common>\n${PARS}`)
          .replace("#include <skinning_vertex>", `#include <skinning_vertex>\n${DISPLACE}`);
      };
      const key = mat.customProgramCacheKey.bind(mat);
      mat.customProgramCacheKey = () => `${key()}|softContact`;
      mat.needsUpdate = true;
    }
  });
  let shown = "";
  return {
    /** Sets this frame's contacts; true when they changed (the frame must be drawn). */
    set(contacts: ReadonlyArray<SoftContact>): boolean {
      const list = contacts.slice(0, MAX_CONTACTS);
      const key = list.map((c) => `${c.at.map((x) => x.toFixed(3))}:${c.depth.toFixed(4)}`).join();
      if (key === shown) return false;
      shown = key;
      list.forEach((c, i) => {
        uniforms.uContact.value[i]!.set(c.at[0], c.at[1], c.at[2], c.radius);
        uniforms.uContactNormal.value[i]!.set(c.normal[0], c.normal[1], c.normal[2], c.depth);
      });
      uniforms.uContactCount.value = list.length;
      return true;
    },
  };
};

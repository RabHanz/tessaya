/**
 * A model inspector on the light body's stack (three.js + three-vrm): load any VRM or GLB from bytes, orbit it, show
 * or hide each part, drive expressions and shape keys, pose any bone, swap textures, and save a thumbnail. Pages that
 * may only load same-origin scripts reach it as `window.tessayaBody.viewer`. It draws only while something changes
 * (a drag, a slider, spring bones settling), capped per frame, and not at all while hidden.
 */
import { VRMLoaderPlugin, VRMUtils, type VRM } from "@pixiv/three-vrm";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";

const MAX_FPS = 30;
/** Spring bones (hair, cloth) settle for this long after a change. */
const SETTLE_MS = 1200;

export type LightPreset = "studio" | "soft" | "warm" | "night" | "flat";

type Quat = [number, number, number, number];
export interface ViewerPose {
  readonly bones: Record<string, Quat>;
  readonly expressions: Record<string, number>;
  readonly morphs: Record<string, number>;
  readonly hidden: ReadonlyArray<string>;
}

export interface ViewerInfo {
  readonly vrm: boolean;
  /** One entry per glTF primitive, `mesh:primitive`, the same ids a glTF JSON reader gets. */
  readonly parts: ReadonlyArray<{
    readonly id: string;
    readonly mesh: string;
    readonly material: string;
  }>;
  readonly materials: ReadonlyArray<{ readonly name: string; readonly textured: boolean }>;
  readonly expressions: ReadonlyArray<string>;
  readonly morphs: ReadonlyArray<string>;
  /** `h:<humanoid bone>` for VRM humanoid bones, `n:<node name>` for every other joint. */
  readonly bones: ReadonlyArray<{ readonly key: string; readonly name: string }>;
}

export function mountViewer(canvas: HTMLCanvasElement) {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: true,
    alpha: true,
    powerPreference: "low-power",
  });
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 50);
  camera.position.set(0, 1.3, 3);
  const controls = new OrbitControls(camera, canvas);
  controls.target.set(0, 1, 0);
  controls.enableDamping = false;

  const ambient = new THREE.AmbientLight(0xffffff, 0.8);
  const key = new THREE.DirectionalLight(0xffffff, 1.4);
  const rim = new THREE.DirectionalLight(0xffffff, 0);
  const fill = new THREE.HemisphereLight(0xffffff, 0x444444, 0);
  scene.add(ambient, key, rim, fill);

  const loader = new GLTFLoader();
  loader.register((parser) => new VRMLoaderPlugin(parser));

  let root: THREE.Object3D | null = null;
  let vrm: VRM | null = null;
  let parts = new Map<string, THREE.Mesh>();
  let bones = new Map<string, THREE.Object3D>();
  let rest = new Map<string, THREE.Quaternion>();
  let morphs = new Map<string, Array<{ mesh: THREE.Mesh; index: number }>>();
  const morphWeights = new Map<string, number>();
  const originalMaps = new Map<THREE.Material, THREE.Texture | null>();
  let selected: string | null = null;
  let posing = false;
  let activeUntil = 0;
  let lastFrame = 0;
  let raf = 0;
  let disposed = false;
  let onScreen = document.visibilityState === "visible";

  const frame = (now: number) => {
    raf = 0;
    if (disposed || !onScreen) return;
    if (now - lastFrame < 1000 / MAX_FPS - 1) {
      raf = requestAnimationFrame(frame);
      return;
    }
    const dt = lastFrame === 0 ? 1 / MAX_FPS : Math.min(0.1, (now - lastFrame) / 1000);
    lastFrame = now;
    vrm?.update(dt);
    // shape keys set by hand sit on top of what the VRM's expressions wrote this frame
    for (const [name, w] of morphWeights)
      for (const { mesh, index } of morphs.get(name) ?? [])
        if (mesh.morphTargetInfluences)
          mesh.morphTargetInfluences[index] = Math.max(mesh.morphTargetInfluences[index] ?? 0, w);
    renderer.render(scene, camera);
    if (now < activeUntil) raf = requestAnimationFrame(frame);
    else lastFrame = 0;
  };
  const invalidate = (ms = 0) => {
    activeUntil = Math.max(activeUntil, performance.now() + ms);
    if (raf === 0 && !disposed && onScreen) raf = requestAnimationFrame(frame);
  };

  const resize = () => {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    invalidate();
  };
  // oxlint-disable-next-line t3code/no-raw-resize-observer -- not React: the helper would pull react-dom into the body script
  const sizer = new ResizeObserver(resize);
  sizer.observe(canvas);
  controls.addEventListener("change", () => invalidate());
  const onVisibility = () => {
    onScreen = document.visibilityState === "visible";
    if (onScreen) invalidate();
  };
  document.addEventListener("visibilitychange", onVisibility);

  const light = (preset: LightPreset) => {
    const set = (a: number, k: number, r: number, f: number, kc = 0xffffff, rc = 0xffffff) => {
      ambient.intensity = a;
      key.intensity = k;
      key.color.setHex(kc);
      rim.intensity = r;
      rim.color.setHex(rc);
      fill.intensity = f;
    };
    key.position.set(1, 2, 2.5);
    rim.position.set(-1.5, 1.8, -2);
    if (preset === "studio") set(0.5, 1.6, 1.2, 0.3);
    else if (preset === "soft") set(0.9, 0.6, 0.2, 0.9);
    else if (preset === "warm") set(0.5, 1.4, 0.8, 0.3, 0xffd2a6, 0xffa07a);
    else if (preset === "night") set(0.15, 0.4, 1.4, 0.1, 0x8899ff, 0xb070ff);
    else set(1.6, 0, 0, 0);
    invalidate();
  };

  const frameModel = () => {
    if (root === null) return;
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const center = box.getCenter(new THREE.Vector3());
    const dist = Math.max(size.y, size.x) / (2 * Math.tan((camera.fov * Math.PI) / 360)) + size.z;
    controls.target.copy(center);
    camera.position.set(center.x, center.y + size.y * 0.05, center.z + dist * 1.1);
    camera.near = dist / 100;
    camera.far = dist * 20;
    camera.updateProjectionMatrix();
    controls.update();
    invalidate();
  };

  const unload = () => {
    if (root === null) return;
    scene.remove(root);
    VRMUtils.deepDispose(root);
    root = null;
    vrm = null;
    parts = new Map();
    bones = new Map();
    rest = new Map();
    morphs = new Map();
    morphWeights.clear();
    originalMaps.clear();
    selected = null;
  };

  const load = async (bytes: ArrayBuffer): Promise<ViewerInfo> => {
    const gltf = await loader.parseAsync(bytes, "");
    unload();
    vrm = (gltf.userData["vrm"] as VRM | undefined) ?? null;
    if (vrm !== null) VRMUtils.rotateVRM0(vrm);
    root = vrm?.scene ?? gltf.scene;
    scene.add(root);
    const assoc = gltf.parser.associations;
    root.traverse((o) => {
      // GLTFLoader records the primitive index too; its types leave it out
      const a = assoc.get(o) as { meshes?: number; primitives?: number } | undefined;
      if (o instanceof THREE.Mesh && a?.meshes !== undefined) {
        parts.set(`${a.meshes}:${a.primitives ?? 0}`, o);
        o.frustumCulled = false;
        const dict = o.morphTargetDictionary ?? {};
        for (const [name, index] of Object.entries(dict))
          morphs.set(name, [...(morphs.get(name) ?? []), { mesh: o, index }]);
      }
    });
    const humanNodes = new Set<THREE.Object3D>();
    if (vrm !== null)
      for (const name of Object.keys(vrm.humanoid.humanBones)) {
        const node = vrm.humanoid.getNormalizedBoneNode(name as never);
        const raw = vrm.humanoid.getRawBoneNode(name as never);
        if (node !== null) bones.set(`h:${name}`, node);
        if (raw !== null) humanNodes.add(raw);
      }
    const joints = new Set<THREE.Object3D>();
    root.traverse((o) => {
      if (o instanceof THREE.SkinnedMesh) for (const b of o.skeleton.bones) joints.add(b);
    });
    for (const j of joints)
      if (!humanNodes.has(j) && !bones.has(`n:${j.name}`)) bones.set(`n:${j.name}`, j);
    for (const [k, b] of bones) rest.set(k, b.quaternion.clone());
    const materials = new Map<string, boolean>();
    for (const m of parts.values())
      for (const mat of [m.material].flat())
        materials.set(
          mat.name,
          materials.get(mat.name) === true || (mat as THREE.MeshStandardMaterial).map != null,
        );
    frameModel();
    invalidate(SETTLE_MS);
    return {
      vrm: vrm !== null,
      parts: [...parts].map(([id, m]) => ({
        id,
        mesh: m.parent?.name || m.name,
        material: [m.material].flat()[0]?.name ?? "",
      })),
      materials: [...materials].map(([name, textured]) => ({ name, textured })),
      expressions: vrm?.expressionManager?.expressions.map((e) => e.expressionName) ?? [],
      morphs: [...morphs.keys()],
      bones: [...bones.keys()].map((k) => ({ key: k, name: k.slice(2) })),
    };
  };

  const setVisible = (id: string, on: boolean) => {
    const m = parts.get(id);
    if (m) m.visible = on;
    invalidate(SETTLE_MS);
  };
  const setExpression = (name: string, w: number) => {
    vrm?.expressionManager?.setValue(name, w);
    invalidate(SETTLE_MS);
  };
  const setMorph = (name: string, w: number) => {
    if (w <= 0) {
      morphWeights.delete(name);
      for (const { mesh, index } of morphs.get(name) ?? [])
        if (mesh.morphTargetInfluences) mesh.morphTargetInfluences[index] = 0;
    } else morphWeights.set(name, w);
    invalidate(SETTLE_MS);
  };
  /** A bone's rotation as euler radians from its rest pose. */
  const boneEuler = (k: string): [number, number, number] => {
    const b = bones.get(k);
    const r = rest.get(k);
    if (!b || !r) return [0, 0, 0];
    const e = new THREE.Euler().setFromQuaternion(r.clone().invert().multiply(b.quaternion));
    return [e.x, e.y, e.z];
  };
  const springAware = () => {
    // a posed spring joint becomes its new rest, so the simulation swings around it instead of undoing it
    vrm?.springBoneManager?.setInitState();
    vrm?.springBoneManager?.reset();
  };
  const setBone = (k: string, euler: readonly [number, number, number]) => {
    const b = bones.get(k);
    const r = rest.get(k);
    if (!b || !r) return;
    b.quaternion.copy(r).multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(...euler)));
    if (k.startsWith("n:")) springAware();
    invalidate(SETTLE_MS);
  };

  const pose = (): ViewerPose => ({
    bones: Object.fromEntries(
      [...bones]
        .filter(([k, b]) => !b.quaternion.equals(rest.get(k)!))
        .map(([k, b]) => [k, b.quaternion.toArray() as Quat]),
    ),
    expressions: Object.fromEntries(
      (vrm?.expressionManager?.expressions ?? [])
        .filter((e) => e.weight > 0)
        .map((e) => [e.expressionName, e.weight]),
    ),
    morphs: Object.fromEntries(morphWeights),
    hidden: [...parts].filter(([, m]) => !m.visible).map(([id]) => id),
  });
  const reset = () => {
    for (const [k, b] of bones) b.quaternion.copy(rest.get(k)!);
    for (const e of vrm?.expressionManager?.expressions ?? []) e.weight = 0;
    for (const name of morphWeights.keys()) setMorph(name, 0);
    for (const m of parts.values()) m.visible = true;
    springAware();
    invalidate(SETTLE_MS);
  };
  const applyPose = (p: Partial<ViewerPose>) => {
    reset();
    for (const [k, q] of Object.entries(p.bones ?? {})) bones.get(k)?.quaternion.fromArray(q);
    for (const [n, w] of Object.entries(p.expressions ?? {}))
      vrm?.expressionManager?.setValue(n, w);
    for (const [n, w] of Object.entries(p.morphs ?? {})) setMorph(n, w);
    for (const id of p.hidden ?? []) setVisible(id, false);
    springAware();
    invalidate(SETTLE_MS);
  };

  const materialsNamed = (name: string) =>
    [...parts.values()]
      .flatMap((m) => [m.material].flat())
      .filter((mat) => mat.name === name) as Array<THREE.MeshStandardMaterial>;
  /** Puts an image on every material with this name, or puts the original back with null. */
  const setTexture = (
    name: string,
    image: ImageBitmap | HTMLImageElement | HTMLCanvasElement | null,
  ) => {
    for (const mat of materialsNamed(name)) {
      if (!originalMaps.has(mat)) originalMaps.set(mat, mat.map ?? null);
      const was = originalMaps.get(mat) ?? null;
      if (image === null) mat.map = was;
      else {
        const tex = new THREE.Texture(image);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.flipY = false;
        if (was) {
          tex.wrapS = was.wrapS;
          tex.wrapT = was.wrapT;
        }
        tex.needsUpdate = true;
        mat.map = tex;
      }
      mat.needsUpdate = true;
    }
    invalidate();
  };
  /** The material's own texture as an image he can save, edit and drop back. */
  const textureImage = (name: string): HTMLCanvasElement | null => {
    const tex = materialsNamed(name)[0]?.map;
    const img = tex?.image as (CanvasImageSource & { width: number; height: number }) | undefined;
    if (!img) return null;
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    c.getContext("2d")?.drawImage(img, 0, 0);
    return c;
  };

  /** The bone nearest to where he tapped the model, or null when the tap missed it. */
  const pick = (clientX: number, clientY: number): string | null => {
    if (root === null) return null;
    const rect = canvas.getBoundingClientRect();
    const ray = new THREE.Raycaster();
    ray.setFromCamera(
      new THREE.Vector2(
        ((clientX - rect.left) / rect.width) * 2 - 1,
        -((clientY - rect.top) / rect.height) * 2 + 1,
      ),
      camera,
    );
    const hit = ray.intersectObject(root, true).find((h) => h.object.visible)?.point;
    if (!hit) return null;
    let best: string | null = null;
    let bestD = Infinity;
    const p = new THREE.Vector3();
    for (const [k, b] of bones) {
      const d = b.getWorldPosition(p).distanceToSquared(hit);
      if (d < bestD) [best, bestD] = [k, d];
    }
    return best;
  };

  // Pose by drag: with posing on, a drag turns the selected bone (sideways about up, up and down about across).
  let drag: { x: number; y: number; from: [number, number, number] } | null = null;
  const onDown = (e: PointerEvent) => {
    if (!posing) return;
    const k = pick(e.clientX, e.clientY) ?? selected;
    if (k === null) return;
    selected = k;
    canvas.dispatchEvent(new CustomEvent("boneselect", { detail: k }));
    drag = { x: e.clientX, y: e.clientY, from: boneEuler(k) };
    canvas.setPointerCapture(e.pointerId);
  };
  const onMove = (e: PointerEvent) => {
    if (!drag || selected === null) return;
    const [x, y, z] = drag.from;
    setBone(selected, [x + (e.clientY - drag.y) * 0.01, y + (e.clientX - drag.x) * 0.01, z]);
    canvas.dispatchEvent(new CustomEvent("bonechange", { detail: selected }));
  };
  const onUp = () => {
    drag = null;
  };
  canvas.addEventListener("pointerdown", onDown);
  canvas.addEventListener("pointermove", onMove);
  canvas.addEventListener("pointerup", onUp);
  canvas.addEventListener("pointercancel", onUp);

  const setPosing = (on: boolean) => {
    posing = on;
    controls.enabled = !on;
  };

  /** A square PNG of what is on screen now, for a library thumbnail. */
  const snapshot = (size = 256): string => {
    vrm?.update(0);
    renderer.render(scene, camera);
    const c = document.createElement("canvas");
    c.width = size;
    c.height = size;
    const s = Math.min(canvas.width, canvas.height);
    c.getContext("2d")?.drawImage(
      canvas,
      (canvas.width - s) / 2,
      (canvas.height - s) / 2,
      s,
      s,
      0,
      0,
      size,
      size,
    );
    return c.toDataURL("image/png");
  };

  light("studio");
  resize();

  return {
    load,
    unload,
    light,
    frame: frameModel,
    setVisible,
    setExpression,
    setMorph,
    setBone,
    boneEuler,
    select: (k: string | null) => void (selected = k),
    selected: () => selected,
    setPosing,
    pose,
    applyPose,
    reset,
    setTexture,
    textureImage,
    snapshot,
    dispose: () => {
      disposed = true;
      if (raf !== 0) cancelAnimationFrame(raf);
      sizer.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onUp);
      controls.dispose();
      unload();
      renderer.dispose();
    },
  };
}

export type ModelViewer = ReturnType<typeof mountViewer>;

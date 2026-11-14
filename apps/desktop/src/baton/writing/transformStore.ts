// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import {
  allTransforms,
  DEFAULT_TRANSFORMS,
  TRANSFORMS_MAX,
  type Transform,
} from "@t3tools/tessaya-shared/transforms";

import { createJsonStore } from "./jsonStore.ts";

export interface TransformSettings {
  /** Off until he opts in: the hotkeys are only registered while it is on. */
  readonly enabled: boolean;
  /** The id applied to every dictation, or null. */
  readonly autoApply: string | null;
  readonly custom: ReadonlyArray<Transform>;
  /** Command mode: spoken edits of the selection and the text around the caret. Off until he turns it on. */
  readonly command?: boolean;
}

const OFF: TransformSettings = { enabled: false, autoApply: null, custom: [] };

const valid = (v: unknown): v is TransformSettings =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as TransformSettings).enabled === "boolean" &&
  Array.isArray((v as TransformSettings).custom);

export const createTransformStore = (stateDir: string) => {
  const store = createJsonStore<TransformSettings>(
    NodePath.join(stateDir, "transforms.json"),
    OFF,
    valid,
  );
  const update = (patch: Partial<TransformSettings>) => store.write({ ...store.read(), ...patch });
  return {
    read: store.read,
    all: (): ReadonlyArray<Transform> => allTransforms(store.read().custom),
    setCommand: (command: boolean) => update({ command }),
    setEnabled: (enabled: boolean) => update({ enabled }),
    setAutoApply: (autoApply: string | null) => update({ autoApply }),
    /** False when his own set is full. */
    put: (t: Transform): boolean => {
      const rest = store.read().custom.filter((c) => c.id !== t.id);
      if (rest.length >= TRANSFORMS_MAX) return false;
      update({ custom: [...rest, t] });
      return true;
    },
    /** A built-in cannot be removed, only replaced by his own of the same name. */
    remove: (id: string): boolean => {
      if (!store.read().custom.some((c) => c.id === id)) return false;
      update({ custom: store.read().custom.filter((c) => c.id !== id) });
      return true;
    },
    reset: () => update({ custom: [], autoApply: null }),
    defaults: DEFAULT_TRANSFORMS,
  };
};
export type TransformStore = ReturnType<typeof createTransformStore>;

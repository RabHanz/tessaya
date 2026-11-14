// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";

import {
  DEFAULT_STYLES,
  STYLE_CATEGORIES,
  STYLES,
  type StyleCategory,
  type StyleChoices,
  type WritingStyle,
} from "@t3tools/tessaya-shared/writingStyle";

import { createJsonStore } from "./jsonStore.ts";

const valid = (v: unknown): v is StyleChoices =>
  typeof v === "object" &&
  v !== null &&
  STYLE_CATEGORIES.every((c) =>
    (STYLES as ReadonlyArray<unknown>).includes((v as StyleChoices)[c]),
  );

export const createStyleStore = (stateDir: string) => {
  const store = createJsonStore<StyleChoices>(
    NodePath.join(stateDir, "writing-style.json"),
    DEFAULT_STYLES,
    valid,
  );
  return {
    read: store.read,
    set: (category: StyleCategory, style: WritingStyle) =>
      store.write({ ...store.read(), [category]: style }),
    reset: () => store.write(DEFAULT_STYLES),
  };
};
export type StyleStore = ReturnType<typeof createStyleStore>;

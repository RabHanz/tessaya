/**
 * Tessaya's own cursor while she acts (the pointer layer's glide): where it goes and the few words it carries. His real
 * pointer never moves; this only shows him what she is doing and where.
 */

type Point = { readonly x: number; readonly y: number };

export type Act =
  | { readonly kind: "click"; readonly name?: string | undefined; readonly double?: boolean }
  | { readonly kind: "type" }
  | { readonly kind: "press"; readonly keys: ReadonlyArray<string> };

const KEY_NAMES: Readonly<Record<string, string>> = {
  ctrl: "Ctrl",
  control: "Ctrl",
  alt: "Alt",
  shift: "Shift",
  win: "Win",
  meta: "Win",
  cmd: "Cmd",
  enter: "Enter",
  return: "Enter",
  esc: "Esc",
  escape: "Esc",
  tab: "Tab",
  space: "Space",
  backspace: "Backspace",
  delete: "Delete",
};

/** The control's name in three words or fewer, "Typing", or the keys as he would write them ("Ctrl+S"). */
export const actLabel = (act: Act): string => {
  if (act.kind === "type") return "Typing";
  if (act.kind === "press") {
    return act.keys
      .map((k) => {
        const key = k.trim().toLowerCase();
        return (
          KEY_NAMES[key] ??
          (key.length === 1 ? key.toUpperCase() : key.charAt(0).toUpperCase() + key.slice(1))
        );
      })
      .join("+");
  }
  const words = (act.name ?? "").trim().split(/\s+/).filter(Boolean).slice(0, 3).join(" ");
  if (words === "") return act.double === true ? "Double-click" : "Click";
  return words.length > 24 ? `${words.slice(0, 23)}…` : words;
};

/** Where the cursor goes: the control itself when it is known, else where she last acted, else the window's middle. */
export const actTarget = (places: {
  readonly control?: Point | null | undefined;
  readonly last?: Point | null | undefined;
  readonly window?: Point | null | undefined;
}): Point | null => places.control ?? places.last ?? places.window ?? null;

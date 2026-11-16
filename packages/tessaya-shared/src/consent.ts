/**
 * His standing yeses ("Always allow"), one list on his server (`baton.consent.*`) that every vessel reads; the desktop
 * keeps a copy for when the server is away. A yes counts only for him, so a guest is still asked.
 */

/** Seeing his screen: the one key every look path (the desktop's own, a device's, the phone's) checks. */
export const LOOK_GRANT = "screen_look";

/** His "this is my voice, or I have their permission" for one clone; revoking it silences that clone. */
export const cloneGrant = (id: string): string => `voice_clone|${id}`;

export const GRANTS_MAX = 50;

/** One act he answered "Always allow" to: the tool, the reason it asks, and the app (none for a job act). */
export const standingKey = (tool: string, why: string, app = ""): string => `${tool}|${why}|${app}`;

export const withGrant = (keys: ReadonlyArray<string>, key: string, allow: boolean): string[] =>
  allow
    ? [...keys.filter((k) => k !== key), key].slice(-GRANTS_MAX)
    : keys.filter((k) => k !== key);

/**
 * A standing yes holds only for him: at his own keyboard, or his voice verified on this turn (Voice ID's session hold
 * counts). Any other voice, a guest's or an unverified one, is asked as before.
 */
export const stands = (
  keys: ReadonlyArray<string>,
  key: string,
  who: { readonly his: boolean },
): boolean => who.his && keys.includes(key);

/**
 * Whether a look at his screen must ask. His own turn (keyboard, phone, web) looks once he said Always allow, or within
 * an hour he allowed. A device's turn looks on his verified voice (or his "devices may look"), one look at a time;
 * any other voice is asked, whatever he allowed.
 */
export const lookAsks = (input: {
  readonly keys: ReadonlyArray<string>;
  readonly deviceTurn: boolean;
  readonly mayLook: boolean;
  readonly allowedUntil: number;
  readonly now: number;
}): boolean =>
  input.deviceTurn
    ? !input.mayLook
    : !stands(input.keys, LOOK_GRANT, { his: true }) && input.now >= input.allowedUntil;

/** A key in his words, for Settings and for her to read back: "Tessaya job schedule (asks before scheduling)". */
export const grantLabel = (key: string): string => {
  if (key === LOOK_GRANT) return "Seeing your screen";
  if (key.startsWith(cloneGrant(""))) return "A cloned voice (yours, or theirs with permission)";
  const [tool = key, why = "", app = ""] = key.split("|");
  const what = tool.replace(/^tessaya_/, "").replace(/_/g, " ");
  return `${what[0]?.toUpperCase() ?? ""}${what.slice(1)}${app === "" ? "" : ` in ${app}`}${why === "" ? "" : ` (${why.replace(/\.$/, "")})`}`;
};

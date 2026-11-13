/**
 * What he says to stop her mid-reply, on every surface (13 Nov: he could not stop or dismiss her while she spoke).
 * Over her own voice only these count, so her playback and the room cannot start a turn; her name counts too, but
 * that is each surface's own name check. A user's own phrases extend the list (voice settings).
 */
const DISMISS = [
  "dismissed",
  "that's all",
  "that will be all",
  "that'll be all",
  "go to sleep",
  "goodbye",
  "good night",
  "stop listening",
];
const STOP = [
  "stop",
  "stop talking",
  "stop it",
  "enough",
  "that's enough",
  "be quiet",
  "quiet",
  "shush",
  "shut up",
  "never mind",
  "nevermind",
  "cancel",
  "hold on",
];

const plain = (text: string) =>
  text
    .toLowerCase()
    .replace(/[’‘]/g, "'")
    .replace(/[^a-z' ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/**
 * "dismiss" or "stop" when the line is one of those phrases (with a few words around it at most: "okay, stop",
 * "stop, stop", "enough, thanks"), else null. A long sentence that merely contains "stop" is not one.
 */
export const stopIntent = (
  text: string,
  extra: ReadonlyArray<string> = [],
): "dismiss" | "stop" | null => {
  const said = plain(text);
  if (said === "" || said.split(" ").length > 5) return null;
  const has = (phrase: string) => ` ${said} `.includes(` ${plain(phrase)} `);
  if (DISMISS.some(has)) return "dismiss";
  return STOP.some(has) || extra.filter((p) => plain(p) !== "").some(has) ? "stop" : null;
};

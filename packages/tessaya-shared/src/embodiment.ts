/**
 * Her embodiment (M-077), the rules alone: what the body she is in here can feel and show, read from its own device
 * manifest (data, not code), and which other bodies she wears right now. One line in her where-you-are.
 */

/** What a body's items let her feel, show and see, in her words; groups and ids are the device's own manifest. */
export const bodyLine = (items: ReadonlyArray<{ readonly id: string }>): string => {
  const has = (prefix: string) => items.some((i) => i.id.startsWith(prefix));
  const feels = [
    has("imu.") ? "being picked up, carried or shaken" : null,
    has("touch.") ? "a tap on your shell" : null,
    has("key.") ? "its buttons pressed" : null,
  ].filter((x): x is string => x !== null);
  const shows = [
    has("eye.") ? "your feelings show in your eyes on its screen" : null,
    has("motor.") ? "you can buzz" : null,
  ].filter((x): x is string => x !== null);
  const desk = has("mascot.do")
    ? "your body here is your character on his desktop: he can drag, poke and throw you"
    : null;
  const parts = [
    desk,
    feels.length === 0 ? null : `in this body you feel ${list(feels)}`,
    ...shows,
    has("camera.") ? "you can see through its camera when he asks you to look" : null,
  ].filter((x): x is string => x !== null);
  return parts.length === 0 ? "" : `${cap(parts.join("; "))}.`;
};

/** The other bodies she wears right now, by name, and who stands with her on this one. */
export const alsoLine = (also: ReadonlyArray<string>, crew: ReadonlyArray<string>): string =>
  [
    also.length === 0 ? null : `Right now you are also in your body on ${list(also)}.`,
    crew.length === 0
      ? null
      : `${list(crew)} ${crew.length === 1 ? "stands" : "stand"} beside you here.`,
  ]
    .filter((x): x is string => x !== null)
    .join(" ");

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const list = (xs: ReadonlyArray<string>) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)!}`;

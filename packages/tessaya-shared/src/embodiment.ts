/**
 * Her embodiment (M-077), the rules alone: what the body she is in here can feel and show, read from its own device
 * manifest (data, not code), and which other bodies she wears right now. One line in her where-you-are.
 */

/** What a body's items let her feel, show and see, in her words; groups and ids are the device's own manifest. */
export const bodyLine = (items: ReadonlyArray<{ readonly id: string }>): string => {
  const has = (prefix: string) => items.some((i) => i.id.startsWith(prefix));
  const feels = [
    has("imu.") ? "being picked up, carried or shaken" : null,
    has("skin.screen") ? "his fingers on you through the screen" : null,
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
  // his phone as her body (a Sleeve): what it lets her do for him, all handed to him to finish
  const phone = [
    has("phone.call") ? "open a call for him (he presses call)" : null,
    has("phone.message") ? "open a text for him (he presses send)" : null,
    has("phone.share") ? "hand something to any app through his share sheet" : null,
    has("phone.notify") ? "leave a note on his lock screen" : null,
  ].filter((x): x is string => x !== null);
  const parts = [
    desk,
    phone.length === 0
      ? null
      : `your body here is his phone, a Sleeve: you can ${list(phone)}, through device_set on its items`,
    feels.length === 0 ? null : `in this body you feel ${list(feels)}`,
    ...shows,
    has("camera.") ? "you can see through its camera when he asks you to look" : null,
  ].filter((x): x is string => x !== null);
  return parts.length === 0 ? "" : `${cap(parts.join("; "))}.`;
};

/** The other bodies she wears right now, by name, and who stands with her on this one. */
/** One of her other bodies as the Cast holds it now (live, per turn), for "what about your other bodies?". */
export interface BodyNow {
  readonly name: string;
  readonly kind: string;
  readonly online: boolean | null;
  /** The persona wearing it; `you` when it is the one this turn speaks as. */
  readonly wearer: string | null;
  readonly you: boolean;
  /** A desk body: on screen or hidden, and which screen, as its desktop reported. */
  readonly shown?: boolean;
  readonly screen?: string;
}

const bodyState = (b: BodyNow): string => {
  if (b.online === false) return "offline";
  const where =
    b.kind !== "desktop"
      ? "on"
      : b.shown === false
        ? "hidden on his desktop"
        : b.shown === true
          ? `on his desktop${b.screen === undefined ? "" : ` (${b.screen})`}`
          : "on his desktop";
  const who = b.you ? "you wear it" : b.wearer === null ? null : `${b.wearer} wears it`;
  return who === null ? where : `${where}, ${who}`;
};

/**
 * Her other bodies, each with its live state, and who stands with her here (the Director, 20 Nov: she said her desk body
 * was not on his desk while it was). Empty when she has no other body.
 */
export const alsoLine = (also: ReadonlyArray<BodyNow>, crew: ReadonlyArray<string>): string =>
  [
    also.length === 0
      ? null
      : `Your other bodies right now, live: ${also
          .slice(0, 6)
          .map((b) => `${b.name} (${bodyState(b)})`)
          .join("; ")}. Answer about them from this, not from memory.`,
    crew.length === 0
      ? null
      : `${list(crew)} ${crew.length === 1 ? "stands" : "stand"} beside you here.`,
  ]
    .filter((x): x is string => x !== null)
    .join(" ");

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const list = (xs: ReadonlyArray<string>) =>
  xs.length <= 1 ? (xs[0] ?? "") : `${xs.slice(0, -1).join(", ")} and ${xs.at(-1)!}`;

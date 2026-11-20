import type { BodyCue } from "@t3tools/tessaya-shared/bodyCues";
import { renderFor, VESSELS } from "@t3tools/tessaya-shared/expressionMap";

import type { DesktopMascot } from "./desktopMascot.ts";

/** The mascot's speech, level and mood also go to the 3D body as cues: one source drives both bodies. */
export const mirrorBody = (
  m: DesktopMascot,
  send: ((c: BodyCue & { readonly forPersona?: string }) => void) | undefined,
  persona: () => string | undefined,
): DesktopMascot => {
  if (send === undefined) return m;
  // each cue names the persona the character is showing: a body that is one persona's alone takes only hers
  const cue = (c: BodyCue) => {
    const p = persona();
    send(p === undefined ? c : { ...c, forPersona: p });
  };
  let speaking = false;
  // the hat her full body wears now (renderFor for its form), sent only when it changes
  let held: string | null = null;
  return {
    ...m,
    turn: (phase) => {
      m.turn(phase);
      if (speaking && phase !== "speaking") cue({ kind: "silent" });
      speaking = phase === "speaking";
    },
    level: (value, shape) => {
      m.level(value, shape);
      if (speaking)
        cue({ kind: "level", value, ...(shape?.viseme ? { viseme: shape.viseme } : {}) });
    },
    mood: (label, intensity, props) => {
      m.mood(label, intensity, props);
      cue({ kind: "mood", mood: label, intensity });
      const prop = renderFor(VESSELS.body, label, intensity, props).prop ?? null;
      if (prop !== held)
        cue(
          prop === null
            ? { kind: "prop", id: "state" }
            : { kind: "prop", id: "state", url: `builtin:${prop}` },
        );
      held = prop;
    },
  };
};

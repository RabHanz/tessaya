/**
 * Settings → Privacy → Face check and Palm check. Ids start with `rs.` so they land on the Privacy tab, and every
 * toggle is published for voice (remoteSettings.ts): turning a check on, enrolling a member and deleting their
 * template all work by voice. Turning on is the owner's (his yes on his phone); deleting is always possible.
 */
import type { HomeControl } from "../home/tessayaHome.ts";

export const FACE_ON = "rs.face.on";
export const FACE_MEMBER = "rs.face.m:";
export const FACE_RESUME = "rs.face.resume";
export const PALM_ON = "rs.palm.on";
export const PALM_MEMBER = "rs.palm.m:";
export const PALM_RESUME = "rs.palm.resume";

const COPY = {
  face: {
    section: "Face check",
    on: FACE_ON,
    member: FACE_MEMBER,
    resume: FACE_RESUME,
    hint: "The webcam looks only when Tessaya asks: to end an approval early when you walk away, to hide private things and hold a spoken yes when someone else is in view, and to tell who is at the computer. Face alone means 'probably you'; with your voice it can approve ordinary asks, never risky ones.",
    yours: "Your face",
    theirs: (name: string) => `${name}'s face`,
    consent:
      "They look at the camera while this turns on: that is their consent. Only their face template is kept, sealed to this computer.",
    rest: "Several face checks failed in a row, so face is resting. Turn it back on once you know why.",
  },
  palm: {
    section: "Palm check",
    on: PALM_ON,
    member: PALM_MEMBER,
    resume: PALM_RESUME,
    hint: "The webcam reads your palm print only when Tessaya asks, with a few finger moves and the screen flashing colours so a photo cannot pass. Palm alone means at most 'probably you'; with your face it counts as a second kind of proof. A webcam cannot see veins, so a print held over a real hand can fool it.",
    yours: "Your palm",
    theirs: (name: string) => `${name}'s palm`,
    consent:
      "They hold their open palm to the camera and follow the finger moves while this turns on: that is their consent. Only their palm template is kept, sealed to this computer.",
    rest: "Several palm checks failed in a row, so palm is resting. Turn it back on once you know why.",
  },
} as const;

export interface FaceRowsView {
  readonly platform: string;
  readonly engineFound: boolean;
  readonly on: boolean;
  readonly limited: boolean;
  /** What the engine is asking the person at the camera to do right now. */
  readonly status: string | null;
  readonly members: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly you: boolean;
    readonly enrolled: boolean;
  }>;
}

export const faceControls = (
  v: FaceRowsView,
  modality: "face" | "palm" = "face",
): ReadonlyArray<HomeControl> => {
  if (v.platform !== "win32") return [];
  const c = COPY[modality];
  const SECTION = c.section;
  const rows: HomeControl[] = [
    {
      id: c.on,
      section: SECTION,
      kind: "toggle",
      on: v.on && v.engineFound,
      label: c.section,
      hint: v.engineFound ? c.hint : "Needs the face engine from face-unlock on this computer.",
      voice: "owner",
      ...(v.engineFound ? {} : { disabled: true }),
    },
  ];
  for (const m of v.members)
    rows.push({
      id: `${c.member}${m.id}`,
      section: SECTION,
      kind: "toggle",
      on: m.enrolled,
      label: m.you ? c.yours : c.theirs(m.name),
      hint: m.enrolled ? `Off deletes their ${modality} template at once.` : c.consent,
      voice: "confirm",
      // Deleting stays possible with the check off; enrolling needs it on.
      ...(m.enrolled || (v.on && v.engineFound) ? {} : { disabled: true }),
    });
  if (v.status !== null)
    rows.push({
      id: `rs.${modality}.status`,
      section: SECTION,
      kind: "check",
      status: "ok",
      label: v.status,
      detail: "",
    });
  if (v.limited)
    rows.push({
      id: c.resume,
      section: SECTION,
      kind: "action",
      label: "Paused after failed checks",
      hint: c.rest,
      button: "Turn back on",
    });
  return rows;
};

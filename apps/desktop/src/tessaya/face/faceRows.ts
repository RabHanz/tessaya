/**
 * Settings → Privacy → Face check. Ids start with `rs.` so they land on the Privacy tab, and every toggle is
 * published for voice (remoteSettings.ts): turning it on, enrolling a member and deleting their face all work by
 * voice. Turning on is the owner's (his yes on his phone); deleting is always possible, even with the check off.
 */
import type { HomeControl } from "../home/tessayaHome.ts";

const SECTION = "Face check";
export const FACE_ON = "rs.face.on";
export const FACE_MEMBER = "rs.face.m:";
export const FACE_RESUME = "rs.face.resume";

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

export const faceControls = (v: FaceRowsView): ReadonlyArray<HomeControl> => {
  if (v.platform !== "win32") return [];
  const rows: HomeControl[] = [
    {
      id: FACE_ON,
      section: SECTION,
      kind: "toggle",
      on: v.on && v.engineFound,
      label: "Face check",
      hint: v.engineFound
        ? "The webcam looks only when Tessaya asks: to end an approval early when you walk away, to hide private things and hold a spoken yes when someone else is in view, and to tell who is at the computer. Face alone means 'probably you'; with your voice it can approve ordinary asks, never risky ones."
        : "Needs the face engine from face-unlock on this computer.",
      voice: "owner",
      ...(v.engineFound ? {} : { disabled: true }),
    },
  ];
  for (const m of v.members)
    rows.push({
      id: `${FACE_MEMBER}${m.id}`,
      section: SECTION,
      kind: "toggle",
      on: m.enrolled,
      label: m.you ? "Your face" : `${m.name}'s face`,
      hint: m.enrolled
        ? "Off deletes their face template at once."
        : "They look at the camera while this turns on: that is their consent. Only their face template is kept, sealed to this computer.",
      voice: "confirm",
      // Deleting stays possible with the check off; enrolling needs it on.
      ...(m.enrolled || (v.on && v.engineFound) ? {} : { disabled: true }),
    });
  if (v.status !== null)
    rows.push({
      id: "rs.face.status",
      section: SECTION,
      kind: "check",
      status: "ok",
      label: v.status,
      detail: "",
    });
  if (v.limited)
    rows.push({
      id: FACE_RESUME,
      section: SECTION,
      kind: "action",
      label: "Paused after failed checks",
      hint: "Several face checks failed in a row, so face is resting. Turn it back on once you know why.",
      button: "Turn back on",
    });
  return rows;
};

/**
 * The light body as one same-origin script (`/assets/tessaya-body.js`), for pages outside the app that may only load
 * scripts from 'self': an owner-only layer's private window on the desktop, web and phone. It adds `window.tessayaBody`,
 * with the model inspector beside the body, and the pure control language so a page (the owner's playground) can compile
 * moves and scenes for its own body without the server.
 */
import { BODY_CAPABILITIES, decodeBodyMove, moveCues } from "@t3tools/tessaya-shared/bodyControl";
import { BODY_FACES, GESTURES, lineCues } from "@t3tools/tessaya-shared/bodyCues";
import { locateOnDesk } from "@t3tools/tessaya-shared/bodyLocomotion";
import { HUMAN_SENSE } from "@t3tools/tessaya-shared/bodySense";
import { ACT_NAMES } from "@t3tools/tessaya-shared/bodyMotion";
import { HAND_PLACES, INVOLUNTARY } from "@t3tools/tessaya-shared/bodyPlanner";
import { JOINT_LIMITS, REFERENCE_RIG } from "@t3tools/tessaya-shared/bodyRig";
import {
  branchFor,
  CORE_SCENES,
  decodeScene,
  decodeScenePack,
  dryRun,
  poseAt,
  sceneCues,
} from "@t3tools/tessaya-shared/bodyScene";

import { mountViewer } from "./modelViewer";
import { mountBody } from "./vrmBody";

declare global {
  interface Window {
    tessayaBody?: {
      readonly mount: typeof mountBody;
      readonly lineCues: typeof lineCues;
      readonly viewer: typeof mountViewer;
      readonly control: typeof control;
    };
  }
}

const control = {
  // where another persona stands on his desk, from the places the desktop sends (vrmBody's `locate`)
  locateOnDesk,
  decodeBodyMove,
  moveCues,
  decodeScene,
  sceneCues,
  dryRun,
  branchFor,
  poseAt,
  decodeScenePack,
  CORE_SCENES,
  INVOLUNTARY,
  JOINT_LIMITS,
  REFERENCE_RIG,
  BODY_CAPABILITIES,
  ACT_NAMES,
  GESTURES,
  BODY_FACES,
  // the general human sense pack's regions, under the name pages already read
  TOUCH_ZONES: HUMAN_SENSE.regions.map((r) => r.id),
  HUMAN_SENSE,
  HAND_PLACES,
};

/** The control language a page drives its own body with (the playground reads it off `window.tessayaBody`). */
export type BodyControl = typeof control;

window.tessayaBody = { mount: mountBody, lineCues, viewer: mountViewer, control };

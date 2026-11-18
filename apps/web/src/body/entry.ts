/**
 * The light body as one same-origin script (`/assets/tessaya-body.js`), for pages outside the app that may only load
 * scripts from 'self': an owner-only layer's private window on the desktop, web and phone. It adds `window.tessayaBody`,
 * with the model inspector beside the body.
 */
import { lineCues } from "@t3tools/tessaya-shared/bodyCues";

import { mountViewer } from "./modelViewer";
import { mountBody } from "./vrmBody";

declare global {
  interface Window {
    tessayaBody?: {
      readonly mount: typeof mountBody;
      readonly lineCues: typeof lineCues;
      readonly viewer: typeof mountViewer;
    };
  }
}

window.tessayaBody = { mount: mountBody, lineCues, viewer: mountViewer };

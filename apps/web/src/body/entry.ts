/**
 * The light body as one same-origin script (`/assets/tessaya-body.js`), for pages outside the app that may only load
 * scripts from 'self': an owner-only layer's private window on the desktop, web and phone. It adds `window.tessayaBody`.
 */
import { lineCues } from "@t3tools/tessaya-shared/bodyCues";

import { mountBody } from "./vrmBody";

declare global {
  interface Window {
    tessayaBody?: { readonly mount: typeof mountBody; readonly lineCues: typeof lineCues };
  }
}

window.tessayaBody = { mount: mountBody, lineCues };

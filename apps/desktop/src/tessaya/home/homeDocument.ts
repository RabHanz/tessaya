import { APP_CSS } from "./appStyle.ts";
import { APP_SCRIPT } from "./appScript.ts";

/**
 * The page behind Baton's own window (D140). The shell is fixed here; every tab is drawn by
 * `appScript.ts` from the state the main process sends. Outside Electron it reads
 * `window.__BATON_STATE__`, so a browser can show every tab.
 */
export const HOME_DOCUMENT = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Tessaya</title><style>${APP_CSS}</style></head><body><a class="skip" href="#panel">Skip to the page</a><div id="app"><aside id="side" aria-label="Sidebar"></aside><div id="main"><header id="top"></header><main id="panel" tabindex="-1" aria-label="Tessaya"><div id="page"></div></main></div></div><script>${APP_SCRIPT}</script></body></html>`;

/** The page for a theme: the attribute is on the root before anything paints, so there is no flash. */
export const homeDocumentFor = (theme: "light" | "dark"): string =>
  HOME_DOCUMENT.replace('<html lang="en">', `<html lang="en" data-theme="${theme}">`);

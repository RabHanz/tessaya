/**
 * The one look of everything Baton puts over his screen: pill, pointer label, card, prompt, ask
 * box. Dark glass with a light hairline and a dark outer edge, so it reads on white and on black.
 */
export const COMPANION_CSS = `
:root{--ink:rgba(13,13,17,.965);--line:rgba(255,255,255,.15);--edge:0 0 0 1px rgba(0,0,0,.42),0 10px 30px rgba(0,0,0,.34);
--text:#f6f6f8;--soft:#b4b4bf;--faint:#83838f;--blue:#3380ff;--blue-soft:#9dc1ff;--green:#3fce8e;--amber:#ffb454;--red:#ff6b6b;
--sans:"Segoe UI Variable Text","Segoe UI",-apple-system,BlinkMacSystemFont,"Inter",system-ui,sans-serif}
html,body{margin:0;background:transparent;font-family:var(--sans);-webkit-font-smoothing:antialiased;-webkit-user-select:none;user-select:none;cursor:default}
.glass{background:linear-gradient(180deg,rgba(255,255,255,.075),rgba(255,255,255,0) 42%),var(--ink);border:1px solid var(--line);box-shadow:inset 0 1px 0 rgba(255,255,255,.14),var(--edge);color:var(--text)}
`;

/** Cards and prompts sit this far above the work area's bottom edge: clear of the pill and its strip, in one stack. */
export const CARD_ABOVE_WORK_AREA = 120;

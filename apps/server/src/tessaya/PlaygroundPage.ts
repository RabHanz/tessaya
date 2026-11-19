/**
 * The body playground's page at /tessaya/playground (M-089): the light body and the playground script, both built by
 * the web app as fixed-name same-origin scripts, mounted on one element. Everything it shows is the script's.
 */
export const PLAYGROUND_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex"><meta name="referrer" content="no-referrer">
<title>Body playground</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
:root{--bg:#ebe9e4;--panel:#f8f7f4;--ink:#17181b;--soft:#565961;--line:#dedbd4;--accent:#14505A;--on:#fff;--bad:#9b2c2c;--warn:#8a5a14;--pool:#f6f4ef;--stage:#dcd8cf;--serif:Georgia,"Times New Roman",serif;--sans:system-ui,sans-serif}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#111214;--panel:#1a1b1f;--ink:#ebebe8;--soft:#a6a8b0;--line:#2a2c32;--accent:#5FB3B3;--on:#0F1B1E;--bad:#e08a8a;--warn:#e0b070;--pool:#23252a;--stage:#0c0d0f}}
:root[data-theme=dark]{--bg:#111214;--panel:#1a1b1f;--ink:#ebebe8;--soft:#a6a8b0;--line:#2a2c32;--accent:#5FB3B3;--on:#0F1B1E;--bad:#e08a8a;--warn:#e0b070;--pool:#23252a;--stage:#0c0d0f}
*{box-sizing:border-box}html,body{height:100%}body{margin:0;background:var(--bg);color:var(--ink);overflow:hidden;-webkit-font-smoothing:antialiased}
#pg{height:100%}
</style>
</head>
<body>
<div id="pg"><p style="padding:16px;font:14px system-ui">Loading the playground…</p></div>
<script type="module" src="/assets/tessaya-body.js"></script>
<script type="module" src="/assets/tessaya-playground.js"></script>
<script type="module" src="/tessaya/playground/start.js"></script>
</body>
</html>`;

/** Mounts the playground once both scripts have run (module scripts run in order). */
export const PLAYGROUND_START = `try { window.tessayaPlayground.mount(document.getElementById("pg")); }
catch (err) { document.getElementById("pg").textContent = "The playground could not start: " + err.message; }
`;

/**
 * The phone page's files, served by BatonTessayaRoutes at /tessaya. Plain HTML and one script: no build step, nothing
 * fetched from elsewhere, text always set with textContent. The icons are the web app's own (/icon-192.png and friends).
 */

export const MANIFEST = JSON.stringify({
  id: "/tessaya/",
  name: "Tessaya",
  short_name: "Tessaya",
  start_url: "/tessaya/",
  scope: "/tessaya/",
  display: "standalone",
  background_color: "#14505A",
  theme_color: "#14505A",
  icons: [
    { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
    { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
    { src: "/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
  ],
});

// A fetch handler is what makes the page installable; it caches nothing, so what he sees is always the server's.
export const SERVICE_WORKER = `self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {});
`;

export const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#14505A">
<title>Tessaya</title>
<link rel="manifest" href="/tessaya/manifest.webmanifest">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>
:root{--bg:#ebe9e4;--panel:#f8f7f4;--ink:#17181b;--soft:#565961;--line:#dedbd4;--accent:#14505A;--on:#fff;--bad:#9b2c2c}
@media (prefers-color-scheme:dark){:root{--bg:#111214;--panel:#1a1b1f;--ink:#ebebe8;--soft:#a6a8b0;--line:#2a2c32;--accent:#5FB3B3;--on:#0F1B1E;--bad:#e08a8a}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.45 system-ui,sans-serif;padding:0 16px calc(96px + env(safe-area-inset-bottom))}
header{display:flex;align-items:center;justify-content:space-between;padding:14px 0 6px}
h1{font-size:20px;margin:0}
nav{display:flex;gap:6px;overflow-x:auto;padding:6px 0 10px}
nav button{flex:none;min-height:44px;padding:0 14px;border:1px solid var(--line);border-radius:22px;background:var(--panel);color:var(--ink);font:inherit}
nav button[aria-selected=true]{background:var(--accent);color:var(--on);border-color:var(--accent)}
.badge{display:inline-block;min-width:20px;margin-left:6px;padding:0 6px;border-radius:10px;background:var(--bad);color:#fff;font-size:13px;text-align:center}
.card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:0 0 10px}
.card h2{font-size:16px;margin:0 0 2px}
.soft{color:var(--soft);font-size:14px;margin:2px 0}
.col{display:flex;flex-direction:column;gap:8px;margin-top:10px}
.row{display:flex;gap:8px;flex-wrap:wrap;margin-top:10px}
button.act{min-height:44px;padding:0 16px;border-radius:10px;border:1px solid var(--accent);background:transparent;color:var(--accent);font:inherit}
button.act.primary{background:var(--accent);color:var(--on)}
.bar{position:fixed;left:0;right:0;bottom:0;padding:10px 16px calc(10px + env(safe-area-inset-bottom));background:var(--panel);border-top:1px solid var(--line);display:flex;gap:8px}
.bar input{flex:1;min-height:48px;border-radius:24px;border:1px solid var(--line);padding:0 16px;background:var(--bg);color:var(--ink);font:inherit}
.bar button{min-width:48px;min-height:48px;border-radius:24px;border:1px solid var(--accent);background:var(--accent);color:var(--on);font:inherit;padding:0 14px;touch-action:none}
.bar button.rec{background:var(--bad);border-color:var(--bad)}
#say{margin:0 0 10px;white-space:pre-wrap}
.field{width:100%;min-width:0;min-height:44px;border-radius:10px;border:1px solid var(--line);padding:0 12px;background:var(--bg);color:var(--ink);font:inherit}
textarea.field{min-height:88px;padding:10px 12px;resize:vertical}
.row .field{flex:1 1 160px}
main>.row{margin:0 0 10px}
button.card{display:block;width:100%;text-align:left;font:inherit;color:inherit;cursor:pointer}
button.act.danger{border-color:var(--bad);color:var(--bad)}
.text{margin:4px 0 0;white-space:pre-wrap;overflow-wrap:anywhere}
.code{font:600 16px/1.5 ui-monospace,monospace;letter-spacing:.04em;user-select:all;overflow-wrap:anywhere;margin:10px 0 0;padding:10px 12px;border-radius:10px;background:var(--bg)}
.switch{display:flex;align-items:center;gap:10px;min-height:44px;margin-top:10px}
.switch input{width:22px;height:22px;margin:0;accent-color:var(--accent)}
.warn{color:var(--bad)}
</style>
</head>
<body>
<header><h1>Tessaya</h1><span class="soft" id="stamp"></span></header>
<nav role="tablist" aria-label="Sections" id="tabs"></nav>
<main id="view" aria-live="polite"></main>
<div class="bar">
<input id="ask" type="text" enterkeyhint="send" placeholder="Ask or tell Tessaya" aria-label="Ask or tell Tessaya" autocomplete="off">
<button id="send" type="button" aria-label="Send">Send</button>
<button id="talk" type="button" aria-label="Hold to talk">Talk</button>
</div>
<script src="/tessaya/app.js"></script>
</body>
</html>
`;

export const SCRIPT = `"use strict";
(function () {
  var TABS = [["needs", "Needs me"], ["approvals", "Approvals"], ["now", "Now"], ["jobs", "Jobs"], ["weave", "Weave"], ["asked", "Asked"], ["mem", "Memories"]];
  var tab = "needs", state = null, said = "", denied = false;
  var view = document.getElementById("view"), tabs = document.getElementById("tabs");
  function el(tag, cls, text) { var n = document.createElement(tag); if (cls) n.className = cls; if (text !== undefined) n.textContent = text; return n; }
  function api(method, path, body, raw) {
    var init = { method: method, credentials: "same-origin", headers: {} };
    if (raw) { init.body = body; init.headers["content-type"] = "audio/wav"; init.headers["x-client-id"] = newId(); }
    else if (body !== undefined) { init.body = JSON.stringify(body); init.headers["content-type"] = "application/json"; }
    return fetch("/tessaya/api/" + path, init).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { j.status = r.status; return j; });
    });
  }
  function badge(n) {
    document.title = n > 0 ? "(" + n + ") Tessaya" : "Tessaya";
    try { if (navigator.setAppBadge) { n > 0 ? navigator.setAppBadge(n) : navigator.clearAppBadge(); } } catch (e) {}
  }
  function drawTabs() {
    tabs.textContent = "";
    TABS.forEach(function (t) {
      var b = el("button", "", t[1]); b.type = "button"; b.setAttribute("role", "tab"); b.setAttribute("aria-selected", String(t[0] === tab));
      if (t[0] === "needs" && state && state.badge > 0) b.appendChild(el("span", "badge", String(state.badge)));
      b.onclick = function () {
        if (tab === "mem" && t[0] !== "mem") { mem.sel = null; dropItems(); }
        tab = t[0]; draw();
        if (tab === "mem") { mem.said = ""; refresh(); }
      };
      tabs.appendChild(b);
    });
  }
  // An invite code pairs this phone as the member it was made for; then it opens their own memory.
  function joinRow(c) {
    var code = el("input", "field"); code.placeholder = "Invite code"; code.setAttribute("aria-label", "Invite code"); code.autocomplete = "off"; code.autocapitalize = "characters";
    var b = el("button", "act primary", "Join"); b.type = "button";
    b.onclick = function () {
      b.disabled = true;
      fetch("/api/auth/browser-session", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ credential: code.value.trim().toUpperCase() }) }).then(function (r) {
        if (r.ok) return void location.reload();
        said = "That code didn't work. It lasts a day and works once: ask for a new one."; b.disabled = false; draw();
      });
    };
    var row = el("div", "row"); row.appendChild(code); row.appendChild(b); c.appendChild(row);
  }
  // A household member's own phone (not the owner's): only their own memory here.
  var member = null;
  function household() {
    return fetch("/tessaya/household", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "list" }) }).then(function (r) {
      return r.ok ? r.json() : null;
    }).then(function (j) {
      var you = j && j.value && j.value.members ? j.value.members.filter(function (m) { return m.you; })[0] : null;
      member = you && you.role !== "owner" ? you : null;
      // The ask bar reaches the owner's work, which a member's phone can't: it goes rather than fail.
      if (member) { TABS = [["mem", "Your memory"]]; tab = "mem"; denied = false; document.querySelector(".bar").hidden = true; refresh(); }
    }).catch(function () {});
  }
  function act(label, cls, fn) { var b = el("button", "act " + (cls || ""), label); b.type = "button"; b.onclick = function () { b.disabled = true; fn().then(function (j) { if (j && j.message) said = j.message; load(); }); }; return b; }
  function draw() {
    if (tab === "mem") return drawMem();
    drawTabs(); view.textContent = "";
    if (denied) { var c = el("div", "card"); c.appendChild(el("h2", "", "This phone is not paired")); c.appendChild(el("p", "soft", "Have an invite code from Tessaya? Type it here. Otherwise open this server's normal address on this phone and pair it there first, then come back to /tessaya.")); joinRow(c); view.appendChild(c); return; }
    if (state && !state.desktop.connected) view.appendChild(el("p", "soft", "Your computer is not connected. Asks wait for it."));
    if (said) view.appendChild(el("p", "card", said)).id = "say";
    if (!state) { view.appendChild(el("p", "soft", "Loading")); return; }
    if (tab === "needs") {
      if (!state.needs.length) view.appendChild(el("p", "soft", "Nothing needs you."));
      state.needs.forEach(function (n) { var c = el("div", "card"); c.appendChild(el("h2", "", n.title)); c.appendChild(el("p", "soft", n.why)); view.appendChild(c); });
    } else if (tab === "approvals") {
      if (!state.approvals.length) view.appendChild(el("p", "soft", "Nothing is waiting for your yes."));
      state.approvals.forEach(function (a) {
        var c = el("div", "card"); c.appendChild(el("h2", "", a.title)); c.appendChild(el("p", "", a.action)); c.appendChild(el("p", "soft", "Would use: " + a.permission));
        if (a.answerable && a.buttons) {
          var cr = el("div", "col");
          a.buttons.forEach(function (label, i) {
            cr.appendChild(act(label, i === a.buttons.length - 1 ? "" : "primary", function () { return api("POST", "approvals/" + encodeURIComponent(a.id), { choice: i, action: a.action }); }));
          });
          c.appendChild(cr);
        } else if (a.answerable) {
          var r = el("div", "row");
          r.appendChild(act("Approve", "primary", function () { return api("POST", "approvals/" + encodeURIComponent(a.id), { decision: "approve", action: a.action }); }));
          r.appendChild(act("Deny", "", function () { return api("POST", "approvals/" + encodeURIComponent(a.id), { decision: "deny", action: a.action }); }));
          c.appendChild(r);
        } else c.appendChild(el("p", "soft", "Only you can answer this one, in its thread."));
        view.appendChild(c);
      });
    } else if (tab === "now") {
      state.now.forEach(function (l) { view.appendChild(el("p", "card", l)); });
    } else if (tab === "jobs") {
      if (!state.jobs.length) view.appendChild(el("p", "soft", "No jobs."));
      state.jobs.forEach(function (j) {
        var c = el("div", "card"); c.appendChild(el("h2", "", j.title)); c.appendChild(el("p", "soft", j.status));
        var r = el("div", "row");
        if (j.canStop) r.appendChild(act("Stop", "", function () { return api("POST", "jobs/" + encodeURIComponent(j.id) + "/stop"); }));
        if (j.canRetry) r.appendChild(act("Retry", "primary", function () { return api("POST", "jobs/" + encodeURIComponent(j.id) + "/retry"); }));
        if (r.children.length) c.appendChild(r);
        view.appendChild(c);
      });
    } else if (tab === "asked") {
      if (!state.asks.length) view.appendChild(el("p", "soft", "Nothing asked yet. Use the box below."));
      state.asks.forEach(function (a) { var c = el("div", "card"); c.appendChild(el("h2", "", a.text)); c.appendChild(el("p", "", a.line)); view.appendChild(c); });
    } else if (tab === "weave") {
      if (!state.weaves.length) view.appendChild(el("p", "soft", "Nothing between sessions."));
      state.weaves.forEach(function (w) { var c = el("div", "card"); c.appendChild(el("p", "", w.line)); c.appendChild(el("p", "soft", w.status)); view.appendChild(c); });
    }
  }

  // Memories: his private store and one per person, each under its PIN. What a store holds lives only in these
  // variables while it is open: never in any browser storage, and the service worker keeps nothing.
  var mem = { stores: null, sel: null, items: null, waiting: null, log: null, code: null, said: "", recovery: false, editing: null, q: "" };
  var ticks = [], hiddenAt = 0, hideTimer = null;
  function priv(body) {
    return fetch("/tessaya/private", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 422 && /locked/i.test(j.message || "")) dropItems();
        if (r.status !== 200) throw new Error(j.message || "That did not work.");
        return j.value;
      });
    });
  }
  function dropItems() { mem.items = null; mem.waiting = null; mem.editing = null; }
  function storeOf(id) { return (mem.stores || []).filter(function (s) { return s.id === id; })[0] || null; }
  function owner() { return (mem.stores || []).filter(function (s) { return s.kind === "owner"; })[0] || null; }
  function nameOf(s) { return s.kind === "owner" ? "You" : s.name; }
  function say(e) { mem.said = e && e.message ? e.message : "That did not work."; }
  function refresh() {
    return priv({ op: "people" }).then(function (v) {
      mem.stores = v.stores.slice().sort(function (a, b) { return (a.kind === "owner" ? 0 : 1) - (b.kind === "owner" ? 0 : 1) || a.name.localeCompare(b.name); });
      // A member has one store, their own: it is the page.
      if (member && mem.stores.length > 0) mem.sel = mem.stores[0].id;
      var s = mem.sel && storeOf(mem.sel), me = owner();
      if (!s) mem.sel = null;
      if (!s || !s.open) dropItems();
      if (mem.log && !(me && me.open) && !(s && s.open && mem.log.for === s.id)) mem.log = null;
      if (!s || !s.open) return;
      var q = { op: "list", storeId: s.id, includeProposed: s.kind === "owner" };
      if (mem.q) q.text = mem.q;
      return priv(q).then(function (r) {
        mem.items = r.items.filter(function (i) { return !i.proposed; });
        mem.waiting = r.items.filter(function (i) { return i.proposed; });
      });
    }).catch(say).then(drawMem);
  }
  // One change, then the people and the open store are read again and drawn.
  function step(fn) { mem.said = ""; return Promise.resolve().then(fn).catch(say).then(refresh); }
  function mbtn(label, cls, fn) { var b = el("button", "act " + (cls || ""), label); b.type = "button"; b.onclick = function () { b.disabled = true; step(fn); }; return b; }
  function twoStep(label, sure, fn) {
    var b = el("button", "act", label), armed = false; b.type = "button";
    b.onclick = function () { if (!armed) { armed = true; b.textContent = sure; b.classList.add("danger"); return; } b.disabled = true; step(fn); };
    return b;
  }
  function plain(label, fn) { var b = el("button", "act", label); b.type = "button"; b.onclick = fn; return b; }
  function field(label, type, digits) {
    var i = el("input", "field"); i.type = type || "text"; i.placeholder = label; i.setAttribute("aria-label", label); i.autocomplete = "off";
    if (digits) { i.inputMode = "numeric"; i.maxLength = 6; }
    return i;
  }
  // A person's PIN is 6 digits; his may be a passphrase, so his keyboard stays a full one.
  function pinField(s, label) { return field(label, "password", s.kind === "person"); }
  function onEnter(input, b) { input.onkeydown = function (e) { if (e.key === "Enter") b.click(); }; }
  function hm(at) { return new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
  function day(at) { return new Date(at).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }); }
  function untilText(until) { return "Open. Locks in " + Math.max(1, Math.ceil((Date.parse(until) - Date.now()) / 60000)) + " min"; }
  function status(s) {
    if (s.open && s.openUntil) { var n = el("p", "soft", untilText(s.openUntil)); ticks.push({ n: n, until: s.openUntil }); return n; }
    if (s.open) return el("p", "soft", "Open");
    if (s.recoveryOnly) return el("p", "soft warn", "Locked. Too many wrong PINs: only the recovery code opens it now.");
    if (s.waitUntil) return el("p", "soft warn", "Locked. Too many wrong PINs: try again after " + hm(s.waitUntil) + ".");
    return el("p", "soft", "Locked");
  }
  function card(title, note) { var c = el("div", "card"); if (title) c.appendChild(el("h2", "", title)); if (note) c.appendChild(el("p", "soft", note)); view.appendChild(c); return c; }
  function drawMem() {
    if (tab !== "mem") return;
    drawTabs(); view.textContent = ""; ticks = [];
    if (said) view.appendChild(el("p", "card", said)).id = "say";
    if (mem.said) view.appendChild(el("p", "card warn", mem.said));
    if (mem.code) return codeCard();
    if (mem.stores === null) return void view.appendChild(el("p", "soft", "Loading"));
    var s = mem.sel && storeOf(mem.sel);
    if (s) storeView(s); else peopleView();
    stepUpCard();
  }
  // Confirming it's them (identity I-3): a passkey on this phone, or their PIN; 5 minutes of A3 here.
  function hh(body) {
    return fetch("/tessaya/household", { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status !== 200) throw new Error(j.message || "That did not work.");
        if (j.value && j.value.status === "refused") throw new Error(j.value.line);
        return j.value;
      });
    });
  }
  function b64u(buf) { return btoa(String.fromCharCode.apply(null, Array.from(new Uint8Array(buf)))).split("+").join("-").split("/").join("_").split("=").join(""); }
  function unb64u(t) { t = t.split("-").join("+").split("_").join("/"); while (t.length % 4) t += "="; return Uint8Array.from(atob(t), function (ch) { return ch.charCodeAt(0); }); }
  function stepUpCard() {
    if (!member || mem.code) return;
    var c = card("Confirm it's you", "For 5 minutes this phone can do what needs you to be sure. Use this phone's passkey (your fingerprint, face or screen lock) or your PIN.");
    var col = el("div", "col");
    if (window.PublicKeyCredential) {
      col.appendChild(mbtn("Confirm with a passkey", "primary", function () {
        return hh({ op: "passkeyOptions", purpose: "stepUp" }).then(function (v) {
          var o = v.passkey;
          if (!o.keys.length) throw new Error("Add a passkey on this phone first.");
          return navigator.credentials.get({ publicKey: { challenge: unb64u(o.challenge), rpId: o.rpId, userVerification: "required", allowCredentials: o.keys.map(function (k) { return { type: "public-key", id: unb64u(k.id) }; }) } });
        }).then(function (a) {
          return hh({ op: "stepUp", passkey: { credentialId: b64u(a.rawId), clientDataJSON: b64u(a.response.clientDataJSON), authenticatorData: b64u(a.response.authenticatorData), signature: b64u(a.response.signature) } });
        }).then(function (v) { said = v.line; });
      }));
      col.appendChild(mbtn("Add a passkey on this phone", "", function () {
        return hh({ op: "passkeyOptions", purpose: "register" }).then(function (v) {
          var o = v.passkey;
          return navigator.credentials.create({ publicKey: {
            challenge: unb64u(o.challenge), rp: { id: o.rpId, name: "Tessaya" },
            user: { id: unb64u(o.userId), name: o.userName, displayName: o.userName },
            pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -8 }, { type: "public-key", alg: -257 }],
            authenticatorSelection: { userVerification: "required", residentKey: "preferred" },
            excludeCredentials: o.keys.map(function (k) { return { type: "public-key", id: unb64u(k.id) }; })
          } });
        }).then(function (cred) {
          return hh({ op: "passkeyRegister", clientDataJSON: b64u(cred.response.clientDataJSON), attestationObject: b64u(cred.response.attestationObject), label: "This phone" });
        }).then(function (v) { said = v.line; });
      }));
    }
    var pin = field("Your PIN", "password", true);
    var go = mbtn("Confirm with your PIN", "", function () { return hh({ op: "stepUp", pin: pin.value }).then(function (v) { said = v.line; }); });
    onEnter(pin, go); col.appendChild(pin); col.appendChild(go); c.appendChild(col);
  }
  function codeCard() {
    var c = card("Save this recovery code now", "It is shown this once and never again. If " + mem.code.whose + " PIN is lost, this code is the only way back in. Write it down and keep it away from this phone.");
    c.appendChild(el("p", "code", mem.code.code));
    var r = el("div", "row"); r.appendChild(plain("I saved it", function () { mem.code = null; drawMem(); })); r.firstChild.classList.add("primary"); c.appendChild(r);
  }
  function peopleView() {
    if (member) return memberView();
    var me = owner();
    if (!me) {
      var c = card("Your private memories", "Make your own store first. Its PIN is 8 or more digits, or a passphrase. Each person you add gets their own store under their own PIN.");
      var pin = field("Your new PIN or passphrase", "password"), col = el("div", "col"), b = mbtn("Make my store", "primary", function () {
        return priv({ op: "setup", name: "You", pin: pin.value }).then(function (v) { mem.code = { whose: "your", code: v.recoveryCode }; });
      });
      onEnter(pin, b); col.appendChild(pin); col.appendChild(b); c.appendChild(col);
      return;
    }
    mem.stores.forEach(function (s) {
      var c = el("button", "card"); c.type = "button";
      c.appendChild(el("h2", "", nameOf(s))); c.appendChild(el("p", "soft", s.items + (s.items === 1 ? " memory" : " memories"))); c.appendChild(status(s));
      c.onclick = function () { mem.sel = s.id; mem.said = ""; mem.recovery = false; mem.q = ""; mem.log = null; dropItems(); drawMem(); refresh(); };
      view.appendChild(c);
    });
    if (!me.open) return void view.appendChild(el("p", "soft", "Open your own store to add a person or to see every store's log."));
    var a = card("Add a person", "Use the short id their voice profile has, and their name. Let them type their own 6-digit PIN.");
    var id = field("Short id, like sara"), nm = field("Their name"), pp = field("Their 6-digit PIN", "password", true), col = el("div", "col");
    [id, nm, pp].forEach(function (i) { col.appendChild(i); });
    col.appendChild(mbtn("Make their store", "primary", function () {
      if (!id.value.trim()) throw new Error("Give them a short id.");
      return priv({ op: "setup", personId: id.value.trim(), name: nm.value.trim(), pin: pp.value }).then(function (v) { mem.code = { whose: v.store.name + "'s", code: v.recoveryCode }; });
    }));
    a.appendChild(col);
    logPart(null, "Every store's log", { op: "audit" });
  }
  // A member's own store, made here when they accept: their own 6-digit PIN, sealed on this server.
  function memberView() {
    var c = card("Set up your own memory", "Choose a 6-digit PIN. It opens what Tessaya keeps for you; as this home is set up, its owner can open it too. Until you do, Tessaya can't keep anything for you.");
    var pin = field("Your new 6-digit PIN", "password", true), again = field("The same PIN again", "password", true), col = el("div", "col");
    var b = mbtn("Make my memory", "primary", function () {
      if (pin.value !== again.value) throw new Error("The two PINs are not the same.");
      return priv({ op: "setup", personId: member.id, name: member.name, pin: pin.value }).then(function (v) { mem.code = { whose: "your", code: v.recoveryCode }; });
    });
    onEnter(again, b); col.appendChild(pin); col.appendChild(again); col.appendChild(b); c.appendChild(col);
  }
  function logPart(storeId, label, query) {
    if (!mem.log || mem.log.for !== storeId) {
      var r = el("div", "row"); r.appendChild(mbtn(label, "", function () { return priv(query).then(function (v) { mem.log = { for: storeId, v: v }; }); })); view.appendChild(r);
      return;
    }
    var c = card("Log", null), v = mem.log.v;
    c.appendChild(el("p", v.intact ? "soft" : "soft warn", v.intact ? "Log intact" : "Log was changed: a row was removed or edited."));
    if (!v.rows.length) c.appendChild(el("p", "soft", "Nothing yet."));
    v.rows.slice(-50).reverse().forEach(function (row) {
      c.appendChild(el("p", "text", day(row.at) + " " + hm(row.at) + ". " + row.name + ": " + row.action + ", " + row.outcome + (row.count ? " (" + row.count + ")" : "") + ". By " + row.by + "."));
    });
  }
  function storeView(s) {
    var top = el("div", "row");
    if (!member) top.appendChild(plain("All people", function () { mem.sel = null; mem.said = ""; mem.log = null; dropItems(); drawMem(); }));
    view.appendChild(top);
    var head = card(nameOf(s), s.items + (s.items === 1 ? " memory" : " memories")); head.appendChild(status(s));
    if (!s.open) return lockedView(s, head);
    var tools = el("div", "row"); tools.appendChild(mbtn("Lock now", "", function () { return priv({ op: "lock", storeId: s.id }).then(dropItems); })); head.appendChild(tools);
    var sw = el("label", "switch"), cb = el("input"); cb.type = "checkbox"; cb.setAttribute("role", "switch"); cb.checked = !s.recallOff;
    cb.onchange = function () { cb.disabled = true; step(function () { return priv({ op: "setRecall", storeId: s.id, recallOff: !cb.checked }); }); };
    sw.appendChild(cb); sw.appendChild(el("span", "", "Tessaya may use these in a reply")); head.appendChild(sw);
    head.appendChild(el("p", "soft", "When off, Tessaya never uses these in a reply. You can still read them here."));
    var sr = el("div", "row"), q = field("Search these memories", "search"); q.value = mem.q;
    var go = plain("Search", function () { mem.q = q.value.trim(); step(); }); onEnter(q, go);
    sr.appendChild(q); sr.appendChild(go); view.appendChild(sr);
    if (mem.items === null) return void view.appendChild(el("p", "soft", "Loading"));
    if (mem.waiting && mem.waiting.length) {
      card("Waiting for your yes", "Tessaya was not sure about these. Keep the ones that are right.");
      mem.waiting.forEach(function (i) { itemCard(s, i, true); });
    }
    if (!mem.items.length) view.appendChild(el("p", "soft", mem.q ? "Nothing matches." : "No memories here yet."));
    mem.items.forEach(function (i) { itemCard(s, i, false); });
    moreView(s);
  }
  function lockedView(s, c) {
    var col = el("div", "col"), me = owner();
    if (mem.recovery || s.recoveryOnly) {
      var code = field("Recovery code"), b = mbtn("Open", "primary", function () { return priv({ op: "unlock", storeId: s.id, recoveryCode: code.value.trim() }).then(function () { mem.recovery = false; }); });
      onEnter(code, b); col.appendChild(code); col.appendChild(b);
      if (!s.recoveryOnly) col.appendChild(plain("Use the PIN", function () { mem.recovery = false; drawMem(); }));
    } else {
      var pin = pinField(s, s.kind === "owner" ? "Your PIN or passphrase" : s.name + "'s PIN"), open = mbtn("Open", "primary", function () { return priv({ op: "unlock", storeId: s.id, pin: pin.value }); });
      if (s.waitUntil) { pin.disabled = true; open.disabled = true; }
      onEnter(pin, open); col.appendChild(pin); col.appendChild(open);
      col.appendChild(plain("Use the recovery code", function () { mem.recovery = true; drawMem(); }));
    }
    if (s.kind === "person" && me && me.open) {
      col.appendChild(el("p", "soft", "Your store is open on this device, so you can open theirs without their PIN. Both logs record it."));
      col.appendChild(mbtn("Open as admin", "", function () { return priv({ op: "unlock", storeId: s.id }); }));
    }
    c.appendChild(col);
  }
  function itemCard(s, i, waiting) {
    var c = card(null, i.kind + ". " + day(i.updatedAt) + (i.sourceRef && i.sourceRef.indexOf("freya:") === 0 ? ". From Freya" : "")), r = el("div", "row");
    if (mem.editing === i.id) {
      var t = el("textarea", "field"); t.value = i.text; t.setAttribute("aria-label", "Memory text"); c.appendChild(t);
      r.appendChild(mbtn("Save", "primary", function () { return priv({ op: "edit", storeId: s.id, id: i.id, text: t.value.trim() }).then(function () { mem.editing = null; }); }));
      r.appendChild(plain("Cancel", function () { mem.editing = null; drawMem(); }));
    } else {
      c.appendChild(el("p", "text", i.text));
      if (waiting) r.appendChild(mbtn("Keep", "primary", function () { return priv({ op: "accept", storeId: s.id, id: i.id }); }));
      r.appendChild(plain("Edit", function () { mem.editing = i.id; drawMem(); }));
      r.appendChild(twoStep("Forget", "Forget for good?", function () { return priv({ op: "forget", storeId: s.id, id: i.id }); }));
    }
    c.appendChild(r);
  }
  function moreView(s) {
    var person = s.kind === "person", admin = person && owner() && owner().open;
    var add = card("Add a memory", null), kind = el("select", "field"), text = el("textarea", "field"), col = el("div", "col");
    ["note", "fact", "preference", "decision", "episode", "learning", "correction"].forEach(function (k) { var o = el("option", "", k); o.value = k; kind.appendChild(o); });
    kind.setAttribute("aria-label", "Kind"); text.setAttribute("aria-label", "What to remember"); text.placeholder = "What to remember";
    col.appendChild(kind); col.appendChild(text);
    col.appendChild(mbtn("Add", "primary", function () { return priv({ op: "add", storeId: s.id, draft: { kind: kind.value, text: text.value.trim() } }); }));
    add.appendChild(col);

    var ex = card("Export", "Asks for the PIN again, then saves every memory here as a markdown file on this device."), ep = pinField(s, person ? s.name + "'s PIN" : "Your PIN or passphrase"), er = el("div", "col");
    er.appendChild(ep);
    er.appendChild(mbtn("Export", "", function () {
      return priv({ op: "export", storeId: s.id, pin: ep.value }).then(function (v) {
        var url = URL.createObjectURL(new Blob([v.markdown], { type: "text/markdown" })), a = el("a");
        a.href = url; a.download = nameOf(s).toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-memories.md";
        document.body.appendChild(a); a.click(); a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
      });
    }));
    ex.appendChild(er);

    var cp = card("Change PIN", person ? "A PIN is 6 digits." : "8 or more digits, or a passphrase."), oldPin = pinField(s, "Current PIN"), newPin = pinField(s, "New PIN"), cr = el("div", "col");
    cr.appendChild(oldPin); cr.appendChild(newPin);
    cr.appendChild(mbtn("Change PIN", "", function () { return priv({ op: "changePin", storeId: s.id, pin: oldPin.value, newPin: newPin.value }); }));
    cp.appendChild(cr);

    logPart(s.id, "Show the log", person ? { op: "audit", storeId: s.id } : { op: "audit" });

    var del = card("Delete this store", "Every memory in it is gone for good, and the log keeps only that it was deleted."), dr = el("div", "col"), dp = admin ? null : pinField(s, person ? s.name + "'s PIN" : "Your PIN or passphrase");
    if (dp) dr.appendChild(dp);
    dr.appendChild(twoStep("Delete store", "Delete it for good?", function () {
      var q = { op: "remove", storeId: s.id }; if (dp) q.pin = dp.value;
      return priv(q).then(function () { mem.sel = null; dropItems(); });
    }));
    del.appendChild(dr);
  }
  setInterval(function () {
    var gone = false;
    ticks = ticks.filter(function (t) {
      if (!t.n.isConnected) return false;
      if (Date.parse(t.until) <= Date.now()) { gone = true; return false; }
      t.n.textContent = untilText(t.until); return true;
    });
    if (gone) { dropItems(); refresh(); }
  }, 60000);
  // Hidden for more than 2 minutes: what was shown is dropped, and the people list is what comes back.
  function forgetShown() { dropItems(); mem.log = null; mem.sel = null; if (tab === "mem") { view.textContent = ""; refresh(); } }
  document.addEventListener("visibilitychange", function () {
    if (document.hidden) { hiddenAt = Date.now(); hideTimer = setTimeout(forgetShown, 120000); return; }
    clearTimeout(hideTimer);
    if (hiddenAt && Date.now() - hiddenAt > 120000) forgetShown();
    hiddenAt = 0;
  });

  function load() {
    return api("GET", "state").then(function (j) {
      denied = j.status === 401 || j.status === 403;
      if (j.status === 200) { state = j; badge(j.badge); document.getElementById("stamp").textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); }
      // The Memories view redraws only on its own changes, so a poll never wipes a PIN being typed.
      if (tab === "mem") drawTabs(); else draw();
    }).catch(function () { said = "The server did not answer."; if (tab !== "mem") draw(); });
  }
  function newId() { var a = new Uint8Array(12); crypto.getRandomValues(a); return "c-" + Array.prototype.map.call(a, function (x) { return ("0" + x.toString(16)).slice(-2); }).join(""); }
  var watching = null;
  function watch(id) {
    watching = id; var tries = 0;
    (function poll() {
      if (watching !== id) return;
      api("GET", "ask/" + encodeURIComponent(id)).then(function (j) {
        if (watching !== id) return;
        if (j.line) { said = j.line; draw(); }
        if (j.status === "answered" || j.status === "failed" || j.status === "expired") { watching = null; load(); return; }
        if (++tries < 90) setTimeout(poll, 3000);
      });
    })();
  }
  function send(text) {
    if (!text) return;
    var id = newId(); said = "Sending"; draw();
    api("POST", "ask", { id: id, text: text }).then(function (j) { said = j.line || j.message || ""; draw(); load(); if (j.id) watch(j.id); });
  }
  document.getElementById("send").onclick = function () { var i = document.getElementById("ask"); var t = i.value.trim(); i.value = ""; send(t); };
  document.getElementById("ask").onkeydown = function (e) { if (e.key === "Enter") document.getElementById("send").click(); };

  // Push to talk: record while held, make a 16 kHz mono WAV here, send it; the server transcribes and answers.
  function wavOf(blob) {
    return blob.arrayBuffer().then(function (buf) {
      var Ctx = window.AudioContext || window.webkitAudioContext; var ac = new Ctx();
      return ac.decodeAudioData(buf).then(function (audio) {
        ac.close();
        var off = new OfflineAudioContext(1, Math.max(1, Math.ceil(audio.duration * 16000)), 16000);
        var src = off.createBufferSource(); src.buffer = audio; src.connect(off.destination); src.start();
        return off.startRendering();
      });
    }).then(function (r) {
      var pcm = r.getChannelData(0), out = new DataView(new ArrayBuffer(44 + pcm.length * 2));
      function s(o, t) { for (var i = 0; i < t.length; i++) out.setUint8(o + i, t.charCodeAt(i)); }
      s(0, "RIFF"); out.setUint32(4, 36 + pcm.length * 2, true); s(8, "WAVE"); s(12, "fmt "); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, 1, true);
      out.setUint32(24, 16000, true); out.setUint32(28, 32000, true); out.setUint16(32, 2, true); out.setUint16(34, 16, true); s(36, "data"); out.setUint32(40, pcm.length * 2, true);
      for (var i = 0; i < pcm.length; i++) { var v = Math.max(-1, Math.min(1, pcm[i])); out.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true); }
      return new Blob([out], { type: "audio/wav" });
    });
  }
  var talk = document.getElementById("talk"), rec = null, chunks = [];
  function stopTalk() { if (rec && rec.state === "recording") rec.stop(); }
  talk.onpointerdown = function (e) {
    e.preventDefault();
    if (!navigator.mediaDevices || !window.MediaRecorder) { said = "This browser cannot record. Type instead."; draw(); return; }
    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      chunks = []; rec = new MediaRecorder(stream); talk.classList.add("rec"); talk.textContent = "Listening";
      rec.ondataavailable = function (ev) { if (ev.data.size) chunks.push(ev.data); };
      rec.onstop = function () {
        stream.getTracks().forEach(function (t) { t.stop(); }); talk.classList.remove("rec"); talk.textContent = "Talk";
        said = "Listening done. Working on it"; draw();
        wavOf(new Blob(chunks)).then(function (wav) { return api("POST", "voice", wav, true); }).then(function (j) {
          said = j.heard ? "You said: " + j.heard + "\\n\\n" + (j.line || "") : (j.message || "Nothing came back.");
          draw(); load(); if (j.id) watch(j.id);
        }).catch(function () { said = "That recording could not be sent."; draw(); });
      };
      rec.start();
    }).catch(function () { said = "The microphone is not allowed for this page."; draw(); });
  };
  talk.onpointerup = stopTalk; talk.onpointercancel = stopTalk; talk.onpointerleave = stopTalk;

  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/tessaya/sw.js").catch(function () {});
  load();
  household();
  // Polling, not push: every 20 seconds while the page is in view.
  setInterval(function () { if (!document.hidden) load(); }, 20000);
  document.addEventListener("visibilitychange", function () { if (!document.hidden) load(); });
})();
`;

/**
 * The page script of Baton's window (D140). Plain DOM, no framework. Text goes in with textContent
 * only; the state is data, never markup (the one innerHTML is the mark Baton itself draws, and the
 * fixed icon paths below). Outside Electron it reads `window.__BATON_STATE__`, so every tab can be
 * looked at in a browser. Its words come from `strings.ts` (the `STR` table on the first line); apart from that first line this string holds no backticks and no dollar-brace, on purpose.
 */
import {
  T3_SETTINGS_PLACES,
  TESSAYA_PLACES,
  TESSAYA_SETTINGS_GROUPS,
} from "@t3tools/baton-contracts";

import {
  applyLearnOp,
  LEARN_ITEMS,
  pickTip,
  readLearnProgress,
  WHATS_NEW,
} from "@t3tools/baton-shared/learn";

import { tableFor } from "./strings.ts";
import { AREAS } from "./tabs.ts";

export const APP_SCRIPT = `const STR = ${JSON.stringify(tableFor("en"))}; const AREAS = ${JSON.stringify(AREAS)}; const PLACES = ${JSON.stringify(TESSAYA_PLACES)}; const SGROUPS = ${JSON.stringify(TESSAYA_SETTINGS_GROUPS)}; const T3PLACES = ${JSON.stringify(T3_SETTINGS_PLACES)}; const LEARN_ITEMS = ${JSON.stringify(LEARN_ITEMS)}; const WHATS_NEW = ${JSON.stringify(WHATS_NEW)}; const pickTip = (${pickTip.toString().replace(/\s*\n\s*/g, " ")}); const applyLearnOp = (${applyLearnOp.toString().replace(/\s*\n\s*/g, " ")}); const readLearnProgress = (${readLearnProgress.toString().replace(/\s*\n\s*/g, " ")});
const L = (k, v) => { let t = STR[k] !== undefined ? STR[k] : k; if (v) for (const n in v) t = t.split("{" + n + "}").join(String(v[n])); return t; };
const real = typeof require === 'function';
const ipc = real ? require('electron').ipcRenderer : null;
const get = () => real ? ipc.invoke('baton-home:get') : Promise.resolve(window.__BATON_STATE__);
const set = (id, v) => real ? ipc.invoke('baton-home:set', id, v).then(render) : Promise.resolve();
const $ = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x !== undefined) e.textContent = x; return e; };
const ICON = {
  home: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/>',
  scratchpad: '<path d="M6 4h12v16H6z"/><path d="M9 9h6M9 13h6"/>',
  insights: '<path d="M4 19V9M10 19V5M16 19v-8M22 19H2"/>',
  style: '<path d="M4 19L9 5l5 14M6 14h6"/><path d="M17 12h4M19 12v7"/>',
  transforms: '<path d="M4 12h12M12 6l6 6-6 6"/>',
  snippets: '<path d="M9 5H6v14h3M15 5h3v14h-3"/><path d="M10 12h4"/>',
  now: '<circle cx="12" cy="12" r="4"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3"/>',
  sessions: '<rect x="3" y="4" width="18" height="5" rx="1.5"/><rect x="3" y="11" width="18" height="5" rx="1.5"/><path d="M7 20h10"/>',
  approvals: '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>',
  cloud: '<path d="M7 18a4 4 0 0 1-.5-7.97A5.5 5.5 0 0 1 17 8.5a4.5 4.5 0 0 1 .5 9.5z"/>',
  jobs: '<rect x="3" y="8" width="18" height="12" rx="2"/><path d="M9 8V5h6v3M3 13h18"/>',
  dictation: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  assistant: '<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z"/><path d="M19 17l.7 1.8L21.5 19.5l-1.8.7L19 22l-.7-1.8-1.8-.7 1.8-.7z"/>',
  voice: '<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>',
  screen: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>',
  usage: '<path d="M4 17a8 8 0 1 1 16 0"/><path d="M12 17l4-5"/>',
  tools: '<path d="M13 3L5 14h6l-1 7 8-11h-6z"/>',
  memory: '<path d="M12 4l9 5-9 5-9-5z"/><path d="M3 14l9 5 9-5"/>',
  vault: '<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
  history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  mic: '<path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2M12 19v3"/>',
  cmd: '<path d="m9 18 6-6-6-6"/>',
  spark: '<path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z"/>',
  lock: '<rect width="18" height="11" x="3" y="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
  play: '<polygon points="6 3 20 12 6 21 6 3"/>',
  copy: '<rect width="14" height="14" x="8" y="8" rx="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
  flag: '<path d="M4 22V4a1 1 0 0 1 .4-.8A6 6 0 0 1 8 2c3 0 5 2 7.33 2q2 0 3.67-.67a1 1 0 0 1 1 .14V15a1 1 0 0 1-.4.8A6 6 0 0 1 16 17c-3 0-5-2-8-2a6 6 0 0 0-4 1.53"/>',
  more: '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
  refresh: '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
  paste: '<rect width="8" height="4" x="8" y="2" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
  pencil: '<path d="M21.17 6.81a1 1 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z"/>',
  down: '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
  trash: '<path d="M3 6h18M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/>',
  checks: '<path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z"/><path d="M9 12l2 2 4-4"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 0 1 5 0c0 1.5-2.5 2-2.5 4M12 17h.01"/>',
  trust: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="12" cy="10" r="2.2"/><path d="M12 12.2V16"/>',
  settings: '<path d="M4 7h10M18 7h2M4 17h2M10 17h10"/><circle cx="16" cy="7" r="2"/><circle cx="8" cy="17" r="2"/>',
  side: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9 4v16"/>',
  bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2h-15z"/><path d="M10 21h4"/>',
  user: '<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4-6 8-6s7 2 8 6"/>',
  fold: '<path d="M6 9l6 6 6-6"/>',
  chev: '<path d="M1 1l4 4 4-4"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5H5V6h5"/>',
  hardware: '<rect x="5" y="3" width="14" height="18" rx="3"/><circle cx="12" cy="10" r="3"/><path d="M9 17h6"/>',
  homeassistant: '<path d="M3 11l9-7 9 7"/><path d="M5 10v10h14V10"/><path d="M12 13v3M10.5 14.5h3"/>',
  phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>'
};
const icon = (n, size) => { const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg'); s.setAttribute('class', 'i'); s.setAttribute('viewBox', '0 0 24 24'); if (size) { s.style.width = size + 'px'; s.style.height = size + 'px'; } s.innerHTML = ICON[n] || ''; return s; };
// A file dropped on the window is transcribed (Scratchpad). The path comes from Electron, never from the page's own data.
if (real) {
  addEventListener('dragover', e => { if (e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')) e.preventDefault(); });
  addEventListener('drop', e => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]; if (!f) return; e.preventDefault();
    let p = ''; try { p = require('electron').webUtils.getPathForFile(f); } catch (_) { p = f.path || ''; }
    if (p) set('tf.file', p);
  });
}
// The sidebar holds the work in five areas (AREAS); only the one in use stays open. Every setting is in Settings,
// and each area's gear row opens its own part of it.
const HUE = { today: 'now', talk: 'dictation', know: 'knowledge', devices: 'settings', agents: 'now' };
const GROUP_OF = {}; for (const a of AREAS) for (const gid of a.pages) GROUP_OF[gid] = HUE[a.id];
const openAreas = (() => { try { return new Set(JSON.parse(localStorage.getItem('tessaya.areas') || '[]')); } catch (e) { return new Set(); } })();
const saveAreas = () => { try { localStorage.setItem('tessaya.areas', JSON.stringify([...openAreas])); } catch (e) {} };
const TABS = ['home','now','snippets','insights','scratchpad','style','transforms','sessions','approvals','jobs','cloud','dictation','history','memory','vault','tools','usage','trust','hardware','homeassistant','phone','learn','help'].map(id => [id, L('tab.' + id)]);
const CATS = ['accounts','apis','brain','general','voice','personas','assistant','privacy','appearance','keys','advanced','about'].map(id => [id, L('cat.' + id)]);
const MOVED = { screen: 'assistant', checks: 'advanced', settings: 'general', system: 'advanced', updates: 'general', account: 'assistant' };
const INTRO = {};
for (const id of ['scratchpad','insights','style','transforms','snippets','now','sessions','approvals','jobs','cloud','dictation','tools','memory','vault','history','usage','trust','hardware','homeassistant','phone','learn','help']) INTRO[id] = [L('intro.' + id + '.title'), L('intro.' + id + '.text')];
let cur = 'home', collapsed = (() => { try { return localStorage.getItem('tessaya.rail') === '1'; } catch (e) { return false; } })(), modal = null, S = null, query = '';
let aboutSeen = false, bellOpen = false;
const open = new Set(), shown = new Set(), drafts = new Map(), changing = new Set();

function control(c) {
  if (c.kind === 'toggle') { const b = $('button', 'sw'); b.setAttribute('role', 'switch'); b.setAttribute('aria-checked', String(c.on)); b.setAttribute('aria-label', c.label); b.onclick = () => set(c.id, !c.on); return b; }
  if (c.kind === 'choice') {
    if (c.id === 's.voice') {
      const list = $('div', 'voices');
      for (const o of c.options) {
        const r = $('div', 'voice' + (o.value === c.value ? ' on' : ''));
        const pick = $('button', 'pickv', o.label); pick.setAttribute('role', 'radio'); pick.setAttribute('aria-checked', String(o.value === c.value)); pick.onclick = () => set(c.id, o.value);
        r.appendChild(pick);
        if (o.value !== 'system') { const pl = $('button', 'btn quiet', 'Play'); pl.setAttribute('aria-label', 'Play ' + o.label); pl.onclick = () => set('v.audition', o.value); r.appendChild(pl); }
        list.appendChild(r);
      }
      return list;
    }
    if (c.options.length <= 4 && c.options.reduce((n, o) => n + o.label.length, 0) <= 40) {
      const s = $('div', 'seg'); for (const o of c.options) { const b = $('button', null, o.label); b.setAttribute('aria-pressed', String(o.value === c.value)); b.onclick = () => set(c.id, o.value); s.appendChild(b); } return s;
    }
    if (c.options.some(o => o.note)) {
      const list = $('div', 'brain');
      for (const o of c.options) { const r = $('button', 'pick' + (o.value === c.value ? ' on' : '')); r.setAttribute('role', 'radio'); r.setAttribute('aria-checked', String(o.value === c.value)); const t = $('div', 'text'); t.append($('div', 'label', o.label), $('div', 'hint', o.note || '')); r.append($('span', 'radio'), t); r.onclick = () => set(c.id, o.value); list.appendChild(r); }
      return list;
    }
    const s = $('select'); s.setAttribute('aria-label', c.label);
    for (const o of c.options) { const p = $('option', null, o.label); p.value = o.value; p.selected = o.value === c.value; s.appendChild(p); }
    s.onchange = () => set(c.id, s.value);
    if (c.id.indexOf('v.persona:') === 0) { const o = c.options.find(x => x.value === c.value), name = (o && o.voice) || c.value; const pl = $('button', 'btn quiet', 'Play'); pl.setAttribute('aria-label', 'Play the voice of ' + c.label); pl.onclick = () => set('v.audition', name); const w = $('div', 'pair'); w.append(pl, s); return w; }
    return s;
  }
  if (c.kind === 'secret') { const b = $('button', 'btn', shown.has(c.id) ? c.revealed : c.masked); b.setAttribute('aria-label', 'Show address'); b.onclick = () => { if (shown.has(c.id)) shown.delete(c.id); else shown.add(c.id); b.textContent = shown.has(c.id) ? c.revealed : c.masked; }; return b; }
  const b = $('button', 'btn', c.button); b.onclick = () => set(c.id, c.value ?? null);
  if (c.secondary) { const w = $('div', 'pair'); const b2 = $('button', 'btn', c.secondary); b2.onclick = () => set(c.id + ':later', null); w.append(b2, b); return w; }
  return b;
}
function brain(c) {
  const list = $('div', 'brain');
  for (const o of c.options) {
    const r = $('button', 'pick' + (o.value === c.value ? ' on' : '')); r.disabled = o.state !== 'ready';
    r.setAttribute('role', 'radio'); r.setAttribute('aria-checked', String(o.value === c.value));
    const t = $('div', 'text'); const l = $('div', 'label', o.label); if (o.state === 'soon') l.appendChild($('span', 'tag2', 'Coming soon'));
    t.append(l, $('div', 'hint', o.note)); r.append($('span', 'radio'), t);
    if (o.state === 'ready') r.onclick = () => set(c.id, o.value);
    list.appendChild(r);
  }
  return list;
}
function session(c) {
  const r = $('div', 'row sess'); const dot = $('span', 'sdot ' + c.state); dot.setAttribute('aria-label', c.stateLabel);
  const t = $('div', 'text'); const name = $(c.canOpen ? 'button' : 'div', 'sname', c.label);
  if (c.canOpen) { name.title = 'Open in sessions'; name.onclick = () => set(c.id, null); }
  const meta = $('div', 'hint'); meta.append(document.createTextNode(c.project + ' \\u00b7 ' + c.box + ' \\u00b7 ' + c.stateLabel));
  if (c.masked) { const a = $('button', 'reveal', shown.has(c.id) ? c.revealed : c.masked); a.setAttribute('aria-label', 'Account, press to show or hide the address'); a.title = 'Account'; a.onclick = () => { if (shown.has(c.id)) shown.delete(c.id); else shown.add(c.id); a.textContent = shown.has(c.id) ? c.revealed : c.masked; }; meta.append(a); }
  t.append(name, meta);
  if (c.canSend) {
    const f = $('form', 'send'); const i = $('input'); i.type = 'text'; i.id = 'in-' + c.id; i.placeholder = 'Send to this session'; i.setAttribute('aria-label', 'Send to ' + c.label); i.value = drafts.get(c.id) || '';
    i.oninput = () => drafts.set(c.id, i.value);
    f.onsubmit = e => { e.preventDefault(); const v = i.value.trim(); if (!v) return; drafts.delete(c.id); i.value = ''; set(c.id, v); };
    f.append(i, $('button', 'btn', 'Send')); t.append(f);
  }
  r.append(dot, t); return r;
}
const openPrompts = new Set();
function promptCheck(c) {
  const r = $('div', 'row'); r.style.alignItems = 'flex-start';
  const t = $('div', 'text'); t.style.cssText = 'flex:1;min-width:0'; t.appendChild($('div', 'label', c.label));
  const open = openPrompts.has(c.id); const p = $('div', 'hint prompt' + (open ? ' open' : ''), c.detail); t.appendChild(p);
  const side = $('div'); side.style.cssText = 'display:flex;gap:8px;flex:none';
  if (c.detail.length > 140) { const m = $('button', 'btn quiet', open ? 'Show less' : 'Show all'); m.setAttribute('aria-expanded', String(open)); m.onclick = () => { if (open) openPrompts.delete(c.id); else openPrompts.add(c.id); render(); }; side.appendChild(m); }
  const e = $('button', 'btn quiet', 'Edit'); e.onclick = () => { drafts.set('tr.list', c.label.split(':')[0] + ' = ' + c.detail); render(); const i = document.getElementById('in-tr.list'); if (i) { i.scrollIntoView({ block: 'center' }); i.focus(); } }; side.appendChild(e);
  r.append(t, side); return r;
}
function check(c) {
  if (c.id.startsWith('tr.key:') && c.detail) return promptCheck(c);
  const r = $('div', 'row'); r.style.justifyContent = 'flex-start';
  const g = $('span', 'glyph ' + c.status, c.status === 'ok' ? '\\u2713' : c.status === 'warn' ? '!' : '\\u00d7');
  g.setAttribute('aria-label', c.status === 'ok' ? 'Fine' : c.status === 'warn' ? 'Worth a look' : 'Needs fixing');
  const t = $('div', 'text'); t.appendChild($('div', 'label', c.label)); t.appendChild($('div', 'hint', c.detail)); if (c.fix) t.appendChild($('div', 'fix', c.fix));
  r.append(g, t); return r;
}
function valueOf(c) { const o = c.options.find(x => x.value === c.value); return o ? o.label : String(c.value || ''); }
function choiceRow(c) {
  const wrap = $('div', 'rowwrap'); if (c.disabled) wrap.setAttribute('data-disabled', '');
  const r = $('div', 'row'); const t = $('div', 'text'); t.appendChild($('div', 'label', c.label));
  t.appendChild($('div', 'hint', valueOf(c) + (c.hint ? ' \u00b7 ' + c.hint : '')));
  const b = $('button', 'btn quiet', changing.has(c.id) ? 'Done' : 'Change'); b.setAttribute('aria-expanded', String(changing.has(c.id)));
  b.onclick = () => { if (changing.has(c.id)) changing.delete(c.id); else changing.add(c.id); render(); };
  r.append(t, b); wrap.appendChild(r);
  if (changing.has(c.id)) { const i = $('div', 'inline'); const ctl = control(c); i.appendChild(ctl); wrap.appendChild(i); }
  return wrap;
}
function wakeRow(items) {
  const wrap = $('div', 'rowwrap'); const r = $('div', 'row'); const t = $('div', 'text'); t.appendChild($('div', 'label', 'Wake words'));
  t.appendChild($('div', 'hint', 'Say any of these to wake Tessaya. Turn off the ones you do not want.'));
  r.append(t); wrap.appendChild(r);
  { const i = $('div', 'inline wakes'); for (const x of items) { const l = $('label', 'wk'); l.append($('span', null, x.label.replace(/^Wake word: /, '')), control(x)); i.appendChild(l); } wrap.appendChild(i); }
  return wrap;
}
const memEditing = new Set(), memWhy = new Set();
function memoryRow(c) {
  const pv = !!c.store, pre = pv ? 'm.pv.' : 'm.', id = c.id.slice(pv ? 5 : 2), wrap = $('div', 'rowwrap'), r = $('div', 'row'), t = $('div', 'text');
  if (memEditing.has(c.id)) {
    const a = $('textarea', 'memedit'); a.id = 'in-e-' + c.id; a.maxLength = 500; a.setAttribute('aria-label', 'Edit this memory'); a.value = drafts.has('e-' + c.id) ? drafts.get('e-' + c.id) : c.label; a.oninput = () => drafts.set('e-' + c.id, a.value);
    const done = () => { memEditing.delete(c.id); drafts.delete('e-' + c.id); };
    const save = $('button', 'btn primary', 'Save'); save.onclick = () => { const v = a.value.trim(); done(); if (v) set(pre + 'edit:' + id, v); else render(); };
    const cancel = $('button', 'btn quiet', 'Cancel'); cancel.onclick = () => { done(); render(); };
    const acts = $('div', 'memacts'); acts.append(save, cancel); t.append(a, acts); r.appendChild(t); wrap.appendChild(r); return wrap;
  }
  t.appendChild($('div', 'label', c.label)); if (c.hint) t.appendChild($('div', 'hint', c.hint));
  if (memWhy.has(c.id) && c.why) { const y = $('div', 'hint', c.why); y.setAttribute('role', 'status'); t.appendChild(y); }
  r.appendChild(t);
  const acts = $('div', 'memacts');
  if (c.why) { const wy = $('button', 'btn quiet', memWhy.has(c.id) ? 'Hide why' : 'Why?'); wy.setAttribute('aria-expanded', String(memWhy.has(c.id))); wy.onclick = () => { if (memWhy.has(c.id)) memWhy.delete(c.id); else memWhy.add(c.id); render(); }; acts.appendChild(wy); }
  if (c.held) { const keep = $('button', 'btn primary', 'Keep'); keep.onclick = () => set(pre + 'accept:' + id, null); acts.appendChild(keep); }
  else if (c.section !== 'Replaced') {
    const ed = $('button', 'btn quiet', 'Edit'); ed.onclick = () => { memEditing.add(c.id); render(); };
    // A private memory has no pin and no history: only its words change.
    if (pv) acts.appendChild(ed);
    else { const pin = $('button', 'btn quiet', c.pinned ? 'Unpin' : 'Pin'); pin.setAttribute('aria-pressed', String(c.pinned)); pin.onclick = () => set('m.pin:' + id, !c.pinned);
      const hi = $('button', 'btn quiet', 'History'); hi.onclick = () => set('m.history:' + id, null); acts.append(pin, ed, hi);
      if (c.personaOnly) { const hh = $('button', 'btn quiet', L('memory.household')); hh.title = L('memory.householdHint', { persona: c.personaOnly }); hh.onclick = () => set('m.household:' + id, null); acts.appendChild(hh); } }
  }
  const fg = $('button', 'btn quiet', c.held && !pv ? 'Dismiss' : 'Forget'); fg.onclick = () => set(pre + 'forget:' + id, null); acts.appendChild(fg);
  r.appendChild(acts); wrap.appendChild(r); return wrap;
}
function catalogBar(c) {
  const w = $('div', 'rowwrap stack membar'), f = $('form', 'vocab'), q = $('input'); q.type = 'text'; q.id = 'in-c-q'; q.placeholder = c.words.search; q.setAttribute('aria-label', c.words.search); q.value = drafts.has('c-q') ? drafts.get('c-q') : c.query;
  let tm = null; q.oninput = () => { drafts.set('c-q', q.value); clearTimeout(tm); tm = setTimeout(() => set('c.query', q.value), 250); };
  f.onsubmit = e => { e.preventDefault(); clearTimeout(tm); set('c.query', q.value); }; f.appendChild(q); w.appendChild(f);
  const seg = $('div', 'seg memseg'); for (const k of c.states) { const b = $('button', null, k.label); b.setAttribute('aria-pressed', String(k.value === c.stateFilter)); b.onclick = () => set('c.state', k.value); seg.appendChild(b); } w.appendChild(seg);
  const tools = $('div', 'memtools');
  if (c.machines.length > 2) { const m = $('select'); m.setAttribute('aria-label', c.words.machine); for (const o of c.machines) { const op = $('option', null, o.label); op.value = o.value; m.appendChild(op); } m.value = c.machine; m.onchange = () => set('c.machine', m.value); tools.appendChild(m); }
  const bg = $('button', 'btn quiet', c.words.background); bg.setAttribute('aria-pressed', String(c.background)); bg.onclick = () => set('c.background', null); tools.appendChild(bg);
  if (c.autoResume !== null) { const ar = $('button', 'sw'); ar.setAttribute('role', 'switch'); ar.setAttribute('aria-checked', String(c.autoResume)); ar.setAttribute('aria-label', c.words.autoResume); ar.title = c.words.autoResumeHint; ar.onclick = () => set('c.autoResume', !c.autoResume); const al = $('span', 'hint', c.words.autoResume); tools.append(al, ar); }
  const td = $('button', 'btn quiet', c.words.tidy); td.onclick = () => set('c.tidy', null); tools.appendChild(td);
  if (c.tidyFound > 0) { const ta = $('button', 'btn', c.words.tidyApply + ' (' + c.tidyFound + ')'); ta.onclick = () => set('c.tidyApply', null); tools.appendChild(ta); }
  const nb = $('button', 'btn', c.words.new); nb.setAttribute('aria-expanded', String(c.creating)); nb.onclick = () => set('c.new', null); tools.appendChild(nb); w.appendChild(tools);
  if (c.creating) {
    const nf = $('form', 'newses'); nf.setAttribute('aria-label', c.words.newTitle); nf.appendChild($('div', 'nstitle', c.words.newTitle));
    const field = (label, el) => { const w = $('label', 'nsfield'); w.append($('span', 'hint', label), el); return w; };
    const sel = (opts, label, value) => { const x = $('select'); x.setAttribute('aria-label', label); for (const o of opts) { const op = $('option', null, o.label); op.value = o.value; x.appendChild(op); } if (value !== undefined) x.value = value; return x; };
    const nm = sel(c.machines.slice(1), c.words.machine, c.newMachine); nm.onchange = () => set('c.newMachine', nm.value);
    const fi = $('input'); fi.type = 'text'; fi.id = 'in-c-folder'; fi.placeholder = c.words.folder; fi.setAttribute('aria-label', c.words.folder); fi.value = drafts.get('c-folder') || '';
    const earlier = $('div', 'nsearlier'); earlier.setAttribute('role', 'status');
    const showEarlier = () => { earlier.replaceChildren(); const key = fi.value.trim().toLowerCase().replace(/[\\\\/]+$/, ''); const e = c.earlierHere.find(x => x.cwd.toLowerCase().replace(/[\\\\/]+$/, '') === key); if (!e) return;
      const rb = $('button', 'btn quiet', c.words.latest); rb.type = 'button'; rb.onclick = () => set('c:' + e.id, 'resume'); earlier.append($('span', 'hint', e.count + ' ' + c.words.earlier), rb); };
    fi.oninput = () => { drafts.set('c-folder', fi.value); showEarlier(); };
    const folders = c.folders.length ? sel([{ value: '', label: c.words.recent }, ...c.folders.slice(0, 12).map(d => ({ value: d, label: d }))], c.words.recent) : null;
    if (folders) folders.onchange = () => { if (folders.value) { fi.value = folders.value; drafts.set('c-folder', fi.value); showEarlier(); fi.focus(); } };
    const fbox = $('div', 'nsrow'); fbox.append(fi); if (folders) fbox.appendChild(folders);
    const md = sel(c.models, c.words.model), ef = sel(c.efforts, c.words.effort);
    const ms = $('textarea'); ms.id = 'in-c-msg'; ms.rows = 1; ms.placeholder = c.words.message; ms.setAttribute('aria-label', c.words.message); ms.value = drafts.get('c-msg') || '';
    const grow = () => { ms.style.height = 'auto'; ms.style.height = Math.min(ms.scrollHeight, 160) + 'px'; };
    ms.oninput = () => { drafts.set('c-msg', ms.value); grow(); };
    const go = $('button', 'btn primary', c.words.startNew); go.type = 'submit';
    nf.append(field(c.words.folder.split(',')[0], fbox), earlier, field(c.words.machine, nm), field(c.words.model, md), field(c.words.effort, ef), field(c.words.message, ms), go);
    nf.onsubmit = e => { e.preventDefault(); const v = fi.value.trim(); if (!v) return; drafts.delete('c-folder'); drafts.delete('c-msg'); set('c.start', JSON.stringify({ cwd: v, model: md.value, effort: ef.value, message: ms.value })); };
    w.appendChild(nf); showEarlier(); grow();
  }
  if (c.status) { const x = $('div', 'hint memstatus', c.status); x.setAttribute('role', 'status'); w.appendChild(x); }
  if (c.remaining > 0) { const mb = $('button', 'btn quiet', c.words.more + ' (' + c.remaining + ')'); mb.onclick = () => set('c.more', null); w.appendChild(mb); }
  return w;
}
function catalogRow(c) {
  const r = $('div', 'row sess'); const dot = $('span', 'sdot ' + (c.state === 'running' ? 'working' : c.state === 'resuming' ? 'waiting' : 'idle')); dot.setAttribute('aria-label', c.stateLabel);
  const t = $('div', 'text'); const name = $(c.state === 'running' ? 'button' : 'div', 'sname', c.label);
  if (c.state === 'running') name.onclick = () => set(c.id, null);
  const meta = $('div', 'hint'); meta.append(document.createTextNode([c.project, c.machine, c.stateLabel, c.binding, c.when, c.source].filter(Boolean).join(' \\u00b7 ')));
  t.append(name, meta); if (c.note) t.appendChild($('div', 'hint', c.note)); r.append(dot, t);
  if (c.stopLabel) { const sb = $('button', 'btn quiet', c.stopLabel); sb.setAttribute('aria-label', c.stopLabel + ' ' + c.label); sb.onclick = () => set(c.id, 'stop'); r.appendChild(sb); }
  if (c.reattachLabel) { const ab = $('button', 'btn quiet', c.reattachLabel); ab.setAttribute('aria-label', c.reattachLabel + ' ' + c.label); ab.onclick = () => set(c.id, 'reattach'); r.appendChild(ab); }
  if (c.resumeLabel) { const b = $('button', 'btn', c.resumeLabel); b.setAttribute('aria-label', c.resumeLabel + ' ' + c.label); b.onclick = () => set(c.id, 'resume'); r.appendChild(b); }
  if (!c.keptLabel) return r;
  const kb = $('button', 'btn quiet', c.keptLabel); kb.setAttribute('aria-expanded', String(c.kept !== null)); kb.setAttribute('aria-label', c.keptLabel + ' for ' + c.label); kb.onclick = () => set(c.id, 'kept'); t.appendChild(kb);
  if (c.kept === null) return r;
  const w = $('div', 'rowwrap stack'); w.appendChild(r);
  c.kept.forEach((text, i) => { const line = $('div', 'row'); line.appendChild($('div', 'text hint', text)); if (!c.keptNote) { const db = $('button', 'btn quiet', c.discardLabel); db.setAttribute('aria-label', c.discardLabel + ': ' + text.slice(0, 60)); db.onclick = () => set(c.id, 'discard:' + i); line.appendChild(db); } w.appendChild(line); });
  if (c.keptNote) { const n = $('div', 'hint', c.keptNote); n.setAttribute('role', 'status'); w.appendChild(n); }
  return w;
}
function memoryBar(c) {
  const w = $('div', 'rowwrap stack membar'), f = $('form', 'vocab'), q = $('input'); q.type = 'text'; q.id = 'in-m-q'; q.placeholder = 'Search what Tessaya remembers'; q.setAttribute('aria-label', 'Search memory'); q.value = drafts.has('m-q') ? drafts.get('m-q') : c.query;
  let tm = null; q.oninput = () => { drafts.set('m-q', q.value); clearTimeout(tm); tm = setTimeout(() => set('m.query', q.value), 250); };
  f.onsubmit = e => { e.preventDefault(); clearTimeout(tm); set('m.query', q.value); }; f.appendChild(q); w.appendChild(f);
  const seg = $('div', 'seg memseg'); for (const k of c.kinds) { const b = $('button', null, k.label + ' ' + k.count); b.setAttribute('aria-pressed', String(k.value === c.filter)); b.onclick = () => set('m.kind', k.value); seg.appendChild(b); } w.appendChild(seg);
  const tools = $('div', 'memtools');
  if (c.usedCount) { const u = $('button', 'btn quiet', 'Used in the last answer (' + c.usedCount + ')'); u.setAttribute('aria-pressed', String(c.usedOnly)); u.onclick = () => set('m.used', !c.usedOnly); tools.appendChild(u); }
  const ex = $('button', 'btn quiet', 'Export'); ex.onclick = () => set('m.export', null); tools.appendChild(ex); w.appendChild(tools);
  const imp = $('form', 'vocab'), fi = $('input'); fi.type = 'text'; fi.id = 'in-m-imp'; fi.placeholder = 'Import a folder of .md learnings: its full path'; fi.setAttribute('aria-label', 'Folder to import'); fi.value = drafts.get('m-imp') || ''; fi.oninput = () => drafts.set('m-imp', fi.value);
  const ib = $('button', 'btn quiet', 'Import'); ib.type = 'submit'; imp.append(fi, ib); imp.onsubmit = e => { e.preventDefault(); const v = fi.value.trim(); if (!v) return; drafts.delete('m-imp'); set('m.import', v); }; w.appendChild(imp);
  const sy = $('div', 'row'), st = $('div', 'text'); st.append($('div', 'label', 'Keep servers in step'), $('div', 'hint', 'Memory is carried between the servers this window is connected to. The last change wins, and a forgotten memory stays forgotten.'));
  const sw = $('button', 'sw'); sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(c.syncOn)); sw.setAttribute('aria-label', 'Keep servers in step'); sw.onclick = () => set('m.syncOn', !c.syncOn); sy.append(st, sw);
  if (c.syncOn) { const nb = $('button', 'btn quiet', 'Sync now'); nb.onclick = () => set('m.sync', null); sy.appendChild(nb); } w.appendChild(sy);
  if (c.syncOn) { for (const p of c.peers) { const r = $('div', 'row'), t = $('div', 'text'); t.append($('div', 'label', p.label), $('div', 'hint', p.local ? 'The server this app runs.' : p.paired ? 'Walled memory syncs with it' + (p.expiresAt ? ' until ' + new Date(p.expiresAt).toLocaleDateString() + '; pair it again before then.' : '.') : 'Walled memory not syncing: pair for sync.')); r.appendChild(t);
    if (p.local) { const pb = $('button', 'btn quiet', 'Pair for memory sync'); pb.onclick = () => set('m.syncPair', null); r.appendChild(pb); }
    else if (p.paired) { const sb = $('button', 'btn quiet', 'Stop syncing walled memory'); sb.onclick = () => set('m.syncForget:' + p.environmentId, null); r.appendChild(sb); }
    else { const pf = $('form', 'vocab'), ci = $('input'); ci.type = 'text'; ci.placeholder = L('memory.sync.codePlaceholder'); ci.setAttribute('aria-label', 'Pairing code from ' + p.label); const cb = $('button', 'btn quiet', 'Pair'); cb.type = 'submit'; pf.append(ci, cb); pf.onsubmit = e => { e.preventDefault(); const v = ci.value.trim(); if (v) set('m.syncLink:' + p.environmentId, v); }; r.appendChild(pf); }
    w.appendChild(r); } }
  const pl = $('div', 'row'), pt = $('div', 'text'); pt.append($('div', 'label', 'Pull learnings from the history index'), $('div', 'hint', 'Once a day, short quotes about what worked and failed in your ventures are proposed here. They wait for your yes; nothing is copied from a session.'));
  const ps = $('button', 'sw'); ps.setAttribute('role', 'switch'); ps.setAttribute('aria-checked', String(c.pullOn)); ps.setAttribute('aria-label', 'Pull learnings'); ps.onclick = () => set('m.pullOn', !c.pullOn); pl.append(pt, ps);
  if (c.pullOn) { const pb = $('button', 'btn quiet', 'Pull now'); pb.onclick = () => set('m.pull', null); pl.appendChild(pb); } w.appendChild(pl);
  if (c.status) { const x = $('div', 'hint memstatus', c.status); x.setAttribute('role', 'status'); w.appendChild(x); }
  return w;
}
function listRow(c) {
  const w = $('div', 'rowwrap stack'); const t = $('div', 'row'); const x = $('div', 'text'); x.appendChild($('div', 'label', c.label)); if (c.hint) x.appendChild($('div', 'hint', c.hint)); t.appendChild(x); w.appendChild(t);
  for (const it of c.items) { const r = $('div', 'row'); r.appendChild($('div', 'label', it)); if (!c.required) { const b = $('button', 'btn quiet', 'Remove'); b.setAttribute('aria-label', 'Remove ' + it); b.onclick = () => set(c.id + ':rm', it); r.appendChild(b); } w.appendChild(r); }
  const add = $('div', 'row'); const inp = $('input', 'search'); inp.type = c.secret ? 'password' : 'text'; inp.autocomplete = 'off'; inp.placeholder = c.placeholder; inp.setAttribute('aria-label', c.label);
  inp.id = 'in-' + c.id; inp.value = drafts.get(c.id) || ''; inp.oninput = () => drafts.set(c.id, inp.value);
  const ab = $('button', 'btn', c.addLabel || 'Add'); const go = () => { const v = inp.value.trim(); if (v) { drafts.delete(c.id); set(c.id + ':add', v); } };
  ab.onclick = go; inp.onkeydown = e => { if (e.key === 'Enter') go(); }; add.append(inp, ab); w.appendChild(add); return w;
}
function vtInput(id, ph, type) { const i = $('input'); i.type = type || 'text'; i.id = 'in-' + id; i.placeholder = ph; i.setAttribute('aria-label', ph); i.autocomplete = 'off'; i.value = drafts.get(id) || ''; i.oninput = () => drafts.set(id, i.value); return i; }
function vtForm(fields, button, run) { const f = $('form', 'vocab'); f.append(...fields); const b = $('button', 'btn' + (button.primary ? ' primary' : ' quiet'), button.label); b.type = 'submit'; f.appendChild(b); f.onsubmit = e => { e.preventDefault(); run(); }; return f; }
function vaultBar(c) {
  const w = $('div', 'rowwrap stack vaultbar');
  if (c.recovery) {
    const k = $('div', 'row'); const t = $('div', 'text'); t.append($('div', 'label', 'Your recovery key'), $('div', 'hint', 'Print it or save it somewhere safe. It is shown once and is the only way in if you forget the passphrase.')); const pre = $('div', 'hpre vaultkey', c.recovery); t.appendChild(pre);
    const sv = $('button', 'btn', 'Save as a file'); sv.onclick = () => set('vt.recoverySave', null); const pr = $('button', 'btn', 'Print'); pr.onclick = () => set('vt.recoveryPrint', null); const ok = $('button', 'btn primary', 'I have saved it'); ok.onclick = () => set('vt.recoveryDone', null); const bx = $('div', 'memacts'); bx.append(sv, pr, ok); k.append(t, bx); w.appendChild(k);
  }
  if (c.state === 'none') {
    w.appendChild(vtForm([vtInput('vt-new', 'Choose a passphrase (8 or more characters)', 'password')], { label: 'Make the vault', primary: true }, () => { const v = drafts.get('vt-new') || ''; drafts.delete('vt-new'); set('vt.create', v); }));
  } else if (c.state === 'locked') {
    w.appendChild(vtForm([vtInput('vt-pass', 'Passphrase', 'password')], { label: 'Unlock', primary: true }, () => { const v = drafts.get('vt-pass') || ''; drafts.delete('vt-pass'); set('vt.unlock', v); }));
    const alt = $('div', 'memtools');
    const hb = $('button', 'btn quiet', 'Unlock with Windows Hello'); hb.onclick = () => set('vt.unlockHello', null); alt.appendChild(hb); w.appendChild(alt);
    w.appendChild(vtForm([vtInput('vt-rec', 'Or a recovery key', 'password')], { label: 'Use recovery key' }, () => { const v = drafts.get('vt-rec') || ''; drafts.delete('vt-rec'); set('vt.unlockRecovery', v); }));
  } else {
    const cat = $('select'); cat.id = 'in-vt-cat'; cat.setAttribute('aria-label', 'What kind'); for (const k of ['login', 'key', 'note', 'id', 'file', 'financial']) { const o = $('option', null, k); o.value = k; cat.appendChild(o); }
    const nm = vtInput('vt-name', 'Name, like github'), lb = vtInput('vt-label', 'A note to yourself (optional)'), vl = vtInput('vt-value', 'The secret', 'password');
    w.appendChild(vtForm([nm, lb, cat, vl], { label: 'Add', primary: true }, () => { const v = { name: nm.value.trim(), label: lb.value, category: cat.value, value: vl.value }; ['vt-name', 'vt-label', 'vt-value'].forEach(d => drafts.delete(d)); set('vt.add', JSON.stringify(v)); }));
    w.appendChild($('div', 'hint memstatus', 'Passwords of banks and cards can be kept here, but Tessaya will never fill them in: you type those yourself.'));
  }
  if (c.status) { const x = $('div', 'hint memstatus', c.status); x.setAttribute('role', 'status'); w.appendChild(x); }
  if (c.state === 'unlocked') {
    const tools = $('div', 'memtools'); const lk = $('button', 'btn', 'Lock now'); lk.onclick = () => set('vt.lock', null); tools.appendChild(lk); w.appendChild(tools);
    w.appendChild(vtForm([vtInput('vt-exp', 'Export passphrase', 'password')], { label: 'Export encrypted file' }, () => { const v = drafts.get('vt-exp') || ''; drafts.delete('vt-exp'); set('vt.export', v); }));
    const ip = vtInput('vt-imp', 'Path of an exported file'), iw = vtInput('vt-imppw', 'Its passphrase', 'password');
    w.appendChild(vtForm([ip, iw], { label: 'Import' }, () => { const v = { path: ip.value.trim(), passphrase: iw.value }; drafts.delete('vt-imp'); drafts.delete('vt-imppw'); set('vt.import', JSON.stringify(v)); }));
  }
  if ((c.activity || []).length) {
    w.appendChild($('h3', 'vaulthead', 'Activity'));
    for (const line of c.activity) { let e = null; try { e = JSON.parse(line); } catch (x) { e = null; } if (!e) continue; const r = $('div', 'kv'); r.append($('div', null, e.name + ' \u00b7 ' + e.outcome + ' \u00b7 ' + (e.target || '') + (e.purpose ? ' \u00b7 ' + e.purpose : '')), $('time', 'hint', clock(e.at))); w.appendChild(r); }
  }
  return w;
}
function pvPeople(c) {
  const w = $('div', 'rowwrap stack membar');
  if (c.recovery) {
    const k = $('div', 'row'), t = $('div', 'text'); t.append($('div', 'label', L('pv.recovery.title', { name: c.recovery.name })), $('div', 'hint', L('pv.recovery.hint')), $('div', 'hpre vaultkey', c.recovery.code));
    const bx = $('div', 'memacts'); for (const [k2, to, cls] of [['pv.recovery.save', 'm.pv.recoverySave', 'btn'], ['pv.recovery.copy', 'm.pv.recoveryCopy', 'btn'], ['pv.recovery.done', 'm.pv.recoveryDone', 'btn primary']]) { const b = $('button', cls, L(k2)); b.onclick = () => set(to, null); bx.appendChild(b); }
    k.append(t, bx); w.appendChild(k);
  }
  const pinForm = (key, ph, button, primary, to) => vtForm([vtInput(key, ph, 'password')], { label: button, primary }, () => { const v = drafts.get(key) || ''; drafts.delete(key); if (v) set(to, v); else render(); });
  for (const p of c.people) {
    const r = $('div', 'row'), t = $('div', 'text'), nm = $('div', 'label', p.name); if (p.state !== 'open' && p.state !== 'everyday') { const k = icon('lock', 13); k.style.marginLeft = '6px'; k.setAttribute('aria-hidden', 'true'); nm.appendChild(k); }
    t.append(nm, $('div', 'hint', p.note)); r.appendChild(t);
    const b = $('button', 'btn quiet', L(p.selected ? 'pv.showing' : 'pv.show')); b.setAttribute('aria-pressed', String(p.selected)); b.setAttribute('aria-label', L('pv.show') + ': ' + p.name); b.onclick = () => set('m.pv.pick:' + p.id, null); r.appendChild(b); w.appendChild(r);
    if (!p.selected || p.state === 'open' || p.state === 'everyday') continue;
    if (p.state === 'locked') w.appendChild(pinForm('pv-pin-' + p.id, L('pv.pin'), L('pv.open'), true, 'm.pv.unlock:' + p.id));
    w.appendChild(pinForm('pv-rec-' + p.id, L('pv.recoveryCode'), L('pv.useRecovery'), false, 'm.pv.recover:' + p.id));
    if (p.admin) { const tl = $('div', 'memtools'), a = $('button', 'btn quiet', L('pv.openAdmin')); a.onclick = () => set('m.pv.admin:' + p.id, null); tl.appendChild(a); w.appendChild(tl); }
  }
  const multi = (keys, button, primary, to, fields) => { const ins = keys.map(([k, ph, type]) => vtInput(k, ph, type)); return vtForm(ins, { label: button, primary }, () => { const v = {}; keys.forEach(([k], n) => { v[fields[n]] = ins[n].value; drafts.delete(k); }); set(to, JSON.stringify(v)); }); };
  if (c.canSetup) { w.appendChild($('div', 'hint memstatus', L('pv.setup.hint'))); w.appendChild(multi([['pv-new', L('pv.setup.pin'), 'password'], ['pv-new2', L('pv.again'), 'password']], L('pv.setup.button'), true, 'm.pv.setup', ['pin', 'again'])); }
  if (c.ownerOpen) {
    w.appendChild($('h3', 'vaulthead', L('pv.add.title')));
    if (c.voices.length === 0) w.appendChild($('div', 'hint memstatus', L('pv.add.noVoices')));
    else {
      const pick = $('select'); pick.id = 'in-pv-aid'; pick.setAttribute('aria-label', L('pv.add.profile'));
      for (const v of c.voices) { const o = $('option', '', v.name); o.value = v.id; pick.appendChild(o); }
      if (drafts.has('pv-aid')) pick.value = drafts.get('pv-aid'); pick.onchange = () => drafts.set('pv-aid', pick.value);
      const ins = [vtInput('pv-an', L('pv.add.name')), vtInput('pv-ap', L('pv.add.pin'), 'password'), vtInput('pv-ap2', L('pv.again'), 'password')];
      w.appendChild(vtForm([pick, ...ins], { label: L('pv.add.button'), primary: false }, () => {
        const v = { personId: pick.value, name: ins[0].value, pin: ins[1].value, again: ins[2].value };
        for (const k of ['pv-aid', 'pv-an', 'pv-ap', 'pv-ap2']) drafts.delete(k);
        set('m.pv.addPerson', JSON.stringify(v));
      }));
    }
  }
  if (c.status) { const x = $('div', 'hint memstatus', c.status); x.setAttribute('role', 'status'); w.appendChild(x); }
  return w;
}
function pvBar(c) {
  const s = c.store, w = $('div', 'rowwrap stack membar'), f = $('form', 'vocab'), q = $('input'), dq = 'pv-q-' + s; q.type = 'text'; q.id = 'in-' + dq; q.placeholder = L('pv.search'); q.setAttribute('aria-label', L('pv.search')); q.value = drafts.has(dq) ? drafts.get(dq) : c.query;
  let tm = null; q.oninput = () => { drafts.set(dq, q.value); clearTimeout(tm); tm = setTimeout(() => set('m.pv.query', q.value), 250); };
  f.onsubmit = e => { e.preventDefault(); clearTimeout(tm); set('m.pv.query', q.value); }; f.appendChild(q); w.appendChild(f);
  const tools = $('div', 'memtools');
  const lk = $('button', 'btn', L('pv.lock')); lk.onclick = () => { drafts.delete(dq); set('m.pv.lock:' + s, null); }; tools.appendChild(lk);
  const au = $('button', 'btn quiet', L('pv.audit')); au.setAttribute('aria-pressed', String(c.audit !== null)); au.onclick = () => set('m.pv.audit:' + s, null); tools.appendChild(au);
  if (c.canDelete) { const dl = $('button', 'btn quiet', L(c.confirmDelete ? 'pv.deleteSure' : 'pv.delete')); dl.onclick = () => set('m.pv.delete:' + s, null); tools.appendChild(dl); }
  w.appendChild(tools);
  const rr = $('div', 'row'), rt = $('div', 'text'); rt.append($('div', 'label', L('pv.recall')), $('div', 'hint', L('pv.recall.hint')));
  const sw = $('button', 'sw'); sw.setAttribute('role', 'switch'); sw.setAttribute('aria-checked', String(!c.recallOff)); sw.setAttribute('aria-label', L('pv.recall')); sw.onclick = () => set('m.pv.recall:' + s, c.recallOff); rr.append(rt, sw); w.appendChild(rr);
  const ek = 'pv-exp-' + s; w.appendChild(vtForm([vtInput(ek, L('pv.export.pin'), 'password')], { label: L('pv.export') }, () => { const v = drafts.get(ek) || ''; drafts.delete(ek); set('m.pv.export:' + s, v); }));
  if (c.canChangePin) { const ks = [['pv-cp0-' + s, L('pv.changePin.old')], ['pv-cp1-' + s, L('pv.changePin.new')], ['pv-cp2-' + s, L('pv.again')]], ins = ks.map(([k, ph]) => vtInput(k, ph, 'password'));
    w.appendChild(vtForm(ins, { label: L('pv.changePin') }, () => { const v = JSON.stringify({ pin: ins[0].value, newPin: ins[1].value, again: ins[2].value }); ks.forEach(([k]) => drafts.delete(k)); set('m.pv.changePin:' + s, v); })); }
  if (c.audit) {
    w.appendChild($('h3', 'vaulthead', L('pv.audit')));
    const ok = $('div', 'hint memstatus', L(c.audit.intact ? 'pv.audit.intact' : 'pv.audit.changed')); if (!c.audit.intact) ok.style.color = 'var(--warn)'; ok.setAttribute('role', 'status'); w.appendChild(ok);
    if (!c.audit.rows.length) w.appendChild($('div', 'hint memstatus', L('pv.audit.none')));
    for (const a of c.audit.rows) { const r = $('div', 'kv'); r.append($('div', null, a.line), $('time', 'hint', clock(a.at))); w.appendChild(r); }
  }
  return w;
}
function vaultItem(c) {
  const wrap = $('div', 'rowwrap'), r = $('div', 'row'), t = $('div', 'text'); t.append($('div', 'label', c.label), $('div', 'hint', c.hint));
  if (c.revealed !== null) { const v = $('div', 'hpre vaultkey', c.revealed); v.setAttribute('role', 'status'); t.appendChild(v); }
  r.appendChild(t); const acts = $('div', 'memacts'), id = c.id.slice(3);
  const rv = $('button', 'btn quiet', 'Reveal'); rv.onclick = () => set('vt.reveal:' + id, null);
  const cp = $('button', 'btn quiet', 'Copy'); cp.onclick = () => set('vt.copy:' + id, null);
  acts.append(rv, cp);
  if (!c.locked) { const sel = $('select'); sel.setAttribute('aria-label', 'Who may use ' + c.label); for (const [v, l] of [['ask', 'Ask me each time'], ['domain:10', 'Allow a site for 10 minutes'], ['never', 'Only me']]) { const o = $('option', null, l); o.value = v; o.selected = v === c.policy; sel.appendChild(o); } sel.onchange = () => set('vt.policy:' + id, sel.value); acts.appendChild(sel); }
  const dl = $('button', 'btn quiet', 'Delete'); dl.onclick = () => set('vt.delete:' + id, null); acts.appendChild(dl);
  r.appendChild(acts); wrap.appendChild(r); return wrap;
}
function row(c) {
  if (c.kind === 'vaultBar') return vaultBar(c);
  if (c.kind === 'vaultItem') return vaultItem(c);
  if (c.kind === 'list') return listRow(c);
  if (c.kind === 'memory') return memoryRow(c);
  if (c.kind === 'memoryBar') return memoryBar(c);
  if (c.kind === 'privatePeople') return pvPeople(c);
  if (c.kind === 'privateBar') return pvBar(c);
  if (c.kind === 'catalogBar') return catalogBar(c);
  if (c.kind === 'catalogRow') return catalogRow(c);
  // A choice shows its options where it is: a few short ones as buttons, more as a menu, a list with notes below its label.
  if (c.kind === 'choice' && (c.id === 's.voice' || c.options.some(o => o.note))) { const w = $('div', 'rowwrap stack'); const t = $('div', 'row'); const x = $('div', 'text'); x.appendChild($('div', 'label', c.label)); if (c.hint) x.appendChild($('div', 'hint', c.hint)); t.appendChild(x); w.append(t, control(c)); return w; }
  if (c.kind === 'session') return session(c);
  if (c.kind === 'check') return check(c);
  if (c.kind === 'brain') { const r = $('div', 'brainRow'); if (c.hint) r.appendChild($('div', 'hint', c.hint)); r.appendChild(brain(c)); return r; }
  const r = $('div', 'row'); if (c.disabled) r.setAttribute('data-disabled', '');
  const t = $('div', 'text'); t.appendChild($('div', 'label', c.label)); if (c.hint) t.appendChild($('div', 'hint', c.hint));
  r.append(t, control(c)); return r;
}
function rowsOf(list, host) {
  const wakes = list.filter(x => x.id.indexOf('v.wake:') === 0); let done = false;
  for (const c of list) { if (c.kind === 'enrol') continue; if (c.id.indexOf('v.wake:') === 0) { if (!done) { done = true; host.appendChild(wakeRow(wakes)); } continue; } host.appendChild(row(c)); }
}
function group(name, items) {
  const g = $('div', 'group' + (open.has(name) ? ' open' : ''));
  rowsOf(items.filter(x => !x.more), g);
  const more = items.filter(x => x.more);
  if (more.length) {
    const w = $('div', 'more'), i = $('div'); rowsOf(more, i); w.appendChild(i); g.appendChild(w);
    const names = more.filter(x => x.kind !== 'check' || more.length < 3).map(x => x.label.replace(/^Wake word: /, '').toLowerCase()), held = names.slice(0, 3).join(', ') + (names.length > 3 ? ' and more' : '');
    const ml = (more.find(x => x.moreLabel) || {}).moreLabel || ('Advanced: ' + held), fl = ml === 'Show all' ? 'Show fewer' : 'Hide advanced';
    const b = $('button', 'moreBtn'); b.setAttribute('aria-expanded', String(open.has(name))); const sp = $('span', null, open.has(name) ? fl : ml); b.append(sp, icon('chev', 10));
    b.onclick = () => { if (open.has(name)) open.delete(name); else open.add(name); g.classList.toggle('open'); b.setAttribute('aria-expanded', String(open.has(name))); sp.textContent = open.has(name) ? fl : ml; };
    g.appendChild(b);
  }
  return g;
}
function sections(items) {
  const out = []; for (const c of items) { let s = out.find(x => x.name === c.section); if (!s) { s = { name: c.section, items: [], lead: false }; out.push(s); } if (c.lead) s.lead = true; s.items.push(c); }
  out.sort((a, b) => Number(b.lead) - Number(a.lead)); return out;
}
function tabControls(tab) { return S.controls.filter(c => c.tab === tab); }
function find(id) { return S.controls.find(c => c.id === id); }

// The greeting is picked here from what the page already knows, never by a model, so it is instant; the last few are not repeated.
const NIGHT_MS = 5 * 3600000;
function greetContext(now, saved, waiting) {
  const day = (t) => new Date(t).toDateString(), h = now.getHours(), late = h < 5 || h >= 23;
  const last = saved.last ? new Date(saved.last) : null;
  const daysAway = last ? Math.floor((now - last) / 86400000) : 0;
  const night = day(now.getTime() - NIGHT_MS);
  const nights = late && saved.nights.indexOf(night) < 0 ? saved.nights.concat(night).slice(-7) : saved.nights;
  let lateNights = 0;
  if (late) while (nights.indexOf(day(now.getTime() - NIGHT_MS - lateNights * 86400000)) >= 0) lateNights++;
  return { ctx: { now, waiting, daysAway, firstToday: !last || day(last) !== day(now), lateNights }, nights };
}
function greetLine(c, recent, rand) {
  const h = c.now.getHours(), d = c.now.getDay(), late = h < 5 || h >= 23, pools = [];
  // The banner below carries the count, so these lines never repeat it.
  if (c.waiting > 0) pools.push('waiting');
  if (c.daysAway >= 2) pools.push('away');
  if (late && c.lateNights >= 3) pools.push('lateRun');
  if (c.firstToday && !late && [0, 1, 5, 6].indexOf(d) >= 0) pools.push(d === 1 ? 'monday' : d === 5 ? 'friday' : 'weekend');
  pools.push(late ? 'small' : h < 8 ? 'early' : h < 12 ? 'morning' : h < 18 ? 'afternoon' : 'evening');
  const keysOf = (p) => Object.keys(STR).filter(k => k.indexOf('greet.' + p + '.') === 0);
  let keys = [];
  for (const p of pools) { keys = keysOf(p).filter(k => recent.indexOf(k) < 0); if (keys.length) break; }
  if (!keys.length) keys = keysOf(pools[pools.length - 1]);
  const key = keys[Math.floor(rand() * keys.length)];
  return { key, text: L(key, { n: c.lateNights, days: c.daysAway }) };
}
let greet = null, hiddenAt = 0;
function greeting() {
  if (greet) return greet;
  let saved = { last: null, recent: [], nights: [] };
  try { saved = Object.assign(saved, JSON.parse(localStorage.getItem('tessaya.greet') || '{}')); } catch (e) {}
  const now = new Date(), x = S.extra || {};
  const g = greetContext(now, saved, (x.stats && x.stats.needYou) || 0);
  const pick = greetLine(g.ctx, saved.recent, Math.random);
  greet = pick.text;
  try { localStorage.setItem('tessaya.greet', JSON.stringify({ last: now.toISOString(), recent: saved.recent.concat(pick.key).slice(-4), nights: g.nights })); } catch (e) {}
  return greet;
}
// Back after half an hour away is a new open, so it gets a new greeting.
document.addEventListener('visibilitychange', () => { if (document.hidden) hiddenAt = Date.now(); else if (hiddenAt && Date.now() - hiddenAt > 1800000) { greet = null; hiddenAt = 0; render(); } });
function chipEl(t, plain) { return $('span', 'chip' + (plain ? ' plain' : ''), t); }
function pageHead(title, lede) { const f = document.createDocumentFragment(); f.appendChild($('h1', null, title)); if (lede) f.appendChild($('p', 'lede', lede)); return f; }
function banner(kind, em, title, text, btn, onclick) {
  const b = $('div', 'banner' + (kind ? ' ' + kind : '')); const d = $('div'); const h = $('h3'); h.append(document.createTextNode(title + ' ')); h.appendChild($('em', null, em)); d.append(h, $('p', null, text)); b.appendChild(d);
  if (btn) { const x = $('button', 'btn', btn); x.onclick = onclick; b.appendChild(x); }
  return b;
}
function dayLabel(iso) { const d = new Date(iso), t = new Date(); const same = (a, b) => a.toDateString() === b.toDateString(); const y = new Date(t); y.setDate(t.getDate() - 1); return same(d, t) ? 'Today' : same(d, y) ? 'Yesterday' : d.toLocaleDateString([], { month: 'long', day: 'numeric' }); }
function clock(iso) { return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }

// The wake sting plays once on one mark, in the palette and theme in use: the sidebar's when the window opens without the splash, About's when About opens.
let stingUntil = 0, stingAt = 'side', stingSrc = '', stingAsk = 0;
function startSting(where) {
  if (!real || stillMotion()) return;
  // The main process reads the one file for the palette and theme in use; without it, one deep breath.
  const ask = ++stingAsk;
  ipc.invoke('baton-home:sting').then(bytes => {
    if (ask !== stingAsk) return;
    if (!bytes || !bytes.length) return deepBreath(where || 'side');
    if (stingSrc) URL.revokeObjectURL(stingSrc);
    stingSrc = URL.createObjectURL(new Blob([bytes], { type: 'image/webp' }));
    stingAt = where || 'side'; stingUntil = Date.now() + 3600; redrawMark(); setTimeout(redrawMark, 3650);
  }).catch(() => {});
}
const stillMotion = () => matchMedia('(prefers-reduced-motion:reduce)').matches || /motion-(reduced|off)/.test(document.documentElement.className);
// A redraw replaces the mark's element: the keyboard focus goes back onto it.
function redrawMark() { const f = document.activeElement && document.activeElement.id; render(); if (f === 'mark' || f === 'aboutmark') { const n = document.getElementById(f); if (n) n.focus(); } }
// A mark is a button: a click, Enter or Space plays it now. The sting in the window, one deep breath in a preview.
let deepUntil = 0, deepAt = 'side';
function playMark(where) {
  if (stillMotion()) return;
  if (real) { if (Date.now() >= stingUntil) startSting(where); return; }
  deepBreath(where);
}
function deepBreath(where) {
  if (Date.now() < deepUntil) return;
  deepAt = where; deepUntil = Date.now() + 1600; redrawMark(); setTimeout(redrawMark, 1650);
}
// With motion off a mark does nothing, so it is not offered as a button. A deep breath survives a redraw: it resumes where it was.
function markButton(el, where) {
  if (Date.now() < deepUntil && where === deepAt) { el.classList.add('deep'); el.style.animationDelay = (Date.now() - deepUntil + 1600) * -1 + 'ms'; }
  if (stillMotion()) return;
  el.setAttribute('role', 'button'); el.tabIndex = 0; el.setAttribute('aria-label', 'Play the Tessaya mark'); el.onclick = () => playMark(where); el.onkeydown = e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); playMark(where); } };
}
function markHtml(where) {
  if (Date.now() < stingUntil && where === stingAt && stingSrc) return '<img alt="" style="width:140.9%;height:140.9%;margin:-20.45%;display:block;max-width:none" src="' + stingSrc + '">';
  return S.status.brandMark || S.status.mark;
}
function sayWords(words) { return words.length ? 'Say ' + words.slice(0, 2).join(' or ') + ' to talk.' : 'The wake word is off. Say Wake now, or hold your dictation key.'; }
function wakeLine(words) { return words.length ? words.join(', ') : 'Off'; }
function home(p) {
  const x = S.extra || {}; const words = x.wakeWords || [];
  p.appendChild($('div', 'dateline', new Date().toLocaleDateString([], { weekday: 'long', day: 'numeric', month: 'long' })));
  p.appendChild($('h1', null, greeting()));
  const sub = $('p', 'lede');
  sub.textContent = sayWords(words);
  p.appendChild(sub);
  const tour = x.setup;
  if (tour && tour.mode === 'offer') { const o = banner('', L('wizard.offer.em'), L('wizard.offer.title'), L('wizard.offer.text'), L('wizard.offer.start'), tourStart); const later = $('button', 'btn', L('wizard.offer.later')); later.style.marginLeft = '8px'; later.onclick = () => set('q.setupOffered', true); o.appendChild(later); p.appendChild(o); }
  const q = $('div', 'quick');
  const mk = (label, id, pressed) => { const b = $('button', 'pill', label); if (pressed !== undefined) b.setAttribute('aria-pressed', String(pressed)); b.onclick = () => set(id, pressed === undefined ? null : !pressed); return b; };
  const en = find('v.enabled'), mu = find('v.muted');
  if (en) q.appendChild(mk('Listening', 'v.enabled', en.on));
  if (mu) q.appendChild(mk('Mute', 'v.muted', mu.on));
  q.append(mk('Wake now', 'q.wake'), mk('Ask Tessaya', 'q.ask'), mk('Clear the screen', 'q.clear'), mk('Stop', 'q.stop'));
  p.appendChild(q);
  const up = find('u.act');
  const brainCtl = find('s.brain');
  if (brainCtl && brainCtl.lead) p.appendChild(banner('', 'what Tessaya works through', 'Choose', 'Claude Code or Codex. You can change it later.', 'Choose', () => go('assistant')));
  else if (up && up.lead) p.appendChild(banner('', 'a quiet moment', 'Tessaya will restart in', up.hint, null));
  const need = (x.stats && x.stats.needYou) || 0;
  if (need > 0) p.appendChild(banner('warn', 'you', need + (need === 1 ? ' session needs' : ' sessions need'), 'Answer them in T3.', 'Show in T3', showLive));
  const sp = $('div', 'split'); const left = $('div'); const right = $('div', 'rail');
  const items = (x.activity || []).slice(0, 5);
  left.appendChild($('div', 'day first', 'Today'));
  if (!items.length) left.appendChild($('div', 'empty', 'Nothing yet. Say a wake word, or hold your dictation key and speak.'));
  else { const card = $('div', 'group entries'); for (const a of items) card.appendChild(entry(a, true)); left.appendChild(card); }
  const all = $('button', 'btn quiet', SEE_ALL); all.style.marginTop = '10px'; all.onclick = () => go('history'); left.appendChild(all);
  const st = $('div', 'stats tiles'); const s2 = x.stats || {}, gl = x.insights || {};
  const tiles = gl.minutesSaved === undefined ? [[s2.turns || 0, 'turns today'], [s2.dictations || 0, 'dictations today']] : [[gl.wordsToday.toLocaleString(), 'words dictated today'], [gl.minutesSaved + ' min', 'saved, roughly, vs typing at 40 wpm']];
  for (const [n, l] of [...tiles, [s2.sessions || 0, 'live sessions']]) { const r = $('div', 'stat'); r.append($('b', null, String(n)), $('span', null, l)); st.appendChild(r); }
  right.appendChild($('div', 'day first', 'At a glance')); right.appendChild(st);
  const ins = (S.extra && S.extra.insights) || null;
  if (ins) {
    right.appendChild($('div', 'day', 'Your dictation'));
    const ig = $('div', 'stats');
    const irow = (l, v) => { const r = $('div', 'stat kvr'); r.append($('span', null, l), $('b', 'sm', v)); return r; };
    ig.appendChild(irow('Speed', ins.wpm === null ? 'Not enough yet' : ins.wpm + ' words a minute'));
    ig.appendChild(irow('Day streak', ins.streak + (ins.streak === 1 ? ' day' : ' days')));
    for (const a of ins.topApps) ig.appendChild(irow(a.app, a.count + (a.count === 1 ? ' dictation' : ' dictations')));
    right.appendChild(ig);
  }
  const mic = find('v.mic'), vo = find('s.voice'), ou = find('s.output');
  right.appendChild($('div', 'day', 'Your voice'));
  const vc = $('div', 'stats');
  const kv = (l, v) => { const r = $('div', 'stat kvr'); r.append($('span', null, l), $('b', 'sm', v)); return r; };
  vc.appendChild(kv('Wake words', wakeLine(words)));
  if (mic) vc.appendChild(kv('Microphone', valueOf(mic)));
  if (vo) vc.appendChild(kv('Speaks as', valueOf(vo)));
  if (ou) vc.appendChild(kv('Answers', valueOf(ou)));
  right.appendChild(vc);
  const go2 = $('button', 'btn quiet', 'Change voice settings'); go2.style.marginTop = '12px'; go2.onclick = () => go('voice'); right.appendChild(go2);
  sp.append(left, right); p.appendChild(sp);
}
let vfilter = 'all', forgetAsk = false, editing = null;
function when(iso) { if (!iso) return ''; const d = new Date(iso); return dayLabel(iso) + ', ' + clock(iso); }
function vocabulary(p) {
  const all = (S.extra && S.extra.vocabulary) || [];
  const learned = all.filter(w => w.source === 'learned').length;
  const head = $('div'); head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:12px;margin-top:30px';
  head.appendChild($('h2', null, 'Vocabulary')); head.firstChild.style.margin = '0';
  const seg = $('div', 'seg');
  for (const [v, l] of [['all', 'All'], ['learned', 'Learned'], ['added', 'Added']]) { const b = $('button', null, l); b.setAttribute('aria-pressed', String(vfilter === v)); b.onclick = () => { vfilter = v; render(); }; seg.appendChild(b); }
  head.appendChild(seg); p.appendChild(head);
  p.appendChild($('p', 'lede', 'Words Tessaya should spell your way. It adds the ones you correct or use a lot, and you can add your own.')).style.marginTop = '6px';
  const g = $('div', 'group');
  const f = $('form', 'vocab'); const a = $('input'); a.type = 'text'; a.placeholder = 'Heard as'; a.id = 'in-d-a'; a.setAttribute('aria-label', 'Heard as'); a.value = drafts.get('d-a') || '';
  const b = $('input'); b.type = 'text'; b.placeholder = 'Write it as (optional)'; b.id = 'in-d-b'; b.setAttribute('aria-label', 'Write it as'); b.value = drafts.get('d-b') || '';
  a.oninput = () => drafts.set('d-a', a.value); b.oninput = () => drafts.set('d-b', b.value);
  f.onsubmit = e => { e.preventDefault(); const ph = a.value.trim(); if (!ph) return; drafts.delete('d-a'); drafts.delete('d-b'); set('d.add', JSON.stringify({ phrase: ph, replacement: b.value.trim() || null })); };
  f.append(a, b, $('button', 'btn primary', 'Add')); g.appendChild(f);
  const v = all.filter(w => vfilter === 'all' || w.source === vfilter);
  if (!v.length) { const e = $('div', 'row'); e.appendChild($('div', 'hint', all.length ? 'Nothing in this list.' : 'Words you correct or use a lot show up here. You can add your own too.')); g.appendChild(e); }
  for (const w of v) {
    const r = $('div', 'entry');
    if (editing === w.phrase) {
      const e1 = $('input'); e1.type = 'text'; e1.value = w.phrase; e1.setAttribute('aria-label', 'Heard as'); const e2 = $('input'); e2.type = 'text'; e2.value = w.replacement || ''; e2.placeholder = 'Write it as (optional)'; e2.setAttribute('aria-label', 'Write it as');
      const ok = $('button', 'btn primary', 'Save'); ok.onclick = () => { editing = null; set('d.edit', JSON.stringify({ from: w.phrase, phrase: e1.value, replacement: e2.value })); };
      const no = $('button', 'x'); no.appendChild(icon('x', 14)); no.setAttribute('aria-label', 'Cancel'); no.onclick = () => { editing = null; render(); };
      const w2 = $('div', 'pair'); w2.append(ok, no); r.append(e1, $('div', 'arrow', '\u2192'), e2, w2); g.appendChild(r); continue;
    }
    const meta = $('div', 'hint'); meta.append($('span', 'badge ' + w.source, w.source === 'learned' ? 'Learned' : w.source === 'wispr' ? 'From Wispr' : 'Added'));
    if (w.count) meta.append(document.createTextNode(' used ' + w.count + (w.count === 1 ? ' time' : ' times')));
    if (w.lastSeen) meta.append(document.createTextNode(' \u00b7 last ' + when(w.lastSeen)));
    const l = $('div'); l.appendChild($('div', 'label', w.phrase)); l.appendChild(meta);
    if (w.heard && w.heard.length) {
      const hv = $('div', 'hint', 'Heard as ');
      w.heard.forEach(h => { hv.append(document.createTextNode(h)); const hx = $('button', 'x'); hx.appendChild(icon('x', 12)); hx.setAttribute('aria-label', 'Stop treating ' + h + ' as ' + w.phrase); hx.onclick = () => set('d.unhear', JSON.stringify({ phrase: w.phrase, form: h })); hv.append(hx); });
      l.appendChild(hv);
    }
    const rr = $('div', 'hint', w.replacement === null ? 'same, with its capitals fixed' : w.replacement);
    const ed = $('button', 'btn quiet', 'Edit'); ed.onclick = () => { editing = w.phrase; render(); };
    const x = $('button', 'x'); x.appendChild(icon('x', 14)); x.setAttribute('aria-label', 'Delete ' + w.phrase); x.onclick = () => set('d.remove', w.phrase);
    const w3 = $('div', 'pair'); w3.append(ed, x);
    r.append(l, $('div', 'arrow', '\u2192'), rr, w3); g.appendChild(r);
  }
  p.appendChild(g);
  if (learned) {
    const row = $('div'); row.style.cssText = 'display:flex;align-items:center;gap:10px;margin-top:12px';
    if (!forgetAsk) { const fb = $('button', 'btn', 'Forget all learned'); fb.onclick = () => { forgetAsk = true; render(); }; row.appendChild(fb); }
    else { row.appendChild($('span', 'hint', 'Forget ' + learned + ' learned ' + (learned === 1 ? 'word' : 'words') + '? Words you added stay.')); const yes = $('button', 'btn primary', 'Forget'); yes.onclick = () => { forgetAsk = false; set('d.forget', null); }; const no = $('button', 'btn', 'Keep them'); no.onclick = () => { forgetAsk = false; render(); }; row.append(yes, no); }
    p.appendChild(row);
  }
}
function keys(p, which) {
  const list = ((S.extra && S.extra.hotkeys) || []).filter(k => !which || which.includes(k.tab));
  if (!list.length) return;
  p.appendChild($('h2', null, 'Keyboard shortcuts'));
  const g = $('div', 'group');
  for (const k of list) { const r = $('div', 'kv'); const t = $('div'); t.appendChild($('div', 'label', k.label)); if (k.hint) t.appendChild($('div', 'hint', k.hint)); const w = $('div'); k.keys.split('+').forEach(x => w.appendChild($('kbd', null, x))); r.append(t, w); g.appendChild(r); }
  const note = $('p', 'hint'); note.style.marginTop = '8px'; note.append(document.createTextNode('Change these in '), (() => { const a = $('button', 'reveal', 'Settings, Keyboard'); a.onclick = () => { modal = 'keys'; render(); }; return a; })(), document.createTextNode('.')); p.appendChild(g); p.appendChild(note); return;
  p.appendChild(g);
}
function resetsIn(iso) { const ms = Date.parse(iso) - Date.now(); if (!(ms > 0)) return 'now'; const h = ms / 3600000; return h < 1 ? 'in under an hour' : h < 48 ? 'in ' + Math.round(h) + ' h' : 'in ' + Math.round(h / 24) + ' d'; }
function usage(p) {
  const rows = (S.extra && S.extra.usage) || [];
  // What her brain used, per kind of work and login, and the API spend alerts: T3's web page, inside this window.
  const brain = () => { p.appendChild($('h2', null, 'Her brain')); embed(p, 'usage'); };
  if (!rows.length) { p.appendChild($('div', 'empty', 'No accounts reported yet. They appear here once T3 has loaded your sessions.')); brain(); return; }
  const g = $('div', 'group');
  for (const u of rows) {
    const r = $('div', 'row'); r.style.alignItems = 'flex-start'; const t = $('div', 'text'); t.style.flex = '1';
    t.appendChild($('div', 'label', u.account)); t.appendChild($('div', 'hint', 'on ' + u.box));
    for (const w of u.windows) { const l = $('div', 'bar'); l.style.cssText = 'margin-top:10px'; const top = $('div', 'hint', w.label + ' \\u00b7 ' + (w.usedPercent === null ? 'Not applicable' : (100 - Math.round(w.usedPercent)) + '% left') + (w.resetsAt ? ' \\u00b7 resets ' + resetsIn(w.resetsAt) : '')); const tr = $('div'); tr.style.cssText = 'height:6px;border-radius:3px;background:var(--line);margin-top:5px;overflow:hidden'; const f = $('div'); f.style.cssText = 'height:100%;border-radius:3px;background:' + (w.usedPercent >= 90 ? 'var(--bad)' : w.usedPercent >= 70 ? 'var(--warn)' : 'var(--accent)') + ';width:' + Math.max(2, 100 - Math.round(w.usedPercent || 0)) + '%'; tr.appendChild(f); l.append(top); if (w.usedPercent !== null) l.append(tr); t.appendChild(l); }
    r.appendChild(t); g.appendChild(r);
  }
  p.appendChild(g);
  brain();
}
let hmenu = null, hq = '', hrows = null, hopen = new Set(), hask = null, hedit = null, hnote = '', htimer = null, hbusy = new Set(), hday = null, hrange = 'all', hkind = 'all', hdaylim = {}, hexp = (() => { try { return JSON.parse(localStorage.getItem('tessaya.hdays') || '{}'); } catch (e) { return {}; } })();
function loadHistory() {
  const run = real ? ipc.invoke('baton-history:list', hq) : Promise.resolve((window.__BATON_HISTORY__ || []).filter(t => !hq || ((t.raw || '') + ' ' + (t.cleaned || '') + ' ' + (t.text || '') + ' ' + (t.app || '')).toLowerCase().includes(hq.toLowerCase())));
  run.then(r => { hrows = r; render(); });
}
function hact(t, action) {
  if (action === 'delete') { hask = null; }
  if (!real) { if (action === 'delete') hrows = hrows.filter(x => x.id !== t.id); else if (action === 'flag' || action === 'unflag') hrows = hrows.map(x => x.id === t.id ? Object.assign({}, x, { flagged: action === 'flag' }) : x); else hnote = 'Copied.'; render(); return; }
  const retry = action === 'retry' || action === 'retry_transcript';
  if (retry) { hbusy.add(t.id); hnote = action === 'retry_transcript' ? 'Listening to the recording again. A long one takes a while.' : ''; render(); }
  ipc.invoke('baton-history:act', t.id, action).then(r => {
    hbusy.delete(t.id);
    if (action === 'delete') hrows = hrows.filter(x => x.id !== t.id);
    else if (r && r.playback) { hplay(r.playback); }
    else if (r && r.failed) { hnote = r.failed + '.'; }
    else if (r && r.saved) { hnote = 'Saved the recording as ' + r.saved + '.'; }
    else if (r && r.pasted) { hnote = 'Pasted.'; }
    else if (r && r.id) {
      hrows = hrows.map(x => x.id === t.id ? r : x);
      if (retry) { hopen.add(t.id); hnote = action === 'retry_transcript' ? 'Done. The new words sit beside the old ones under Compare.' : (r.status === 'ok' ? 'Cleaned again. Copy it from the row.' : 'Clean-up failed again. The words as heard are still here.'); }
      else if (action.indexOf('teach:') === 0) { hedit = null; hnote = r.taught && r.taught.length ? 'Learned ' + r.taught.join(', ') + '. Copy and Paste again use your fixed words.' : 'Saved your fixed words. Copy and Paste again use them.'; }
      else if (action === 'undo_ai') { hopen.add(t.id); hnote = 'Back to the words as heard, and on your clipboard. The written words are under Compare.'; }
      else if (action.indexOf('use_version') === 0) { hnote = 'Now using that version.'; }
      else if (action === 'flag') { hnote = 'Flagged. It is kept on this computer for checking the clean-up; nothing was sent.'; }
      else if (action === 'unflag') { hnote = ''; }
      else if (action.indexOf('copy') === 0) { hnote = 'Copied.'; }
    }
    render();
  });
}
let haudio = null, hplaying = null;
function hplay(url) { if (haudio) { haudio.pause(); haudio = null; } haudio = new Audio(url); haudio.onended = () => { haudio = null; hplaying = null; hnote = ''; render(); }; hnote = 'Playing the recording.'; haudio.play().catch(() => { hnote = 'The recording could not be played.'; render(); }); render(); }
const STATUS = { ok: 'Tidied', raw: 'Inserted as heard', failed: 'Clean-up failed' };
const HKIND = { dictation: 'dictation', spoken: 'assistant', assistant: 'assistant', command: 'command' };
const KICON = { dictation: 'mic', assistant: 'spark', command: 'cmd', hid: 'lock' };
const MICON = { undo_ai: 'undo', retry_transcript: 'refresh', retry: 'refresh', paste: 'paste', teach: 'pencil', extract: 'down', delete: 'trash' };
const appName = exe => { const n = String(exe || '').replace(/[.](exe|app)$/i, ''); return n ? n.charAt(0).toUpperCase() + n.slice(1) : ''; };
const wordsIn = s => (String(s || '').match(/\\S+/g) || []).length;
const clipText = (s, n) => s.length > n ? s.slice(0, n - 1) + '…' : s;
const partOfDay = iso => { const h = new Date(iso).getHours(); return h < 12 ? 'Morning' : h < 18 ? 'Afternoon' : 'Evening'; };
/** The words a row stands for: what he said to Tessaya, or his dictation as last fixed, written or heard. */
const rowSays = t => t.kind === 'spoken' ? t.raw : (t.fixed || t.cleaned || t.raw || '');
function ib(name, label, fn, cls) { const b = $('button', 'ib' + (cls ? ' ' + cls : '')); b.setAttribute('aria-label', label); b.title = label; b.appendChild(icon(name, 16)); b.onclick = fn; return b; }
function homeCopy(t) { if (real) ipc.invoke('baton-history:act', t.id, 'copy'); }
/** One row, for Home's Today card (home) or History: the words or a sentence, never a tool's name. */
function entry(t, home) {
  const k = t.hidden ? 'hid' : HKIND[t.kind] || 'assistant';
  const row = $('div', 'ent hrow'); row.setAttribute('data-k', k);
  const when = dayLabel(t.at) === 'Today' || !home ? clock(t.at) : dayLabel(t.at);
  const kd = $('span', 'kind k-' + k); kd.setAttribute('aria-hidden', 'true'); kd.appendChild(icon(KICON[k], 13));
  const tx = $('div', 'txt'), meta = $('div', 'meta'), acts = $('div', 'acts');
  const app = appName(t.app), words = t.kind === 'dictation' || t.kind === 'spoken';
  if (t.hidden) {
    tx.appendChild($('div', 'plain faint', 'Hidden (' + t.hidden + ')'));
    if (app) meta.appendChild($('span', null, app));
    meta.appendChild($('span', null, L('history.nothingKept')));
  } else if (!words) {
    tx.appendChild($('div', 'plain', t.text));
    if (t.detail) meta.appendChild($('span', null, t.detail));
    if (t.detail === 'A session needs an answer') { const o = $('button', 'reveal', L('history.open')); o.onclick = showLive; meta.appendChild(o); }
  } else {
    const said = home ? t.text : rowSays(t);
    tx.appendChild($('div', 'said' + (home ? ' clip' : ''), said));
    const reply = home ? t.detail : t.cleaned;
    if (t.kind === 'spoken') meta.appendChild($('span', null, reply ? 'Tessaya: ' + clipText(reply, 90) : 'Said to Tessaya'));
    else if (app) meta.appendChild($('span', null, app));
  }
  if (home) { if (words && !t.hidden) acts.appendChild(ib('copy', 'Copy', () => homeCopy(t))); }
  else if (words && !t.hidden) {
    if (t.kind === 'dictation') meta.appendChild($('span', null, wordsIn(rowSays(t)) + (wordsIn(rowSays(t)) === 1 ? ' word' : ' words')));
    if (t.kind === 'dictation' && STATUS[t.status]) meta.appendChild($('span', 'badge ' + (t.status === 'ok' ? 'learned' : 'warnb'), STATUS[t.status]));
    if (t.corrected) meta.appendChild($('span', 'badge learned', L('history.fixed')));
    if (t.flagged) meta.appendChild($('span', 'badge warnb', L('history.flagged')));
    if (t.kind === 'spoken' ? t.cleaned : t.raw) { const sh = $('button', 'reveal', (hopen.has(t.id) ? 'Hide ' : 'Show ') + (t.kind === 'spoken' ? 'the reply' : 'as heard')); sh.setAttribute('aria-expanded', String(hopen.has(t.id))); sh.onclick = () => { if (hopen.has(t.id)) hopen.delete(t.id); else hopen.add(t.id); render(); }; meta.appendChild(sh); }
    const pl = (t.menu || []).find(i => i.id === 'play');
    if (pl) acts.appendChild(ib('play', hplaying === t.id ? 'Stop playing' : pl.enabled ? 'Play the recording' : pl.note, () => { if (hplaying === t.id && haudio) { haudio.pause(); haudio = null; hplaying = null; hnote = ''; render(); } else if (!pl.enabled) { hnote = pl.note + '.'; render(); } else { hplaying = t.id; hact(t, 'play'); } }, pl.enabled ? '' : 'off'));
    acts.appendChild(ib('copy', 'Copy', () => hact(t, 'copy')));
    acts.appendChild(ib('flag', t.flagged ? 'Remove the flag' : 'Flag: this went wrong', () => hact(t, t.flagged ? 'unflag' : 'flag'), t.flagged ? 'flagged' : ''));
  }
  const items = home ? [] : (t.menu || []).filter(i => i.id !== 'play' && i.id !== 'copy');
  if (items.length) {
    const mw = $('span', 'hmenuwrap'); const more = ib('more', 'More actions', (e) => { e.stopPropagation(); hmenu = hmenu === t.id ? null : t.id; render(); }); more.setAttribute('aria-haspopup', 'menu'); more.setAttribute('aria-expanded', String(hmenu === t.id));
    mw.appendChild(more);
    if (hmenu === t.id) {
      const m = $('div', 'hmenu'); m.setAttribute('role', 'menu');
      for (const it of items) {
        if (it.id === 'delete' && items.length > 1) m.appendChild($('div', 'hsep'));
        const b = $('button', 'hitem' + (it.enabled ? '' : ' off') + (it.id === 'delete' ? ' bad' : '')); b.setAttribute('role', 'menuitem');
        b.append(icon(MICON[it.id] || 'more', 15), document.createTextNode(hbusy.has(t.id) && it.id === 'retry_transcript' ? 'Retrying' : it.label));
        if (it.note) b.title = it.note;
        b.onclick = (e) => { e.stopPropagation(); hmenu = null;
          if (it.id === 'delete') { hask = t.id; render(); }
          else if (it.id === 'teach') { hedit = t.id; render(); }
          else if (!it.enabled) { hnote = (it.note || 'Not available right now') + '.'; render(); }
          else hact(t, it.id); };
        m.appendChild(b);
      }
      mw.appendChild(m);
    }
    acts.appendChild(mw);
  }
  if (meta.childNodes.length) tx.appendChild(meta);
  if (!home && hedit === t.id) {
    const ed = $('textarea', 'edit'); ed.value = rowSays(t); ed.setAttribute('aria-label', 'Fix the words');
    const tl = $('div', 'teach'); tl.appendChild($('span', null, L('history.teachHint')));
    const bl = $('div', 'teach'); const sv = $('button', 'btn primary', L('history.teach')); sv.onclick = () => hact(t, 'teach:' + ed.value); const cn = $('button', 'btn quiet', L('history.cancel')); cn.onclick = () => { hedit = null; render(); }; bl.append(sv, cn);
    tx.append(ed, tl, bl);
  }
  if (!home && hask === t.id) {
    const c = $('div', 'confirm'); const d = $('button', 'btn primary', L('history.delete')); d.onclick = () => hact(t, 'delete'); const kp = $('button', 'btn quiet', L('history.keep')); kp.onclick = () => { hask = null; render(); };
    c.append($('span', null, t.hidden ? 'Delete this entry for good?' : 'Delete this entry and its recording for good?'), d, kp); tx.appendChild(c);
  }
  if (!home && words && !t.hidden && hopen.has(t.id)) {
    const blk = (l, x) => { const b = $('div', 'raw'); b.append($('div', 'h', l), $('div', 'hpre', x)); return b; };
    if (t.kind === 'spoken') { if (t.cleaned) tx.appendChild(blk('Tessaya replied', t.cleaned)); }
    else tx.appendChild(blk('As heard', t.raw));
    if (t.versions && t.versions.length > 1) {
      const cmp = $('div', 'raw'); cmp.appendChild($('div', 'h', L('history.compare')));
      t.versions.forEach((v, i) => {
        const inUse = v.raw === t.raw && (v.cleaned || null) === (t.cleaned || null);
        const vr = $('div', 'hver'); const lab = $('div', 'hint', 'Version ' + (i + 1) + (i === 0 ? ' (first heard)' : '') + (inUse ? ' - in use' : ''));
        const ra = $('div', 'hacts');
        const vb = (l, a) => { const b = $('button', 'btn quiet', l); b.onclick = () => hact(t, a + ':' + i); return b; };
        ra.appendChild(vb('Copy', 'copy_version')); if (!inUse) ra.appendChild(vb('Use this one', 'use_version'));
        vr.append(lab, $('div', 'hpre', t.kind === 'spoken' ? v.raw : (v.cleaned || v.raw)), ra); cmp.appendChild(vr);
      });
      tx.appendChild(cmp);
    }
    const info = [t.delivery && ('delivered: ' + t.delivery), t.model && ('tidied by ' + t.model), t.cleanup === 'local' && t.status === 'ok' && 'tidied on this computer only', t.error].filter(Boolean).join(' · ');
    if (info) tx.appendChild($('div', 'hint', info));
    if ((t.menu || []).some(i => i.id === 'retry')) { const rc = $('button', 'btn quiet', hbusy.has(t.id) ? 'Cleaning' : 'Retry clean-up'); rc.onclick = () => hact(t, 'retry'); const ra = $('div', 'hacts'); ra.appendChild(rc); tx.appendChild(ra); }
  }
  row.append($('time', null, when), kd, tx, acts);
  return row;
}
function recordings(p) {
  const keep = find('v.keepVoice'); if (!keep) return;
  const n = $('p', 'hint'); n.style.marginTop = '16px'; n.append(document.createTextNode((keep.on ? 'Your voice recordings are kept. ' : 'Your voice is not recorded. ') + 'Change it in '), (() => { const a = $('button', 'reveal', 'Settings, Memory and privacy'); a.onclick = () => go('privacy'); return a; })(), document.createTextNode('.')); p.appendChild(n);
}
const NONE = 'Nothing in this range.', SEE_ALL = 'See all in History';
/** Words dictated today and the time they saved, with the typing speed it is measured against said on the page. */
function daySummary(p) {
  const ins = (S.extra && S.extra.insights) || null; if (!ins || ins.dictationsToday === undefined) return;
  const sm = $('div', 'summary');
  for (const [n, l] of [[ins.wordsToday.toLocaleString(), 'words dictated'], [String(ins.dictationsToday), ins.dictationsToday === 1 ? 'dictation' : 'dictations'], ['≈ ' + ins.minutesSaved + ' min', 'saved']]) { const s = $('span'); s.append($('b', null, n), document.createTextNode(l)); sm.appendChild(s); }
  sm.appendChild($('span', 'how', L('history.savedHow'))); p.appendChild(sm);
}
function seg(label, opts, cur, pick) {
  const g = $('div', 'seg'); g.setAttribute('role', 'group'); g.setAttribute('aria-label', label);
  for (const [id, l] of opts) { const b = $('button', null, l); b.setAttribute('aria-pressed', String(cur === id)); b.onclick = () => pick(id); g.appendChild(b); }
  return g;
}
function historyPage(p) {
  if (hrows === null) loadHistory();
  if (!window.__hm) { window.__hm = 1; document.addEventListener('click', e => { if (hmenu && !e.target.closest('.hmenuwrap')) { hmenu = null; render(); } }); }
  daySummary(p);
  const bar = $('div', 'htoolbar');
  const f = $('div', 'hsearch'); const q = $('input'); q.type = 'search'; q.id = 'in-hq'; q.placeholder = 'Search what you said'; q.setAttribute('aria-label', 'Search history'); q.value = hq;
  q.oninput = () => { hq = q.value; hdaylim = {}; clearTimeout(htimer); htimer = setTimeout(loadHistory, 180); };
  f.appendChild(q);
  bar.append(f, seg('Show', [['all', 'All'], ['dictation', 'Dictation'], ['command', 'Commands'], ['assistant', 'Assistant']], hkind, id => { hkind = id; render(); }),
    seg('When', [['today', 'Today'], ['yesterday', 'Yesterday'], ['week', '7 days'], ['all', 'All']], hrange, id => { hrange = id; render(); }));
  p.appendChild(bar);
  if (hnote) { const n = $('p', 'hint', hnote); n.setAttribute('role', 'status'); n.style.margin = '10px 0 0'; p.appendChild(n); }
  if (hrows === null) { p.appendChild($('div', 'empty', 'Loading.')); recordings(p); return; }
  if (!hrows.length) { p.appendChild($('div', 'empty', hq ? 'Nothing matches.' : 'Nothing yet. Things you say to Tessaya and dictate show up here.')); recordings(p); return; }
  const rangeOk = t => hrange === 'all' || (hrange === 'today' && dayLabel(t.at) === 'Today') || (hrange === 'yesterday' && dayLabel(t.at) === 'Yesterday') || (hrange === 'week' && Date.now() - Date.parse(t.at) < 7 * 864e5);
  const rows = hrows.filter(t => rangeOk(t) && (hkind === 'all' || (t.hidden ? 'dictation' : HKIND[t.kind]) === hkind));
  if (!rows.length) { p.appendChild($('div', 'empty', NONE)); recordings(p); return; }
  const days = [];
  for (const t of rows) { const d = dayLabel(t.at); const last = days[days.length - 1]; if (!last || last.d !== d) days.push({ d, rows: [t] }); else last.rows.push(t); }
  for (const { d, rows: dayRows } of days) {
    const isOpen = d in hexp ? hexp[d] : (d === 'Today' || hq !== '');
    const dh = $('button', 'day dayhead'); dh.setAttribute('aria-expanded', String(isOpen));
    dh.append($('span', null, (isOpen ? '▾ ' : '▸ ') + d), $('span', 'daycount', ' · ' + dayRows.length + (dayRows.length === 1 ? ' entry' : ' entries')));
    if (!isOpen) { const n = dayRows.filter(x => x.kind === 'dictation').reduce((a, x) => a + wordsIn(rowSays(x)), 0); if (n) dh.appendChild($('span', 'daycount', ' · ' + n.toLocaleString() + ' words dictated')); }
    dh.onclick = () => { hexp[d] = !isOpen; try { localStorage.setItem('tessaya.hdays', JSON.stringify(hexp)); } catch (e) {} render(); };
    p.appendChild(dh);
    if (!isOpen) continue;
    const ids = dayRows.map(x => x.id).filter(id => id.indexOf('log:') !== 0), dayName = d;
    const da = $('div', 'hacts'); da.style.margin = '-4px 0 8px';
    const db = (l, fn, cls) => { const b = $('button', 'btn ' + (cls || 'quiet'), l); b.onclick = fn; return b; };
    if (hday === dayName) da.append($('span', 'hint', 'Delete ' + ids.length + ' ' + (ids.length === 1 ? 'entry' : 'entries') + ' and their recordings for good?'), db('Delete', () => { hday = null; const done = () => { hrows = hrows.filter(x => !ids.includes(x.id)); hnote = 'Deleted.'; render(); }; if (real) ipc.invoke('baton-history:delete-many', ids).then(done); else done(); }, 'primary'), db('Keep', () => { hday = null; render(); }));
    else if (ids.length) da.appendChild(db('Delete all from ' + dayName.toLowerCase(), () => { hday = dayName; render(); }));
    p.appendChild(da);
    const g = $('div', 'group entries'); p.appendChild(g);
    const lim = hdaylim[d] || 20; let part = null;
    for (const t of dayRows.slice(0, lim)) {
      const pd = partOfDay(t.at); if (pd !== part) { part = pd; g.appendChild($('div', 'subday', pd)); }
      g.appendChild(entry(t, false));
    }
    if (dayRows.length > lim) { const more = $('button', 'btn quiet', 'Show more (' + (dayRows.length - lim) + ')'); more.style.marginTop = '8px'; more.onclick = () => { hdaylim[d] = lim + 20; render(); }; p.appendChild(more); }
  }
  recordings(p);
}
const tabName = id => ((TABS.find(t => t[0] === id) || CATS.find(t => t[0] === id)) || [id, 'Settings'])[1];
/** Every setting whose words contain every word typed, shown as the real rows, with the page each one lives on. */
function searchPage(p) {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const hits = S.controls.filter(c => c.kind !== 'session' && c.tab !== 'setup' && words.every(w => (c.label + ' ' + (c.hint || '') + ' ' + (c.section || '')).toLowerCase().includes(w)));
  const places = placeHits(words);
  p.appendChild(pageHead('Search', hits.length || places.length ? (hits.length + places.length) + ((hits.length + places.length) === 1 ? ' result' : ' results') + ' for \u201c' + query + '\u201d' : 'Nothing matches \u201c' + query + '\u201d. Try a shorter word.'));
  if (places.length) { p.appendChild($('h2', null, L('search.places'))); p.appendChild(plainGroup(places.map(pl => [pl.label, pl.where, 'Open', () => { query = ''; pl.open(); }]))); }
  const by = new Map(); for (const c of hits) { const t = c.tab || 'advanced'; if (!by.has(t)) by.set(t, []); by.get(t).push(c); }
  for (const [t, list] of by) { const h = $('h2', null, tabName(t)); const go2 = $('button', 'moreBtn', 'Open ' + (CATS.some(c => c[0] === t) ? 'Settings, ' : '') + tabName(t)); go2.onclick = () => { query = ''; go(t); }; h.appendChild(go2); p.appendChild(h); const g = $('div', 'group'); rowsOf(list, g); p.appendChild(g); }
}
// Tips (LEARN_ITEMS, pickTip): what he has opened and seen, kept in this window's storage on this computer. A tip is
// picked once per visit to a page, so a redraw never counts it twice.
const AREA_OF = {}; for (const a of AREAS) for (const pg of a.pages) AREA_OF[pg] = a.id;
let learn = (() => { try { return readLearnProgress(JSON.parse(localStorage.getItem('tessaya.learn') || '{}')); } catch (e) { return readLearnProgress(null); } })();
const saveLearn = () => { try { localStorage.setItem('tessaya.learn', JSON.stringify(learn)); } catch (e) {} };
// Every change goes to this machine's server too, so the phone and the web app count the same tips (applyLearnOp).
function learnDo(change) {
  learn = applyLearnOp(learn, change); saveLearn();
  if (real) ipc.invoke('baton-home:learn', { kind: 'act', op: change.op, args: change }).catch(() => {});
}
learnDo({ op: 'day', day: new Date().toISOString().slice(0, 10) });
// The server's progress is the one every device shares; what this window learned while it was away is sent up.
if (real) ipc.invoke('baton-home:learn', { kind: 'read', op: 'get' }).then(r => {
  if (!r || !r.ok) return; const theirs = readLearnProgress(r.value), mine = learn; learn = theirs;
  for (const pl of mine.used) if (theirs.used.indexOf(pl) < 0) learnDo({ op: 'use', place: pl });
  for (const id of mine.dismissed) if (theirs.dismissed.indexOf(id) < 0) learnDo({ op: 'dismiss', id: id });
  saveLearn(); if (S) { lastSig = ''; render(S); }
}).catch(() => {});
let tipNow = null;
const freshNews = () => WHATS_NEW.filter(w => !learn.whatsNewSeen || w.since > learn.whatsNewSeen);
function learnVisit(t) {
  const tip = pickTip(LEARN_ITEMS, learn, { page: t, area: AREA_OF[t] || null }, Date.now());
  tipNow = tip ? { page: t, tip: tip } : null;
  if (tip) learnDo({ op: 'seen', id: tip.id, at: Date.now() });
  if (learn.used.indexOf(t) < 0) learnDo({ op: 'use', place: t });
}
function tipCard(p) {
  if (tipNow && tipNow.page === cur) {
    const t = tipNow.tip, c = $('div', 'tipcard'); c.setAttribute('role', 'note'); c.append($('b', null, t.title), $('p', null, t.body));
    const row = $('div', 'tiprow'); const a = $('button', 'btn primary', t.action); a.onclick = () => { tipNow = null; modal = null; go(t.place); };
    const n = $('button', 'btn quiet', L('tip.later')); n.onclick = () => { tipNow = null; render(); };
    const off = $('button', 'off', L('tip.off')); off.onclick = () => { learnDo({ op: 'mode', mode: 'off' }); learnDo({ op: 'dismiss', id: t.id }); tipNow = null; render(); };
    row.append(a, n, off); c.appendChild(row); p.appendChild(c); return;
  }
  const news = cur === 'home' ? freshNews() : [];
  if (news.length) { const c = $('div', 'tipcard'); c.setAttribute('role', 'note'); c.appendChild($('b', null, L('tip.newOn', { title: news[0].title }))); const row = $('div', 'tiprow'); const a = $('button', 'btn quiet', L('learn.open')); a.onclick = () => go('learn'); row.appendChild(a); c.appendChild(row); p.appendChild(c); }
}
function learnPage(p) {
  const done = LEARN_ITEMS.filter(i => learn.used.indexOf(i.place) >= 0).length;
  p.appendChild($('p', 'hint', L('learn.progress', { done: done, all: LEARN_ITEMS.length })));
  const news = freshNews();
  if (news.length) { p.appendChild($('h2', null, L('learn.new'))); p.appendChild(plainGroup(news.map(w => [w.title, '', L('learn.show'), () => { modal = null; go(w.place); }]))); }
  for (const a of AREAS) {
    const items = LEARN_ITEMS.filter(i => i.area === a.id); if (!items.length) continue;
    p.appendChild($('h2', null, L('area.' + a.id)));
    p.appendChild(plainGroup(items.map(i => [(learn.used.indexOf(i.place) >= 0 ? '\u2713 ' : '') + i.title, i.body, L('learn.show'), () => { modal = null; go(i.place); }])));
  }
}
// Pages and Settings in both windows that match every word; one in T3's window opens it there.
function placeHits(words) {
  const has = (label, terms) => words.length > 0 && words.every(w => (label + ' ' + terms.join(' ')).toLowerCase().includes(w));
  const mine = PLACES.filter(pl => has(pl.label, pl.terms)).map(pl => ({ label: pl.label, where: pl.group, open: () => { modal = null; go(pl.id); } }));
  const t3 = T3PLACES.filter(pl => has(pl.label, pl.terms)).map(pl => ({ label: pl.label, where: L('search.t3'), open: () => real && ipc.send('baton-home:sessions', pl.path) }));
  return mine.concat(t3);
}
let embedUrl = null;
if (real) ipc.invoke('baton-home:embed').then(u => { embedUrl = u || null; if (S) { lastSig = ''; render(S); } }).catch(() => {});
// Pages built in T3's web app (Hardware, Home Assistant, APIs, accounts, voices), shown inside this window. The
// desktop app routes by hash: a plain path would land on T3's home route and its first-run wizard.
function embed(p, page) {
  if (!embedUrl) { p.appendChild($('div', 'empty', L('embed.missing'))); const b = $('button', 'btn gap-top', L('embed.open')); b.onclick = () => real && ipc.send('baton-home:sessions', '/tessaya/' + page); p.appendChild(b); return; }
  const w = document.createElement('webview'); w.className = 'embed'; w.setAttribute('src', embedUrl + '#/tessaya/' + page); p.appendChild(w);
}
function phonePage(p) { p.appendChild(plainGroup([[L('phone.pair'), L('phone.pair.text'), L('phone.pair'), () => real && ipc.send('baton-home:sessions', '/settings/access')]])); }
// Sessions are T3's thread list (P5): counts here, the list filtered to live sessions there.
const showLive = () => real && ipc.send('baton-home:sessions', 'live');
function liveSessionsPage(p) {
  const st = (S.extra && S.extra.stats) || {}; const g = $('div', 'stats tiles');
  for (const [n, l] of [[st.needYou || 0, 'need you'], [st.sessions || 0, 'live sessions']]) { const r = $('div', 'stat'); r.append($('b', null, String(n)), $('span', null, l)); g.appendChild(r); }
  const b = $('button', 'btn primary gap-top', 'Show live sessions'); b.onclick = showLive; p.append(g, b);
}
function tabPage(p) {
  if (query.trim() && !modal) return searchPage(p);
  if (!modal) tipCard(p);
  if (cur === 'home') return home(p);
  const intro = INTRO[cur]; p.appendChild(pageHead(intro[0], intro[1]));
  if (cur === 'help') { const tb = $('button', 'btn primary', L('wizard.rerun')); tb.onclick = tourStart; const lb = $('button', 'btn', L('learn.open')); lb.style.marginLeft = '8px'; lb.onclick = () => go('learn'); p.append(tb, lb); }
  if (cur === 'learn') return learnPage(p);
  if (cur === 'usage') return usage(p);
  if (cur === 'history') return historyPage(p);
  if (cur === 'sessions') return liveSessionsPage(p);
  if (cur === 'hardware' || cur === 'homeassistant') return embed(p, cur);
  if (cur === 'phone') return phonePage(p);
  const items = tabControls(cur);
  const EMPTY = { approvals: 'Nothing is waiting for your yes.', jobs: 'No jobs yet. Ask Tessaya to take on a long piece of work and it appears here.', memory: 'Nothing remembered yet. Say \u201cremember that\u2026\u201d and it is kept here.', tools: 'No plugins, skills or servers found yet.' };
  if (!items.length && EMPTY[cur]) p.appendChild($('div', 'empty', EMPTY[cur]));
  for (const s of sections(items)) { if (sections(items).length > 1 || s.name !== intro[0]) p.appendChild($('h2', null, s.name)); p.appendChild(group(s.name, s.items)); }
  if (cur === 'dictation') { vocabulary(p); keys(p, ['dictation']); }

}


let capturing = null, capNote = '';
function keyName(e) { const k = e.key; if (['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'Dead', 'Unidentified'].includes(k)) return null; const m = { ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right', Enter: 'Return', Escape: 'Escape' }; return m[k] || (k.length === 1 ? k.toUpperCase() : k); }
function accel(e) { const k = keyName(e); if (!k) return null; const mods = [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta'].filter(Boolean); return mods.concat([k]).join('+'); }
function chips(input) { const w = $('div', 'chips'); if (!input) { w.appendChild($('span', 'hint', 'Off')); return w; } if (input.type === 'key') input.accelerator.split('+').forEach(x => w.appendChild($('kbd', null, x))); else w.appendChild($('span', 'chip plain', ({ middle: 'Middle button', back: 'Back button', forward: 'Forward button', 'left+right': 'Left and right together' })[input.button] || input.button)); return w; }
const BTN = { middle: 'Middle button', back: 'Back button', forward: 'Forward button', 'left+right': 'Left and right together' };
function inputLabel(i) { return i.type === 'key' ? i.accelerator.split('+').join(' + ') : (BTN[i.button] || i.button); }
function bindingsPage(b) {
  const x = S.extra || {}; const rows = x.bindings || [];
  b.appendChild($('h1', null, 'Keyboard and mouse'));
  b.appendChild($('p', 'lede', 'Give each action up to four ways to start it. Voice always works with no button at all.'));
  if (x.bindingsNote) { const n = $('p', 'fix', x.bindingsNote); n.style.color = 'var(--warn)'; b.appendChild(n); }
  const g = $('div', 'group');
  for (const r of rows) {
    const wrap = $('div', 'rowwrap'); const row = $('div', 'row'); row.style.alignItems = 'flex-start';
    const t = $('div', 'text'); t.style.cssText = 'flex:1;min-width:0'; t.append($('div', 'label', r.label), $('div', 'hint', r.hint));
    if (x.mouseButtons && r.inputs.some(i => i.type === 'mouse') && !x.mouseReady) t.appendChild($('div', 'hint', 'Saved. Mouse buttons start working with Tessaya’s input helper.'));
    // A Windows key chord (a mouse's "Show Desktop" button sends Win+D) works here, but Windows loses it while bound.
    for (const i of r.inputs) if (x.mouseButtons && i.type === 'key' && /^Meta\+/.test(i.accelerator)) { const f = $('div', 'fix', inputLabel(i) + ' is a Windows shortcut: while it is bound here, it stops doing its Windows job everywhere (Win+D no longer shows the desktop).'); f.style.color = 'var(--warn)'; t.appendChild(f); }
    for (const c of (r.conflicts || [])) { const i = r.inputs[c.index]; if (!i) continue; const f = $('div', 'fix', inputLabel(i) + ' is also used by ' + c.with.join(' and ') + '. Only one of them will work.'); f.style.color = 'var(--warn)'; t.appendChild(f); }
    const side = $('div'); side.style.cssText = 'display:flex;flex-wrap:wrap;justify-content:flex-end;align-items:center;gap:8px;max-width:60%';
    const on = capturing === r.action;
    if (!r.inputs.length) side.appendChild($('span', 'hint', 'Off'));
    r.inputs.forEach((i, n) => {
      const c = $('span', 'chipx'); c.appendChild(chips(i));
      const rm = $('button', 'x'); rm.appendChild(icon('x', 12)); rm.setAttribute('aria-label', 'Remove ' + inputLabel(i)); rm.onclick = () => set('b.remove:' + r.action, n); c.appendChild(rm); side.appendChild(c);
    });
    if (r.inputs.length < 4) { const ch = $('button', 'btn quiet', on ? 'Cancel' : (r.inputs.length ? 'Add another' : 'Add')); ch.onclick = () => { capturing = on ? null : r.action; capNote = ''; render(); }; side.appendChild(ch); }
    else side.appendChild($('span', 'hint', 'Four is the most'));
    if (!r.isDefault && !on) { const rs = $('button', 'btn quiet', 'Reset'); rs.onclick = () => set('b.reset:' + r.action, null); side.appendChild(rs); }
    row.append(t, side); wrap.appendChild(row);
    if (on) { const cap = $('div', 'inline capture'); cap.appendChild($('div', 'label', x.mouseButtons ? 'Press a key or a chord of up to three keys, or click a mouse button. Escape cancels.' : 'Press a key or a chord of up to three keys. Escape cancels. Mouse buttons can be bound on Windows only.')); if (capNote) cap.appendChild($('div', 'hint', capNote)); wrap.appendChild(cap); }
    g.appendChild(wrap);
  }
  const f = $('div', 'row'); const ft = $('div', 'text'); ft.append($('div', 'label', 'Cancel a recording, a card or a drive'), $('div', 'hint', 'Always Escape.')); f.append(ft, chips({ type: 'key', accelerator: 'Escape' })); g.appendChild(f);
  b.appendChild(g);
  const reset = $('button', 'btn quiet', 'Reset all to defaults'); reset.style.marginTop = '14px'; reset.onclick = () => set('b.resetAll:all', null); b.appendChild(reset);
  const n = $('p', 'hint', 'A button you do not set here passes through to your apps unchanged. Keys that another app already uses may not register.'); n.style.marginTop = '12px'; b.appendChild(n);
}
addEventListener('keydown', e => {
  const t = e.target, typing = t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  if (e.key === '/' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) { const q = document.getElementById('q'); if (q) { e.preventDefault(); q.focus(); } return; }
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && t && t.closest && t.closest('#navlist')) {
    const items = [...document.querySelectorAll('#navlist button')], i = items.indexOf(t); if (i < 0) return;
    e.preventDefault(); const n = items[Math.min(items.length - 1, Math.max(0, i + (e.key === 'ArrowDown' ? 1 : -1)))]; if (n) n.focus();
  }
});
addEventListener('keydown', e => {
  if (!capturing) return;
  e.preventDefault(); e.stopPropagation();
  if (e.key === 'Escape' && !e.ctrlKey && !e.altKey && !e.shiftKey && !e.metaKey) { capturing = null; capNote = ''; render(); return; }
  const a = accel(e); if (!a) return;
  const bare = !/\\+/.test(a);
  if (bare && !/^(F\\d+|Pause|ScrollLock)$/.test(a)) { capNote = 'Add Ctrl, Alt or Shift so it does not get in the way of typing.'; render(); return; }
  const id = capturing; capturing = null; capNote = ''; set('b.add:' + id, JSON.stringify({ type: 'key', accelerator: a }));
}, true);
addEventListener('mousedown', e => {
  if (!capturing || !(S.extra || {}).mouseButtons) return;
  let button = null;
  if (e.buttons === 3) button = 'left+right'; else if (e.button === 1) button = 'middle'; else if (e.button === 3) button = 'back'; else if (e.button === 4) button = 'forward';
  if (!button) return;
  e.preventDefault(); const id = capturing; capturing = null; capNote = ''; set('b.add:' + id, JSON.stringify({ type: 'mouse', button }));
}, true);
function catSections(b, id) {
  const items = S.controls.filter(c => c.tab === id);
  for (const s of sections(items)) { b.appendChild($('h2', null, s.name)); b.appendChild(group(s.name, s.items)); }
  return items;
}
function plainGroup(rows) { const g = $('div', 'group'); for (const [l, h, btn, id] of rows) { const r = $('div', btn ? 'row' : 'kv'); const t = $('div', 'text'); t.append($('div', 'label', l), $('div', 'hint', h)); r.appendChild(t); if (btn) { const bt = $('button', 'btn', btn); bt.onclick = typeof id === 'function' ? id : () => set(id, null); r.appendChild(bt); } g.appendChild(r); } return g; }
function modalPage(b) {
  const x = S.extra || {};
  if (modal === 'setup') return setupPage(b);
  if (modal === 'keys') return bindingsPage(b);
  if (modal === 'about') { const am = $('div', 'aboutmark'); am.id = 'aboutmark'; markButton(am, 'about'); am.innerHTML = markHtml('about'); b.appendChild(am); if (!aboutSeen) { aboutSeen = true; setTimeout(() => startSting('about'), 50); } b.appendChild($('h1', null, 'About')); const a = x.about || {}; const g = $('div', 'group'); for (const [l, v] of [['Version', a.version], ['Installed from', a.source], ['Licence', a.licence], ['Third-party notices', a.notices]]) { if (!v) continue; const r = $('div', 'kv'); r.append($('div', 'label', l), $('div', 'hint', v)); g.appendChild(r); } b.appendChild(g); const rr = $('button', 'btn', L('wizard.rerun')); rr.style.marginTop = '14px'; rr.onclick = tourStart; b.appendChild(rr); ; return; }
  b.appendChild(pageHead(L('cat.' + modal), L('cat.' + modal + '.text')));
  const items = catSections(b, modal);
  if (modal === 'accounts' || modal === 'apis' || modal === 'brain') embed(b, modal);
  if (modal === 'personas') { b.appendChild($('h2', null, L('embed.voices'))); embed(b, 'voices'); }
  if (modal === 'general') {
    const ab = x.about || {}; const facts = [['Installed version', ab.version], ['Updates come from', ab.source]].filter(f => f[1]);
    if (facts.length) { b.appendChild($('h2', null, 'Version')); b.appendChild(plainGroup(facts.map(([l, v]) => [l, v]))); }
    b.appendChild($('h2', null, 'Tour'));
    b.appendChild(plainGroup([[L('wizard.rerun'), 'A minute: your microphone, dictation key, one sentence, and who does the work.', 'Start', tourStart]]));
    b.appendChild($('h2', null, L('tip.title'))); b.appendChild($('p', 'hint', L('tip.text')));
    const tg = seg(L('tip.title'), [['daily', L('tip.daily')], ['all', L('tip.all')], ['off', L('tip.none')]], learn.mode, m => { learnDo({ op: 'mode', mode: m }); render(); }); tg.style.marginBottom = '12px'; b.appendChild(tg);
    b.appendChild(plainGroup([[L('tip.reset'), L('tip.reset.text'), L('tip.reset'), () => { learnDo({ op: 'reset' }); tipNow = null; render(); }]]));
    b.appendChild($('h2', null, 'Quit'));
    b.appendChild(plainGroup([['Quit Tessaya', 'Closing the window keeps Tessaya in the tray. Quit ends it.', 'Quit', 'q.quit']]));
  }
  if (modal === 'voice') keys(b, ['voice']);
  if (modal === 'assistant') {
    b.appendChild($('h2', null, 'What Tessaya can do with your screen'));
    b.appendChild(plainGroup([['Look', 'Ask what is on your screen. Tessaya takes one screenshot of each display and answers.'], ['Teach', 'Ask how to do something. Tessaya shows each step on your screen, one at a time.'], ['Drive', 'Ask Tessaya to do it. It moves the pointer, you can take over, and Escape stops it.']]));
    b.appendChild($('h2', null, 'Right now'));
    b.appendChild(plainGroup([['Ask Tessaya', 'Type a question about your screen or a job to do.', 'Ask', 'q.ask'], ['Clear the screen', 'Remove the pointer and any card Tessaya left up.', 'Clear', 'q.clear'], ['Stop', 'End a lesson or a drive, and quiet Tessaya’s voice.', 'Stop', 'q.stop']]));
    keys(b, ['screen']);
    b.appendChild($('p', 'hint', 'Tessaya uses your own subscription through the claude and codex programs. It never uses an API key.')).style.marginTop = '12px';
  }
  if (modal === 'advanced') {
    if (!items.some(c => c.kind === 'check')) { const e = $('div', 'empty', 'No checks have run yet. Press Run checks.'); e.style.marginTop = '16px'; b.appendChild(e); }
    if ((x.lifecycle || []).length) { b.appendChild($('h2', null, 'Why Tessaya last went down')); const g = $('div', 'group'); for (const l of x.lifecycle) { const r = $('div', 'kv'); r.append($('div', null, l.text), $('time', 'hint', clock(l.at))); g.appendChild(r); } b.appendChild(g); }
    if ((x.paths || []).length) { b.appendChild($('h2', null, 'Files and folders')); b.appendChild(plainGroup(x.paths.map(p => [p.label, p.path, 'Open', 'q.open:' + p.id]))); }
  }
}
let setupStep = 0, setupAuto = false, meterTimer = null;
function stopMeter() { if (meterTimer) { clearInterval(meterTimer); meterTimer = null; } }
function setupFinish() { stopMeter(); modal = null; setupStep = 0; set('q.setupDone', true); render(); }
function setupGo(n) { setupStep = n; set('q.setupStep', String(n)); render(); }
function tourStart() { const sp = (S.extra || {}).setup; if (!sp) return; setupStep = sp.step || 0; modal = 'setup'; if (sp.mode === 'offer') set('q.setupOffered', true); render(); }
function setupPage(b) {
  const sp = (S.extra || {}).setup; if (!sp) return;
  const step = sp.steps[setupStep]; if (!step) return;
  b.appendChild($('p', 'hint', L('wizard.step', { n: setupStep + 1, total: sp.steps.length })));
  b.appendChild($('h1', null, step.title));
  const lead = $('p', 'hint', step.text); lead.style.marginBottom = '14px'; b.appendChild(lead);
  const list = [];
  for (const id of step.controls) for (const c of S.controls) if (c.id === id || ((id.slice(-1) === ':' || id.slice(-1) === '.') && c.id.indexOf(id) === 0)) list.push(c);
  if (list.length) { const g = $('div', 'group'); for (const c of list) g.appendChild(row(c)); b.appendChild(g); }
  if (step.meter) {
    const m = $('div', 'meter'); m.setAttribute('role', 'meter'); m.setAttribute('aria-label', 'Microphone level'); m.setAttribute('aria-valuemin', '0'); m.setAttribute('aria-valuemax', '100');
    const bar = $('i'); m.appendChild(bar); b.appendChild(m);
    const tick = () => { if (!real) return; ipc.invoke('baton-home:level').then(v => { const w = Math.round(Math.min(1, Math.max(0, Math.sqrt(v) * 1.6)) * 100); bar.style.width = w + '%'; m.setAttribute('aria-valuenow', String(w)); }).catch(() => {}); };
    stopMeter(); meterTimer = setInterval(tick, 120); tick();
    b.appendChild($('p', 'hint', 'If listening is off the bar stays flat. Turn it on above.'));
  } else stopMeter();
  if (step.facts) { const g = $('div', 'group'); g.style.marginTop = '12px'; for (const f of step.facts) { const r = $('div', 'kv'); const t = $('div'); t.append($('div', 'label', f.label), $('div', 'hint', f.hint)); r.appendChild(t); g.appendChild(r); } b.appendChild(g); }
  if (step.tryBox) {
    const t = $('textarea', 'trybox'); t.setAttribute('aria-label', 'Try dictation here'); t.placeholder = 'Hold ' + (sp.hold || 'your key') + ' and speak'; b.appendChild(t);
  }
  const foot = $('div', 'wizfoot');
  const back = $('button', 'btn quiet', L('wizard.back')); back.disabled = setupStep === 0; back.onclick = () => setupGo(setupStep - 1);
  const last = setupStep === sp.steps.length - 1;
  const skip = $('button', 'btn quiet', last ? L('wizard.close') : L('wizard.skip')); skip.onclick = setupFinish;
  const next = $('button', 'btn primary', last ? L('wizard.finish') : L('wizard.next')); next.onclick = () => { if (last) setupFinish(); else setupGo(setupStep + 1); };
  const mid = $('div', 'wizmid'); mid.append(back, skip); foot.append(mid, next); b.appendChild(foot);
}
/** Swaps a region's contents only when what it would show has changed, so a refresh that changes nothing touches nothing. */
function setRegion(el, build, keepId) {
  const next = document.createElement('div'); build(next);
  if (next.innerHTML === el.innerHTML) return false;
  // The first child stays in the page when unchanged: a node taken out of the document loses its running animation.
  const old = keepId && document.getElementById(keepId), fresh = keepId && next.firstChild;
  if (old && fresh && old.parentNode === el && el.firstChild === old && old.innerHTML === fresh.innerHTML) {
    while (old.nextSibling) old.nextSibling.remove();
    fresh.remove(); el.append(...next.childNodes); return true;
  }
  el.replaceChildren(...next.childNodes); return true;
}
let shownModal = null, lastSig = '', modalOpener = null;
function ensureVeil() {
  let v = document.getElementById('veil'); if (v) return v;
  v = $('div'); v.id = 'veil'; v.onclick = e => { if (e.target === v) closeModal(); };
  const m = $('div'); m.id = 'modal'; m.setAttribute('role', 'dialog'); m.setAttribute('aria-modal', 'true'); m.setAttribute('aria-label', modal === 'setup' ? 'Setup' : 'Settings'); m.tabIndex = -1;
  const nav = $('div'); nav.id = 'mnav'; const body = $('div'); body.id = 'mbody';
  m.append(nav, body); v.appendChild(m); document.body.appendChild(v); return v;
}
/** The dialog is built once and kept: a tab switch changes the nav mark and the content, nothing else. */
function syncModal() {
  const v = ensureVeil();
  document.getElementById('modal').setAttribute('aria-label', modal === 'setup' ? 'Setup' : 'Settings');
  if (!modal) {
    shownModal = null;
    if (v.classList.contains('on') && !v.classList.contains('out') && modalOpener && modalOpener.focus) { try { modalOpener.focus(); } catch (_) {} modalOpener = null; }
    if (v.classList.contains('on') && !v.classList.contains('out')) { v.classList.add('out'); setTimeout(() => { if (!modal) v.className = ''; }, 170); }
    return;
  }
  if (shownModal === null && !v.classList.contains('on')) { modalOpener = document.activeElement; setTimeout(() => { const mm = document.getElementById('modal'); const first = mm && (mm.querySelector('#mnav button[aria-current]') || mm.querySelector('#mnav button') || mm); if (first) first.focus(); }, 0); }
  v.classList.remove('out'); v.classList.add('on');
  setRegion(document.getElementById('mnav'), nav => {
    if (modal === 'setup') { nav.appendChild($('h4', null, 'Setup')); const sp = (S.extra || {}).setup; for (const [i, st] of ((sp && sp.steps) || []).entries()) { const b = $('button', 'nav', (i + 1) + '. ' + st.title); if (i === setupStep) b.setAttribute('aria-current', 'step'); b.onclick = () => setupGo(i); nav.appendChild(b); } return; }
    for (const g of SGROUPS) {
      nav.appendChild($('h4', null, g));
      // A place that is a page (Dictation, Hardware) closes Settings and opens the page: one home for each setting.
      for (const pl of PLACES.filter(x => x.group === g)) { const isCat = CATS.some(c => c[0] === pl.id); const b = $('button', 'nav', isCat ? L('cat.' + pl.id) : pl.label); if (modal === pl.id) b.setAttribute('aria-current', 'page'); b.onclick = () => { if (isCat) { modal = pl.id; render(); } else { modal = null; go(pl.id); } }; nav.appendChild(b); }
    }
    nav.appendChild($('div', 'ver', 'Tessaya ' + (((S.extra || {}).about || {}).version || '')));
  });
  const mbody = document.getElementById('mbody');
  setRegion(mbody, body => { const cl = $('button', 'ibtn'); cl.id = 'mclose'; cl.setAttribute('aria-label', 'Close'); cl.appendChild(icon('x')); cl.onclick = closeModal; body.appendChild(cl); modalPage(body); });
  if (shownModal !== modal) { mbody.scrollTop = 0; shownModal = modal; }
}
function closeModal() { stopMeter(); modal = null; aboutSeen = false; render(); }
function go(t) { t = MOVED[t] || t; if (cur === 'learn' && t !== 'learn' && WHATS_NEW.length && learn.whatsNewSeen !== WHATS_NEW[WHATS_NEW.length - 1].since) learnDo({ op: 'whatsNew', since: WHATS_NEW[WHATS_NEW.length - 1].since }); if (t !== cur && t !== modal) learnVisit(t); if (CATS.some(c => c[0] === t)) { modal = t; render(); return; } if (t !== cur) { try { enter(); } catch (e) {} } cur = t; render(); if (real) ipc.send('baton-home:tab', t); document.getElementById('panel').scrollTop = 0; }

/** Ctrl+K: pages, settings, commands and sessions in one list, all by keyboard. */
function paletteRank(items, q) {
  const words = q.toLowerCase().split(' ').filter(Boolean);
  if (!words.length) return items.slice(0, 12);
  const scored = [];
  for (const it of items) {
    const hay = (it.label + ' ' + (it.hint || '')).toLowerCase(); const lab = it.label.toLowerCase();
    if (!words.every(w => hay.indexOf(w) >= 0)) continue;
    scored.push([words.reduce((s, w) => s + (lab.indexOf(w) === 0 ? 3 : lab.indexOf(w) >= 0 ? 2 : 1), 0) + (it.kind === 'Command' ? 0.5 : 0), it]);
  }
  return scored.sort((a, b) => b[0] - a[0]).slice(0, 12).map(x => x[1]);
}
function paletteItems() {
  const items = [];
  for (const [id, name] of TABS) items.push({ kind: 'Page', label: name, hint: 'Open the ' + name + ' page', run: () => { modal = null; go(id); } });
  for (const [id, name] of CATS) items.push({ kind: 'Settings', label: name, hint: 'Open Settings, ' + name, run: () => go(id) });
  const on = id => { const c = find(id); return !!(c && c.on); };
  const cmd = (label, hint, run) => items.push({ kind: 'Command', label, hint, run });
  cmd('Start listening', 'Wake Tessaya without the wake word', () => set('q.wake', null));
  cmd('Stop what Tessaya is saying or doing', '', () => set('q.stop', null));
  cmd(on('v.muted') ? 'Unmute the microphone' : 'Mute the microphone', '', () => set('v.muted', !on('v.muted')));
  cmd('Ask Tessaya', 'Type a question or a request', () => set('q.ask', null));
  cmd('Clear the screen', 'Remove the pointer and cards', () => set('q.clear', null));
  cmd('Open T3 sessions', '', () => real && ipc.send('baton-home:sessions'));
  for (const pl of T3PLACES) items.push({ kind: 'T3', label: pl.label, hint: L('search.t3') + ' ' + pl.terms.join(' '), run: () => real && ipc.send('baton-home:sessions', pl.path) });
  cmd(on('v.dnd') ? 'Turn Do not disturb off' : 'Turn Do not disturb on', '', () => set('v.dnd', !on('v.dnd')));
  cmd('Snooze for an hour', 'No offers or reminders for an hour', () => set('v.snooze', null));
  cmd('Run the standing jobs now', 'The ones you have switched on', () => set('trust.standing-run', null));
  cmd(L('wizard.rerun'), 'A minute: microphone, dictation key, one sentence, who does the work', tourStart);
  for (const c of S.controls) {
    if (c.id.indexOf('trust.standing:') === 0 || c.id.indexOf('trust.rule:') === 0) cmd((c.on ? 'Turn off standing job: ' : 'Turn on standing job: ') + c.label, 'Unattended work, counted and logged', () => set(c.id, !c.on));
    else if (c.kind === 'session' && c.canOpen) items.push({ kind: 'Session', label: 'Open session ' + c.label, hint: c.project + ' ' + c.box, run: () => set(c.id, null) });
    else if (c.kind === 'toggle' || c.kind === 'choice' || c.kind === 'action') items.push({ kind: 'Setting', label: c.label, hint: c.hint || '', run: () => { modal = null; go(c.tab || 'advanced'); } });
  }
  return items;
}
let palOpen = false, palSel = 0, palItems = [];
function palClose() { palOpen = false; const p = document.getElementById('pal'); if (p) p.remove(); if (palReturn && palReturn.focus) { try { palReturn.focus(); } catch (_) {} } }
let palReturn = null;
function palDraw(list, input) {
  list.replaceChildren();
  palItems.forEach((it, i) => { const o = $('div', 'palopt'); o.id = 'palopt' + i; o.setAttribute('role', 'option'); o.setAttribute('aria-selected', String(i === palSel)); o.append($('span', 'palkind', it.kind), $('span', 'pallabel', it.label)); if (it.hint) o.appendChild($('span', 'palhint', it.hint)); o.onclick = () => { palClose(); it.run(); }; list.appendChild(o); });
  if (!palItems.length) list.appendChild($('div', 'palempty', 'Nothing matches.'));
  input.setAttribute('aria-activedescendant', palItems.length ? 'palopt' + palSel : '');
}
function palOpenNow() {
  if (palOpen || !S) return; palOpen = true; palReturn = document.activeElement; palSel = 0;
  const veil = $('div', 'palveil'); veil.id = 'pal'; veil.onclick = e => { if (e.target === veil) palClose(); };
  const box = $('div', 'palbox'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-label', 'Command palette');
  const input = $('input', 'palin'); input.type = 'text'; input.setAttribute('role', 'combobox'); input.setAttribute('aria-expanded', 'true'); input.setAttribute('aria-controls', 'pallist'); input.setAttribute('aria-label', 'Search pages, settings and commands'); input.placeholder = 'Search pages, settings and commands';
  const list = $('div', 'pallist'); list.id = 'pallist'; list.setAttribute('role', 'listbox');
  const all = paletteItems(); palItems = paletteRank(all, ''); palDraw(list, input);
  input.oninput = () => { palSel = 0; palItems = paletteRank(all, input.value); palDraw(list, input); };
  input.onkeydown = e => {
    if (e.key === 'ArrowDown') { e.preventDefault(); palSel = Math.min(palItems.length - 1, palSel + 1); palDraw(list, input); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); palSel = Math.max(0, palSel - 1); palDraw(list, input); }
    else if (e.key === 'Enter') { e.preventDefault(); const it = palItems[palSel]; if (it) { palClose(); it.run(); } }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); palClose(); }
    else if (e.key === 'Tab') e.preventDefault();
  };
  box.append(input, list); veil.appendChild(box); document.body.appendChild(veil); input.focus();
}
addEventListener('click', () => { if (bellOpen) { bellOpen = false; render(); } });
addEventListener('keydown', e => { if (e.key === 'Escape' && bellOpen) { bellOpen = false; render(); } });
addEventListener('keydown', e => { if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); if (palOpen) palClose(); else palOpenNow(); } }, true);
let lastState = null, enterTimer = 0, indReady = false, entering = false;
/** A page change plays the entrance once: transform and opacity only, and only while the window is live (see the style). */
function enter() {
  const page = document.getElementById('page'); if (!page || !page.classList) return;
  page.classList.remove('enter'); void page.offsetWidth; page.classList.add('enter'); entering = true;
  clearTimeout(enterTimer); enterTimer = setTimeout(() => { entering = false; page.classList.remove('enter'); }, 700);
}
/** The sidebar's active mark is one element that slides to the current page (a transform, so the move costs no layout). */
function syncInd(still) {
  const app = document.getElementById('app'); if (!app) return;
  let ind = document.getElementById('navind');
  if (!ind) { ind = $('div'); ind.id = 'navind'; ind.setAttribute('aria-hidden', 'true'); app.appendChild(ind); }
  const a = document.querySelector('#navlist .nav[aria-current]');
  if (!a) { ind.style.opacity = '0'; return; }
  const ar = app.getBoundingClientRect(), r = a.getBoundingClientRect(); const nr = document.getElementById('navlist').getBoundingClientRect();
  const y = r.top - ar.top + (r.height - 18) / 2;
  ind.setAttribute('data-g', GROUP_OF[cur] || 'now');
  ind.style.transform = 'translateY(' + Math.round(y) + 'px)'; ind.style.opacity = r.bottom > nr.top && r.top < nr.bottom ? '1' : '0';
  if (!indReady && !still) { indReady = true; requestAnimationFrame(() => ind.classList.add('go')); }
}
function syncChrome() {
  try { syncInd(); const nl = document.getElementById('navlist'); if (nl && !nl.onscroll) nl.onscroll = () => syncInd(true); } catch (e) {}
  if (!booted) { booted = true; const h = document.documentElement; h.classList.add('boot'); setTimeout(() => h.classList.remove('boot'), 1400); }
}
let booted = false;
// Collapsed, the sidebar is a rail of icons, remembered; its labels float outside #navlist, whose scroll would clip them.
function toggleRail() { collapsed = !collapsed; try { localStorage.setItem('tessaya.rail', collapsed ? '1' : '0'); } catch (e) {} railTip({}); render(); }
function railTip(e) {
  const t = e.target && e.target.closest && e.target.closest('#side [data-tip]'); let tip = document.getElementById('railtip');
  if (!tip) { tip = $('div'); tip.id = 'railtip'; tip.setAttribute('aria-hidden', 'true'); document.body.appendChild(tip); }
  tip.hidden = !collapsed || !t || /out/.test(e.type); if (tip.hidden) return;
  const r = t.getBoundingClientRect(); tip.textContent = t.getAttribute('data-tip'); tip.style.top = (r.top + r.height / 2) + 'px'; tip.style.left = (r.right + 10) + 'px';
}
for (const ev of ['pointerover', 'pointerout', 'focusin', 'focusout']) document.addEventListener(ev, railTip);
// The guided voice read (Voice ID): a card over everything while it runs. Its buttons and meter stay put across
// updates, so keyboard focus is never lost as the words light up; only the sentences are rebuilt.
let enrolEl = null, enrolOpener = null, enrolMeter = null, enrolSaid = '';
function enrolClose() { set('vid.card:close', null); }
function syncEnrol() {
  const c = S.controls.find(x => x.kind === 'enrol');
  if (!c) {
    if (!enrolEl) return;
    enrolEl.remove(); enrolEl = null; enrolSaid = '';
    if (enrolMeter) { clearInterval(enrolMeter); enrolMeter = null; }
    if (enrolOpener && enrolOpener.focus) { try { enrolOpener.focus(); } catch (_) {} }
    enrolOpener = null; return;
  }
  const k = c.card, over = k.phase === 'done' || k.phase === 'failed';
  if (!enrolEl) {
    enrolOpener = document.activeElement;
    enrolEl = $('div'); enrolEl.id = 'enrolveil';
    const box = $('div', 'enrol'); box.id = 'enrolbox'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true'); box.setAttribute('aria-labelledby', 'enrolh'); box.tabIndex = -1;
    const body = $('div'); body.id = 'enrolbody';
    const say = $('p', 'sr'); say.id = 'enrolsay'; say.setAttribute('aria-live', 'polite');
    const foot = $('div', 'efoot');
    const mic = $('span', 'emic'); const lab = $('span'); lab.id = 'enrolmic';
    const m = $('span', 'meter'); m.id = 'enrolmeter'; m.setAttribute('role', 'meter'); m.setAttribute('aria-label', 'Microphone level'); m.setAttribute('aria-valuemin', '0'); m.setAttribute('aria-valuemax', '100'); m.appendChild($('i'));
    mic.append(lab, m);
    const redo = $('button', 'btn', 'Redo'); redo.id = 'enrolredo'; redo.onclick = () => set('vid.card:redo', null);
    const close = $('button', 'btn'); close.id = 'enrolclose'; close.onclick = enrolClose;
    foot.append(mic, redo, close); box.append(body, say, foot); enrolEl.appendChild(box); document.body.appendChild(enrolEl);
    setTimeout(() => box.focus(), 0);
  }
  setRegion(document.getElementById('enrolbody'), b => {
    const h = $('h2', null, over && k.summary ? k.summary.headline : k.title); h.id = 'enrolh'; b.appendChild(h);
    if (over && k.summary) {
      const dl = $('dl', 'esum');
      for (const r of k.summary.rows) {
        const dd = $('dd');
        if (r.label === 'Quality') { const q = $('span', 'eq'); q.setAttribute('aria-hidden', 'true'); for (let i = 1; i <= 3; i++) q.appendChild($('i', i <= k.summary.quality ? 'on' : null)); dd.appendChild(q); }
        dd.appendChild(document.createTextNode(r.value)); dl.append($('dt', null, r.label), dd);
      }
      b.appendChild(dl);
      if (k.summary.tip) b.appendChild($('p', 'etip', k.summary.tip));
      return;
    }
    b.appendChild($('p', 'hint', k.phase === 'saving' ? 'Making the voice profile from your read…' : k.lead));
    const n = k.lines.filter(l => l.state === 'done').length, again = k.lines.filter(l => l.state === 'again').length;
    const pr = $('div', 'eprog'); const bar = $('span', 'ebar'); const fill = $('i'); fill.style.width = Math.round(100 * n / k.lines.length) + '%'; bar.appendChild(fill);
    pr.append($('span', null, n + ' of ' + k.lines.length + ' read'), bar, $('span', null, again ? again + ' to read again' : 'about 30 s')); b.appendChild(pr);
    const ol = $('ol', 'elines');
    k.lines.forEach((l, i) => {
      const li = $('li', l.state); const mk = $('span', 'em', l.state === 'done' ? '✓' : l.state === 'again' ? '↺' : l.state === 'now' ? '▸' : String(i + 1)); mk.setAttribute('aria-hidden', 'true');
      const t = $('span');
      if (l.state === 'now' || l.state === 'again') {
        const ws = l.text.split(' ');
        ws.forEach((w, j) => { t.appendChild($('span', j < l.heard ? 'w h' : j === l.heard ? 'w next' : 'w', w)); if (j < ws.length - 1) t.appendChild(document.createTextNode(' ')); });
        if (l.why) t.appendChild($('span', 'why', l.why));
      } else t.textContent = l.text;
      li.append(mk, t); ol.appendChild(li);
    });
    b.appendChild(ol);
  });
  document.getElementById('enrolmic').textContent = over ? '' : 'Listening through ' + k.mic;
  document.getElementById('enrolmeter').hidden = k.phase !== 'reading';
  document.getElementById('enrolredo').hidden = !over;
  const cl = document.getElementById('enrolclose'); cl.textContent = over ? 'Done' : 'Cancel'; cl.className = over ? 'btn primary' : 'btn';
  if (over && document.activeElement !== cl && !document.getElementById('enrolbox').contains(document.activeElement)) cl.focus();
  const cur = k.lines.find(l => l.state === 'again' || l.state === 'now');
  const said = over && k.summary ? k.summary.headline : cur ? (cur.why ? cur.why + ' ' : 'Read: ') + cur.text : '';
  if (said !== enrolSaid) { enrolSaid = said; document.getElementById('enrolsay').textContent = said; }
  if (k.phase === 'reading' && !enrolMeter && real) enrolMeter = setInterval(() => ipc.invoke('baton-home:level').then(v => { const m = document.getElementById('enrolmeter'); if (!m) return; const w = Math.round(Math.min(1, Math.max(0, Math.sqrt(v) * 1.6)) * 100); m.firstChild.style.width = w + '%'; m.setAttribute('aria-valuenow', String(w)); }).catch(() => {}), 120);
  if (k.phase !== 'reading' && enrolMeter) { clearInterval(enrolMeter); enrolMeter = null; }
}
function render(state) {
  if (state) { const sig = JSON.stringify(state); if (sig === lastSig) return; lastSig = sig; S = state; }
  if (!setupAuto && S && S.extra && S.extra.setup && S.extra.setup.mode === 'open') { setupAuto = true; setupStep = S.extra.setup.step || 0; modal = 'setup'; }
  const keep = document.activeElement && document.activeElement.id, pos = document.activeElement && document.activeElement.selectionStart;
  const app = document.getElementById('app'); app.className = collapsed ? 'collapsed' : ''; app.setAttribute('data-g', GROUP_OF[cur] || 'now');
  const need = (S.extra && S.extra.stats && S.extra.stats.needYou) || 0; const up = find('u.act');
  setRegion(document.getElementById('side'), side => {
  const brand = $('div', 'brand'); brand.id = 'brand'; const mk = $('span'); mk.id = 'mark'; markButton(mk, 'side'); mk.innerHTML = markHtml('side'); const bt = $('span', 'bt'); bt.append($('b', null, 'Tessaya'), $('span', 'plan', 'v' + (((S.extra || {}).about || {}).version || ''))); brand.append(mk, bt); side.appendChild(brand);
  const nav = $('nav'); nav.setAttribute('aria-label', 'Tessaya pages'); nav.id = 'navlist';
  const names = Object.fromEntries(TABS);
  for (const a of AREAS) {
    const here = a.pages.includes(cur), open = here || openAreas.has(a.id), aname = L('area.' + a.id);
    const gl = $('button', 'glabel'); gl.setAttribute('data-g', HUE[a.id]); gl.setAttribute('aria-expanded', String(open)); gl.append($('span', null, aname), icon('fold', 14));
    gl.onclick = () => { if (openAreas.has(a.id)) openAreas.delete(a.id); else openAreas.add(a.id); saveAreas(); render(); }; nav.appendChild(gl);
    if (!open && !collapsed) continue;
    for (const id of a.pages) { const b = $('button', 'nav'); b.setAttribute('data-g', GROUP_OF[id]); b.setAttribute('data-tip', names[id]); if (cur === id) b.setAttribute('aria-current', 'page'); b.append(icon(id), $('span', null, names[id])); if (id === 'sessions' && need) b.appendChild($('span', 'n', String(need))); b.onclick = () => go(id); nav.appendChild(b); }
    if (a.settings && !collapsed) { const sb2 = $('button', 'nav sub'); sb2.setAttribute('data-g', HUE[a.id]); sb2.append(icon('settings'), $('span', null, L('area.settings', { area: aname }))); sb2.onclick = () => go(a.settings); nav.appendChild(sb2); }
  }
  side.appendChild(nav);
  if (up && up.lead) { const c = $('div', 'sidecard go'); c.append($('b', null, 'Update ready'), $('p', null, 'Tessaya restarts itself and reopens this window.')); const bt = $('button', 'btn', up.button); bt.onclick = () => set('u.act', null); c.appendChild(bt); side.appendChild(c); }
  const foot = $('div', 'foot'); const st = $('button', 'nav'); st.setAttribute('data-tip', 'Settings'); st.append(icon('settings'), $('span', null, 'Settings')); st.onclick = () => go('general');
  const hp = $('button', 'nav'); hp.setAttribute('data-tip', 'Help'); hp.append(icon('help'), $('span', null, 'Help')); if (cur === 'help') hp.setAttribute('aria-current', 'page'); hp.onclick = () => go('help');
  const t3 = $('button', 'nav'); t3.setAttribute('data-tip', 'Open T3 sessions'); t3.append(icon('external'), $('span', null, 'Open T3 sessions')); t3.onclick = () => real && ipc.send('baton-home:sessions');
  foot.append(t3, hp, st); side.appendChild(foot);
  }, 'brand');
  setRegion(document.getElementById('top'), top => {
  const sb = $('input', 'search'); sb.id = 'q'; sb.type = 'search'; sb.placeholder = 'Search settings'; sb.setAttribute('aria-label', 'Search settings'); sb.value = query; sb.oninput = () => { query = sb.value; render(); }; sb.onkeydown = e => { if (e.key === 'Escape' && query) { query = ''; render(); } };
  const tg = $('button', 'ibtn'); tg.id = 'railtoggle'; tg.setAttribute('aria-label', collapsed ? 'Expand the sidebar' : 'Collapse the sidebar'); tg.setAttribute('aria-expanded', String(!collapsed)); tg.appendChild(icon('side')); tg.onclick = toggleRail; top.appendChild(tg);
  const stt = $('div', 'state'); stt.setAttribute('role', 'status'); stt.setAttribute('data-tone', S.status.tone); if (lastState !== null && lastState !== S.status.label) stt.className += ' morph'; lastState = S.status.label; const d = $('span', 'dot'); d.setAttribute('data-tone', S.status.tone); stt.append(d, $('span', null, S.status.label + (S.status.device ? ' \\u00b7 ' + S.status.device : ''))); top.appendChild(stt);
  const vb = find('vt.bar'); if (vb && vb.state === 'unlocked') { const lk = $('button', 'ibtn'); lk.setAttribute('aria-label', 'Lock the vault'); lk.setAttribute('title', 'Lock the vault'); lk.appendChild(icon('vault')); lk.onclick = () => set('vt.lock', null); top.appendChild(lk); }
  const bell = $('button', 'ibtn'); bell.setAttribute('aria-label', L('alerts.title')); bell.appendChild(icon('bell')); if ((up && up.lead) || need) bell.appendChild($('span', 'pip')); bell.setAttribute('aria-expanded', String(bellOpen)); bell.onclick = e => { e.stopPropagation(); bellOpen = !bellOpen; render(); }; top.appendChild(bell);
  if (bellOpen) { const pop = $('div', 'pop'); pop.setAttribute('role', 'dialog'); pop.setAttribute('aria-label', L('alerts.title')); pop.appendChild($('b', null, L('alerts.title')));
    if (need) { const b = $('button', 'btn', L(need === 1 ? 'alerts.one' : 'alerts.many', { n: need })); b.onclick = () => { bellOpen = false; showLive(); }; pop.appendChild(b); }
    if (up && up.lead) { const b = $('button', 'btn', L('alerts.update', { name: up.button })); b.onclick = () => { bellOpen = false; set('u.act', null); }; pop.appendChild(b); }
    if (!need && !(up && up.lead)) pop.appendChild($('p', null, L('alerts.none')));
    top.appendChild(pop); }
  const ac = $('button', 'ibtn'); ac.setAttribute('aria-label', 'Account'); ac.appendChild(icon('user')); ac.onclick = () => go('assistant'); top.appendChild(sb); top.appendChild(ac);
  });
  const page = document.getElementById('page'); const pageClass = (cur === 'home' ? 'wide' : '') + (entering ? ' enter' : ''); if (page.className !== pageClass) page.className = pageClass; setRegion(page, tabPage);
  syncModal(); syncEnrol(); try { syncChrome(); } catch (e) {}
  if (pendingGo) { const t = pendingGo; pendingGo = null; modal = null; go(t); return; }
  if (keep && (keep.indexOf('in-') === 0 || keep === 'q')) { const e = document.getElementById(keep); if (e) { e.focus(); if (pos != null) e.setSelectionRange(pos, pos); } }
}
addEventListener('keydown', e => {
  // The voice card is on top of everything: Esc cancels or closes it, and Tab stays inside it.
  if (enrolEl) {
    if (e.key === 'Escape') { e.preventDefault(); enrolClose(); return; }
    if (e.key !== 'Tab') return;
    const box = document.getElementById('enrolbox'), items = Array.from(box.querySelectorAll('button')).filter(x => !x.hidden);
    if (!items.length) { e.preventDefault(); return; }
    const first = items[0], last = items[items.length - 1];
    if (!box.contains(document.activeElement) || document.activeElement === box) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    return;
  }
  if (e.key === 'Escape' && modal) closeModal();
  // Tab stays inside the settings dialog while it is open.
  if (e.key === 'Tab' && modal) {
    const mm = document.getElementById('modal'); if (!mm) return;
    const items = Array.from(mm.querySelectorAll('button, input, select, textarea, [tabindex]:not([tabindex="-1"])')).filter(x => !x.disabled && x.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (!mm.contains(document.activeElement)) { e.preventDefault(); first.focus(); }
    else if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});
if (real) ipc.on('baton-home:state', (_e, s) => render(s));
// tessaya://settings/<place>, from T3's window, a link or a second launch: the place opens once the state is in.
let pendingGo = null;
if (real) ipc.on('baton-home:go', (_e, t) => { if (typeof t !== 'string') return; if (!S) { pendingGo = t; return; } modal = null; go(t); });
if (real) ipc.on('baton-home:theme', (_e, t) => { document.documentElement.dataset.theme = t; });
// The mark breathes whenever the window can be seen, focused or not; minimised or hidden, nothing runs.
function syncBreath() { document.documentElement.classList.toggle('live', !document.hidden); }
document.addEventListener('visibilitychange', syncBreath); syncBreath();
get().then(s => { render(s); if (!s.splashed) startSting(); });
`;

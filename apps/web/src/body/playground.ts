/**
 * The body playground (M-089) as one same-origin script (`/assets/tessaya-playground.js`): a stage with her light body,
 * the direction bar, pose, face, scenes, check and the body's manifest, and one sandbox bus per stage that any agent
 * drives through MCP (tessaya_body_move with target "playground"). /tessaya/playground mounts it as is; a private layer
 * mounts it with hooks for its own models, its direction model and its own tabs. Text is set with textContent only.
 */
import type { RigManifest } from "@t3tools/tessaya-shared/bodyRig";

import type { BodyControl } from "./entry";
import { modelOrder } from "@t3tools/tessaya-shared/playgroundOrder";
import type { mountBody } from "./vrmBody";

type Body = ReturnType<typeof mountBody>;
type Move = Record<string, unknown>;
interface Beat {
  atMs: number;
  label?: string;
  body?: string;
  move: Move;
}
interface SceneDraft {
  version: number;
  id: string;
  title?: string;
  bodies?: string[];
  beats: Beat[];
  branches?: Array<{ id: string; on: Record<string, unknown>; beats: Beat[]; after?: string }>;
}
export interface PlaygroundModel {
  readonly id?: string | null;
  readonly name: string;
  readonly url?: string;
  readonly buf?: ArrayBuffer;
  readonly why?: string;
  readonly from: string;
}
/** A model's licence as its own file states it (VRM meta), in plain words. */
export interface Licence {
  readonly title?: string;
  readonly author?: string;
  readonly who?: string;
  readonly changes?: string;
  readonly redistribution?: string;
  readonly commercial?: string;
}
export interface PlaygroundTab {
  readonly id: string;
  readonly label: string;
  readonly render: (pane: HTMLElement, pg: Playground) => void;
}
export interface PlaygroundHooks {
  /** The playground's own API (buses, provenance); a layer may point it elsewhere. */
  readonly api?: string;
  /** Models in the order to try: his last, the body she wears now, his library. */
  readonly models?: () => Promise<ReadonlyArray<PlaygroundModel>>;
  /** A direction in his words as one body move. */
  readonly direct?: (text: string) => Promise<{ readonly move: unknown; readonly by: string }>;
  readonly record?: (action: string, subject?: string, data?: object) => void;
  readonly tabs?: ReadonlyArray<PlaygroundTab>;
  /** A model opened, with its glTF JSON and bytes (a layer may judge it or keep a dropped file). */
  readonly onModel?: (m: PlaygroundModel, json: Record<string, unknown>, buf: ArrayBuffer) => void;
  /** A hand on the first stage's body (vrmBody onTouch). */
  readonly onTouch?: NonNullable<Parameters<typeof mountBody>[1]>["onTouch"];
  /** The pieces the first stage's model can take off, once it loads (vrmBody onOutfit): a layer's wardrobe. */
  readonly onOutfit?: NonNullable<Parameters<typeof mountBody>[1]>["onOutfit"];
}
export interface Playground {
  readonly control: BodyControl;
  readonly body: () => Body | null;
  readonly stage: () => HTMLElement;
  readonly cue: (cue: unknown) => void;
  readonly play: (move: unknown, label?: string) => boolean;
  readonly open: (m: PlaygroundModel) => Promise<boolean>;
  readonly note: (msg: string) => void;
  readonly render: (tab?: string) => void;
  readonly record: (action: string, subject?: string, data?: object) => void;
  /** The sandbox buses this page shows: the first stage's, and the second's in compare. */
  readonly buses: () => ReadonlyArray<string>;
  /** Plays a move on one stage only (compare). */
  readonly playOn: (stage: number, move: unknown) => boolean;
  readonly compare: (on: boolean) => void;
  readonly frame: (f: "bust" | "body") => void;
  readonly title: (name: string, why?: string) => void;
}

declare global {
  interface Window {
    tessayaPlayground?: { readonly mount: typeof mountPlayground };
  }
}

const CSS = `
.pg{--rail:400px;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;display:flex;flex-direction:column;height:100%;min-height:0;background:var(--bg);color:var(--ink);font:14px/1.45 var(--sans,system-ui,sans-serif)}
.pg button{font:inherit;color:inherit}
.pg :focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.pg [hidden]{display:none!important}
.pg .btn{background:transparent;border:1px solid var(--line);border-radius:999px;padding:6px 12px;cursor:pointer;white-space:nowrap}
.pg .btn:hover{border-color:var(--soft)}.pg .btn.primary{background:var(--accent);border-color:var(--accent);color:var(--on)}
.pg .btn[aria-pressed=true]{background:var(--ink);color:var(--bg);border-color:var(--ink)}
.pg .btn:disabled{opacity:.4;cursor:not-allowed}
.pg .file input{display:none}
.pg kbd{font:500 10.5px var(--mono);border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;padding:0 4px;color:var(--soft);margin-left:6px}
.pg .bar{display:flex;align-items:center;gap:10px;padding:8px 16px;border-bottom:1px solid var(--line);min-height:48px}
.pg .who{display:flex;flex-direction:column;min-width:0;flex:1}
.pg .who h1{font:italic 400 24px/1.05 var(--serif,Georgia,serif);margin:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pg .who small{color:var(--soft);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pg main{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) var(--rail)}
.pg.full main{grid-template-columns:minmax(0,1fr) 0}.pg.full .rail{display:none}
.pg .stages{position:relative;min-width:0;min-height:0;display:grid;grid-auto-flow:column;grid-auto-columns:minmax(0,1fr)}
.pg .stage{position:relative;min-width:0;min-height:0;overflow:hidden;background:radial-gradient(60% 65% at 50% 40%,var(--pool,var(--panel)),var(--stage,var(--bg)) 78%)}
.pg .stage+.stage{border-left:1px solid var(--line)}
.pg .stage canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none}
.pg .stage .tag{position:absolute;right:12px;bottom:12px;z-index:2;font:11px var(--mono);color:var(--soft);background:color-mix(in srgb,var(--bg) 80%,transparent);border-radius:999px;padding:2px 8px}
.pg .ov{pointer-events:none;z-index:2}
.pg .load{position:absolute;left:16px;right:16px;top:12px;z-index:3;display:flex;flex-direction:column;gap:6px;max-width:360px}
.pg .load span{font-size:12px;color:var(--soft)}
.pg .load i{display:block;height:2px;background:var(--line);border-radius:2px;overflow:hidden}
.pg .load b{display:block;height:100%;width:100%;background:var(--accent);transform:scaleX(0);transform-origin:left;transition:transform .15s linear}
.pg .drop{position:absolute;inset:16px;border:1.5px dashed var(--accent);border-radius:18px;display:flex;align-items:center;justify-content:center;text-align:center;color:var(--accent);background:color-mix(in srgb,var(--bg) 70%,transparent);z-index:4;font:italic 22px var(--serif,Georgia,serif);padding:16px}
.pg .empty{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;text-align:center;color:var(--soft);padding:24px;z-index:1}
.pg .direct{position:absolute;left:50%;bottom:20px;transform:translateX(-50%);width:min(620px,calc(100% - 32px));z-index:3;display:flex;flex-direction:column;gap:6px}
.pg .direct form{display:flex;align-items:center;gap:6px;background:color-mix(in srgb,var(--panel) 92%,transparent);border:1px solid var(--line);border-radius:999px;padding:5px 5px 5px 16px;box-shadow:0 10px 30px rgba(0,0,0,.14)}
.pg .direct input{flex:1;min-width:0;border:0;background:transparent;font:15px var(--sans,system-ui);color:var(--ink);padding:6px 0}
.pg .direct input:focus{outline:none}
.pg .said{align-self:center;font-size:12px;color:var(--soft);background:color-mix(in srgb,var(--bg) 88%,transparent);border-radius:999px;padding:2px 10px}.pg .said:empty{display:none}
.pg .cam{position:absolute;left:16px;bottom:20px;z-index:3;display:flex;flex-direction:column;gap:6px}
.pg .seg{display:flex;border:1px solid var(--line);border-radius:999px;background:color-mix(in srgb,var(--panel) 88%,transparent)}
.pg .seg button{border:0;background:transparent;padding:5px 10px;border-radius:999px;cursor:pointer;color:var(--soft);font-size:12.5px}
.pg .seg button[aria-pressed=true]{color:var(--ink);background:color-mix(in srgb,var(--ink) 10%,transparent)}
.pg .fold{position:absolute;right:12px;top:12px;z-index:3}
.pg .rail{border-left:1px solid var(--line);display:flex;flex-direction:column;min-height:0;min-width:0}
.pg .tabs{display:flex;gap:2px;padding:6px 8px;border-bottom:1px solid var(--line);overflow-x:auto;scrollbar-width:none}
.pg .tabs button{border:0;background:transparent;padding:6px 7px;border-radius:8px;cursor:pointer;color:var(--soft);font-size:13px;white-space:nowrap}
.pg .tabs button[aria-selected=true]{color:var(--ink);background:color-mix(in srgb,var(--ink) 8%,transparent)}
.pg .tabs .n{font:10px var(--mono);color:var(--soft);margin-left:3px}
.pg .pane{flex:1;min-height:0;overflow-y:auto;padding:4px 16px 24px}
.pg section{padding:12px 0;border-bottom:1px solid var(--line)}.pg section:last-child{border-bottom:0}
.pg h2{font:600 10.5px var(--sans,system-ui);color:var(--soft);margin:0 0 8px;text-transform:uppercase;letter-spacing:.14em;display:flex;align-items:center;gap:8px}
.pg h2 .act{margin-left:auto;text-transform:none;letter-spacing:0;font-weight:500;font-size:12px}
.pg h3{font:italic 400 19px/1.2 var(--serif,Georgia,serif);margin:2px 0 6px}
.pg .row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}.pg .grow{flex:1;min-width:0}
.pg .sub{font-size:12.5px;color:var(--soft);margin:4px 0}.pg .warn{font-size:12.5px;color:var(--warn,var(--bad))}
.pg .chips{display:flex;flex-wrap:wrap;gap:6px}
.pg .chip{border:1px solid var(--line);background:transparent;border-radius:999px;padding:5px 11px;cursor:pointer;font-size:13px}
.pg .chip:hover{border-color:var(--accent);color:var(--accent)}
.pg .chip[aria-pressed=true]{background:var(--accent);border-color:var(--accent);color:var(--on)}
.pg details{border-top:1px solid var(--line);margin-top:10px;padding-top:8px}
.pg summary{cursor:pointer;color:var(--soft);font-size:12.5px;list-style:none}
.pg summary::before{content:"+ ";font-family:var(--mono)}.pg details[open]>summary::before{content:"– "}
.pg input[type=search],.pg input[type=text],.pg select,.pg textarea{font:inherit;color:inherit;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:7px 9px;min-width:0;width:100%;box-sizing:border-box}
.pg textarea{font:12px/1.4 var(--mono);min-height:120px;resize:vertical}
.pg .sl{display:grid;grid-template-columns:76px minmax(0,1fr) 48px;align-items:center;gap:8px;margin:5px 0}
.pg .sl label{font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.pg .sl output{font:11.5px var(--mono);color:var(--soft);text-align:right}
.pg .track{position:relative;height:20px}
.pg .track::before{content:"";position:absolute;left:0;right:0;top:9px;height:2px;border-radius:1px;background:var(--line)}
.pg .track .reach{position:absolute;top:7px;height:6px;border-radius:3px;background:color-mix(in srgb,var(--accent) 30%,transparent)}
.pg .track input{position:absolute;inset:0;width:100%;margin:0;background:transparent;accent-color:var(--accent)}
.pg .list{display:flex;flex-direction:column}
.pg .item{display:flex;align-items:center;gap:8px;padding:7px 0;border-bottom:1px solid color-mix(in srgb,var(--line) 60%,transparent);font-size:13px}
.pg .item:last-child{border-bottom:0}.pg .item .grow{min-width:0;overflow-wrap:anywhere}
.pg .dot{width:7px;height:7px;border-radius:50%;background:var(--line);flex:none}.pg .dot.on{background:var(--accent)}.pg .dot.bad{background:var(--bad)}
.pg .kv{display:grid;grid-template-columns:42% 1fr;gap:3px 10px;font-size:13px}.pg .kv dt{color:var(--soft)}.pg .kv dd{margin:0;overflow-wrap:anywhere}
.pg .tl{position:relative;height:46px;margin:8px 0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
.pg .tl .beat{position:absolute;top:8px;width:10px;height:28px;margin-left:-5px;border-radius:3px;background:var(--line);border:0;cursor:pointer;padding:0}
.pg .tl .beat[aria-current=true]{background:var(--accent)}
.pg .tl .head{position:absolute;top:0;bottom:0;width:1px;background:var(--ink);pointer-events:none}
.pg .scrub{width:100%}
.pg .note{position:fixed;left:50%;bottom:86px;transform:translateX(-50%);background:var(--ink);color:var(--bg);padding:8px 14px;border-radius:10px;max-width:calc(100vw - 32px);z-index:9;font-size:13px}
.pg .help{position:fixed;inset:0;background:color-mix(in srgb,var(--bg) 60%,transparent);display:flex;align-items:center;justify-content:center;z-index:10}
.pg .help .card2{background:var(--panel);border:1px solid var(--line);border-radius:16px;padding:20px 24px;max-width:460px;width:calc(100% - 32px)}
.pg .help dl{display:grid;grid-template-columns:auto 1fr;gap:6px 14px;font-size:13px;margin:12px 0 0}.pg .help dt{text-align:right}
@media (max-width:860px){
  .pg main{grid-template-columns:1fr;grid-template-rows:minmax(0,1fr) 46vh}
  .pg.full main{grid-template-rows:minmax(0,1fr) 0}
  .pg .rail{border-left:0;border-top:1px solid var(--line)}
  .pg .who h1{font-size:20px}.pg .bar{gap:6px;padding:6px 10px}.pg .wide{display:none!important}
  .pg .stages{grid-auto-flow:row;grid-auto-rows:minmax(0,1fr)}.pg .stage+.stage{border-left:0;border-top:1px solid var(--line)}
  .pg .cam{left:10px;top:12px;bottom:auto;flex-direction:row}.pg .fold{top:auto;bottom:76px}.pg .direct{bottom:12px}
}
@media (prefers-reduced-motion:reduce){.pg *{transition:none!important}}
`;

const ACT_WORDS: Readonly<Record<string, string>> = {
  stand: "Stand",
  sit: "Sit down",
  lie: "Lie down",
  lean: "Lean in",
  cuddle: "Cuddle",
  hug: "Hug",
  reach: "Reach out",
  turnAway: "Turn away",
  walkOver: "Come closer",
  stepBack: "Step back",
  dance: "Dance",
  wave: "Wave",
  nod: "Nod",
  shrug: "Shrug",
  bow: "Bow",
  giggle: "Giggle",
  sigh: "Sigh",
  stretch: "Stretch",
};
const SYSTEM_WORDS: Readonly<Record<string, readonly [string, string]>> = {
  breath: ["Breathing", "Her chest rises and falls; she can hold her breath for a while."],
  blink: ["Blinking", "She can keep her eyes open a few seconds, not for ever."],
  saccade: ["Eye flicks", "Small glances; she can hold her gaze steady."],
  moodLeak: ["Mood on her face", "How she feels shows; held back, a little still leaks through."],
  tremor: ["Trembling", "At great effort or feeling. She can't stop it."],
  withdrawal: ["Pulling away", "From a sharp touch. A reflex: never held."],
  startle: ["Startle", "At a sudden touch or sound. A reflex: never held."],
  balance: ["Balance", "Keeps her standing. Always on."],
  flush: ["Flush", "Colour in her face with feeling. Always on."],
};
const REGION: ReadonlyArray<readonly [string, RegExp]> = [
  ["Head and neck", /^(head|neck|jaw|leftEye|rightEye)$/],
  ["Spine", /^(hips|spine|chest|upperChest)$/],
  ["Left arm", /^left(Shoulder|UpperArm|LowerArm|Hand)$/],
  ["Right arm", /^right(Shoulder|UpperArm|LowerArm|Hand)$/],
  ["Left leg", /^left(UpperLeg|LowerLeg|Foot|Toes)$/],
  ["Right leg", /^right(UpperLeg|LowerLeg|Foot|Toes)$/],
];
const BONE_WORDS: Readonly<Record<string, string>> = {
  hips: "Hips",
  spine: "Lower back",
  chest: "Chest",
  upperChest: "Upper chest",
  neck: "Neck",
  head: "Head",
  jaw: "Jaw",
  leftEye: "Left eye",
  rightEye: "Right eye",
};
const AXIS_WORDS = ["Bend", "Turn", "Tilt"] as const;
const ISSUE_WORDS: Readonly<Record<string, string>> = {
  range: "past its reach",
  twist: "twisted too far",
  reversal: "bent the wrong way",
  sideBend: "bent sideways",
  penetration: "pressed into her",
  nonFinite: "an impossible number",
};
const PRESET_WORDS: Readonly<Record<string, string>> = {
  happy: "Happy",
  angry: "Angry",
  sad: "Sad",
  relaxed: "Relaxed",
  surprised: "Surprised",
  aa: "Mouth: aa",
  ih: "Mouth: ih",
  ou: "Mouth: ou",
  ee: "Mouth: ee",
  oh: "Mouth: oh",
  blink: "Blink",
  blinkLeft: "Wink left",
};
const MOODS = [
  "calm",
  "happy",
  "delighted",
  "playful",
  "shy",
  "curious",
  "thinking",
  "surprised",
  "nervous",
  "sad",
  "annoyed",
  "sleepy",
];
const LAST = "tessaya.playground.last";

const human = (id: string) =>
  String(id)
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (c) => c.toUpperCase())
    .replace(/ ([A-Z])/g, (_m, c: string) => " " + c.toLowerCase());
const boneWord = (b: string) =>
  BONE_WORDS[b] ??
  (/^left/.test(b) ? "Left " : "Right ") +
    human(b.replace(/^(left|right)/, ""))
      .toLowerCase()
      .replace("lower arm", "forearm")
      .replace("upper leg", "thigh")
      .replace("lower leg", "shin");
const deg = (r: number) => Math.round((r * 180) / Math.PI) + "°";
const plain = (msg: string) =>
  String(msg)
    .replace(/^bodyMove\.?/, "")
    .replace(/must be/g, "should be")
    .replace(/^./, (c) => c.toUpperCase());
const store = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      // not kept on this device
    }
  },
};
const el = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string | null, text?: string) => {
  const d = document.createElement(tag);
  if (cls) d.className = cls;
  if (text != null) d.textContent = text;
  return d;
};
const btn = (label: string, cls: string | null, onClick: () => void, title?: string) => {
  const b = el("button", cls ?? "chip", label);
  b.type = "button";
  if (title) b.title = title;
  b.onclick = onClick;
  return b;
};
const sec = (title: string, extra?: Node | null) => {
  const s = el("section");
  const h = el("h2", null, title);
  if (extra) h.append(extra);
  s.append(h);
  return s;
};
const pressed = (b: HTMLElement, on: boolean) => {
  b.setAttribute("aria-pressed", String(on));
  return b;
};

/** The glTF JSON chunk of a .vrm or .glb, or null. */
export const glbJson = (buf: ArrayBuffer): Record<string, unknown> | null => {
  const d = new DataView(buf);
  if (buf.byteLength < 20 || d.getUint32(0, true) !== 0x46546c67) return null;
  try {
    return JSON.parse(new TextDecoder().decode(new Uint8Array(buf, 20, d.getUint32(12, true))));
  } catch {
    return null;
  }
};
const str = (v: unknown) => (typeof v === "string" && v !== "" ? v : undefined);
const WORDS: Readonly<Record<string, string>> = {
  onlyAuthor: "Only the author",
  OnlyAuthor: "Only the author",
  onlySeparatelyLicensedPerson: "Only people the author licenses",
  ExplicitlyLicensedPerson: "Only people the author licenses",
  everyone: "Everyone",
  Everyone: "Everyone",
  prohibited: "Not allowed",
  allowModification: "Allowed",
  allowModificationRedistribution: "Allowed, and shared on",
  personalNonProfit: "Personal, not for profit",
  personalProfit: "Personal, for profit",
  corporation: "Allowed, companies too",
  Allow: "Allowed",
  Disallow: "Not allowed",
};
/** What a VRM 1.0 or 0.x file says of its own licence. */
export const licenceOf = (json: Record<string, unknown> | null): Licence | null => {
  const ext = (json?.["extensions"] ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const m1 = ext["VRMC_vrm"]?.["meta"] as Record<string, unknown> | undefined;
  const w = (v: unknown) => (typeof v === "string" ? (WORDS[v] ?? v) : undefined);
  const yes = (v: unknown) => (v === true ? "Allowed" : v === false ? "Not allowed" : undefined);
  const pick = (l: Record<string, string | undefined>): Licence =>
    Object.fromEntries(Object.entries(l).filter(([, v]) => v !== undefined));
  if (m1 !== undefined)
    return pick({
      title: str(m1["name"]),
      author: Array.isArray(m1["authors"]) ? m1["authors"].join(", ") : undefined,
      who: w(m1["avatarPermission"]),
      changes: w(m1["modification"]),
      redistribution: yes(m1["allowRedistribution"]),
      commercial: w(m1["commercialUsage"]),
    });
  const m0 = ext["VRM"]?.["meta"] as Record<string, unknown> | undefined;
  if (m0 !== undefined)
    return pick({
      title: str(m0["title"]),
      author: str(m0["author"]),
      who: w(m0["allowedUserName"]),
      changes: str(m0["licenseName"]),
      commercial: w(m0["commercialUssageName"]),
    });
  return null;
};

const rand = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(4)), (b) => b.toString(36).padStart(2, "0"))
    .join("")
    .slice(0, 7);

interface Stage {
  readonly root: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly bus: string;
  body: Body | null;
  loaded: (() => void) | null;
  closed: boolean;
  stop: () => void;
}

export function mountPlayground(host: HTMLElement, hooks: PlaygroundHooks = {}): Playground {
  const T = window.tessayaBody?.control;
  if (T === undefined) throw new Error("The light body (/assets/tessaya-body.js) loads first.");
  const api = hooks.api ?? "/tessaya/playground/api";
  if (document.getElementById("pg-css") === null) {
    const style = el("style");
    style.id = "pg-css";
    style.textContent = CSS;
    document.head.append(style);
  }
  host.replaceChildren();
  const root = el("div", "pg");
  host.append(root);

  const post = async (op: string, body: object) => {
    const r = await fetch(`${api}/${op}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      credentials: "same-origin",
    });
    const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    if (!r.ok)
      throw Object.assign(new Error(str(j["message"]) ?? "That did not work."), {
        status: r.status,
      });
    return j;
  };
  let lastAct: string | null = null;
  const record =
    hooks.record ??
    ((action: string, subject?: string, data?: object) => {
      void post("act", { action, subject, data, cause: lastAct ?? undefined })
        .then((r) => {
          lastAct = str(r["id"]) ?? lastAct;
        })
        .catch(() => null);
    });

  const bar = el("header", "bar");
  const who = el("div", "who");
  const title = el("h1", null, "Body playground");
  const subtitle = el("small", null, "Loading");
  who.append(title, subtitle);
  const fileLabel = el("label", "btn file", "Open a file");
  const file = el("input");
  file.type = "file";
  file.accept = ".vrm,.glb";
  fileLabel.append(file);
  const compareBtn = pressed(
    btn("Compare", "btn", () => compare(stages.length < 2), "Two stages side by side (C)"),
    false,
  );
  const helpBtn = btn("?", "btn", () => help(true), "Keyboard shortcuts (?)");
  helpBtn.setAttribute("aria-label", "Keyboard shortcuts");
  bar.append(who, compareBtn, fileLabel, helpBtn);

  const main = el("main");
  const stagesEl = el("div", "stages");
  stagesEl.setAttribute("role", "region");
  stagesEl.setAttribute("aria-label", "Stage");
  const load = el("div", "load");
  load.hidden = true;
  load.setAttribute("role", "status");
  const loadText = el("span", null, "Loading");
  const loadTrack = el("i");
  const loadBar = el("b");
  loadTrack.append(loadBar);
  load.append(loadText, loadTrack);
  const drop = el("div", "drop", "Drop a .vrm or .glb to look at it. Nothing is kept.");
  drop.hidden = true;
  const empty = el("div", "empty");
  empty.hidden = true;
  const fold = btn("Hide controls", "btn fold", () => setFold(!root.classList.contains("full")));
  fold.title = "Controls (H)";
  const cam = el("div", "cam");
  const frames = el("div", "seg");
  frames.setAttribute("role", "group");
  frames.setAttribute("aria-label", "Camera");
  const orbits = el("div", "seg");
  orbits.setAttribute("role", "group");
  orbits.setAttribute("aria-label", "Turn around her");
  cam.append(frames, orbits);
  const direct = el("div", "direct");
  const dirForm = el("form");
  const dir = el("input");
  dir.type = "text";
  dir.autocomplete = "off";
  dir.placeholder = "Tell her body what to do: shrug like you don't know";
  dir.setAttribute("aria-label", "A direction for her body");
  const dirGo = el("button", "btn primary", "Do it");
  dirForm.append(dir, dirGo);
  const said = el("div", "said");
  said.setAttribute("aria-live", "polite");
  direct.append(dirForm, said);
  direct.hidden = hooks.direct === undefined;

  const rail = el("aside", "rail");
  rail.setAttribute("aria-label", "Controls");
  const tabsEl = el("nav", "tabs");
  tabsEl.setAttribute("role", "tablist");
  rail.append(tabsEl);
  main.append(stagesEl, rail);
  const noteEl = el("div", "note");
  noteEl.hidden = true;
  noteEl.setAttribute("role", "status");
  const helpEl = el("div", "help");
  helpEl.hidden = true;
  helpEl.setAttribute("role", "dialog");
  helpEl.setAttribute("aria-modal", "true");
  const helpCard = el("div", "card2");
  const keys = el("dl");
  helpCard.append(el("h3", null, "Shortcuts"), keys, el("p", "sub", "Esc closes this."));
  helpEl.append(helpCard);
  helpEl.onclick = (e) => {
    if (e.target === helpEl) help(false);
  };
  root.append(bar, main, noteEl, helpEl);

  let noteTimer = 0;
  const note = (msg: string) => {
    noteEl.textContent = msg;
    noteEl.hidden = false;
    clearTimeout(noteTimer);
    noteTimer = window.setTimeout(() => {
      noteEl.hidden = true;
    }, 4200);
  };
  const help = (on: boolean) => {
    helpEl.hidden = !on;
  };
  const setFold = (full: boolean) => {
    root.classList.toggle("full", full);
    fold.textContent = full ? "Show controls" : "Hide controls";
    pressed(fold, full);
  };

  const page = rand();
  const stages: Stage[] = [];
  let model: PlaygroundModel | null = null;
  let blobUrl: string | null = null;
  let framing: "bust" | "body" = "body";
  let reportTimer = 0;
  const report = (s: Stage) => {
    clearTimeout(reportTimer);
    reportTimer = window.setTimeout(() => {
      if (s.body) void post("state", { bus: s.bus, state: s.body.state() }).catch(() => null);
    }, 400);
  };
  const take = (s: Stage, r: Record<string, unknown>) => {
    for (const c of (r["cues"] as unknown[]) ?? []) s.body?.cue(c as never);
  };
  // A push socket first: nothing runs while nothing is sent. Where a proxy refuses sockets, the long poll.
  const listen = (s: Stage, tries = 0) => {
    if (s.closed) return;
    let opened = false;
    const ws = new WebSocket(
      `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}${api}/push?bus=${s.bus}`,
    );
    ws.onopen = () => {
      opened = true;
    };
    ws.onmessage = (e) => {
      const r = JSON.parse(String(e.data)) as Record<string, unknown>;
      if (r["closed"] === true) {
        s.closed = true;
        note("This playground closed. Reload the page to open it again.");
      } else take(s, r);
    };
    ws.onclose = () => {
      if (s.closed) return;
      if (!opened && tries >= 1) void poll(s);
      else setTimeout(() => listen(s, opened ? 0 : tries + 1), 2000);
    };
    s.stop = () => ws.close();
  };
  const poll = async (s: Stage) => {
    let after = 0;
    while (!s.closed) {
      try {
        const r = await post("poll", { bus: s.bus, after, wait: after === 0 ? 0 : 20_000 });
        if (r["closed"] === true) {
          s.closed = true;
          note("This playground closed. Reload the page to open it again.");
          return;
        }
        take(s, r);
        if (typeof r["seq"] === "number") after = r["seq"];
      } catch {
        await new Promise((res) => setTimeout(res, 3000));
      }
    }
  };
  const addStage = () => {
    const i = stages.length;
    const st = el("div", "stage");
    const canvas = el("canvas");
    canvas.setAttribute("aria-label", i === 0 ? "Her body" : "Her body, second stage");
    const bus = i === 0 ? `pg-${page}` : `pg-${page}-${i + 1}`;
    const tag = el("span", "tag", bus);
    tag.title = "Agents drive this stage as playground " + bus;
    st.append(canvas, tag);
    const s: Stage = {
      root: st,
      canvas,
      bus,
      body: null,
      loaded: null,
      closed: false,
      stop: () => undefined,
    };
    stages.push(s);
    stagesEl.append(st);
    s.body = window.tessayaBody!.mount(canvas, {
      framing,
      ...(i === 0 && hooks.onTouch ? { onTouch: hooks.onTouch } : {}),
      onOutfit: (pieces) => {
        s.loaded?.();
        s.loaded = null;
        if (i === 0) hooks.onOutfit?.(pieces);
      },
      onSettle: () => {
        report(s);
        if (i === 0 && (tab === "body" || tab === "check")) render(tab);
      },
    });
    s.body.cue({ kind: "show" });
    if (blobUrl !== null) s.body.cue({ kind: "model", persona: "viewer", url: blobUrl });
    listen(s);
    return s;
  };
  const cue = (c: unknown) => {
    for (const s of stages) s.body?.cue(c as never);
  };
  const play = (move: unknown, label?: string) => {
    const d = T.decodeBodyMove(move);
    if (!d.ok) {
      note(plain(d.error));
      return false;
    }
    for (const c of T.moveCues(d.move, "playground")) cue(c);
    record("moved", label ?? "move", { fields: Object.keys(d.move) });
    return true;
  };
  const playOn = (i: number, move: unknown) => {
    const d = T.decodeBodyMove(move);
    const s = stages[i];
    if (!d.ok || s?.body == null) return false;
    for (const c of T.moveCues(d.move, "playground")) s.body.cue(c);
    return true;
  };
  const compare = (on: boolean) => {
    if (on && stages.length < 2) addStage();
    if (!on)
      while (stages.length > 1) {
        const s = stages.pop()!;
        s.closed = true;
        s.stop();
        s.body?.dispose();
        s.root.remove();
      }
    pressed(compareBtn, stages.length > 1);
    for (const s of stages) s.body?.frame(framing);
    record("compare", on ? "on" : "off");
    render();
  };

  const setBar = (f: number) => {
    loadBar.style.transform = `scaleX(${f})`;
  };
  const fetchWithProgress = async (url: string, label: string) => {
    load.hidden = false;
    loadText.textContent = "Loading " + label;
    setBar(0.04);
    const r = await fetch(url, { credentials: "same-origin" });
    if (!r.ok) throw Object.assign(new Error("That model wouldn't open."), { status: r.status });
    const total = Number(r.headers.get("content-length")) || 0;
    if (!r.body || !total) {
      const b = await r.arrayBuffer();
      setBar(0.9);
      return b;
    }
    const reader = r.body.getReader();
    const parts: Uint8Array[] = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
      got += value.length;
      setBar(Math.min(0.9, (got / total) * 0.9));
      loadText.textContent = `Loading ${label} · ${Math.round(got / 1048576)} of ${Math.round(total / 1048576)} MB`;
    }
    const out = new Uint8Array(got);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out.buffer;
  };
  let licence: Licence | null = null;
  const open = async (m: PlaygroundModel) => {
    const label = m.name || "the model";
    empty.hidden = true;
    try {
      const buf = m.buf ?? (await fetchWithProgress(m.url ?? "", label));
      const json = glbJson(buf);
      if (json === null) throw new Error("That isn't a .vrm or .glb file.");
      licence = licenceOf(json);
      loadText.textContent = "Fitting her body to " + label;
      if (blobUrl !== null) URL.revokeObjectURL(blobUrl);
      blobUrl = URL.createObjectURL(new Blob([buf], { type: "model/gltf-binary" }));
      if (stages.length === 0) addStage();
      await Promise.all(
        stages.map(
          (s) =>
            new Promise<void>((res) => {
              s.loaded = res;
              setTimeout(res, 20_000);
              s.body?.cue({ kind: "model", persona: "viewer", url: blobUrl! });
            }),
        ),
      );
      model = m;
      pose = {};
      faceW = {};
      morphW = {};
      title.textContent = label;
      subtitle.textContent = m.why ?? "";
      if (m.from !== "file" && m.url !== undefined) store.set(LAST, m.id ?? m.url);
      setBar(1);
      setTimeout(() => {
        load.hidden = true;
        setBar(0);
      }, 250);
      hooks.onModel?.(m, json, buf);
      record("model.opened", m.id ?? m.from, { from: m.from });
      render();
      return true;
    } catch (err) {
      load.hidden = true;
      note((err as Error).message);
      return false;
    }
  };
  const openFile = async (f: File) => {
    if (!/\.(vrm|glb)$/i.test(f.name)) return note("Drop a .vrm or .glb file.");
    await open({
      name: f.name.replace(/\.\w+$/, ""),
      buf: await f.arrayBuffer(),
      from: "file",
      why: "From a file, not kept",
    });
  };
  file.onchange = () => {
    const f = file.files?.[0];
    if (f) void openFile(f);
    file.value = "";
  };
  let depth = 0;
  const onDragEnter = (e: DragEvent) => {
    e.preventDefault();
    depth++;
    drop.hidden = false;
  };
  const onDragLeave = () => {
    if (--depth <= 0) {
      depth = 0;
      drop.hidden = true;
    }
  };
  const onDragOver = (e: DragEvent) => e.preventDefault();
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    depth = 0;
    drop.hidden = true;
    const f = e.dataTransfer?.files[0];
    if (f) void openFile(f);
  };
  addEventListener("dragenter", onDragEnter);
  addEventListener("dragleave", onDragLeave);
  addEventListener("dragover", onDragOver);
  addEventListener("drop", onDrop);

  const setFrame = (f: "bust" | "body") => {
    framing = f;
    for (const s of stages) s.body?.frame(f);
    for (const b of frames.children)
      pressed(b as HTMLElement, (b as HTMLElement).dataset["frame"] === f);
  };
  for (const [f, word, tip] of [
    ["bust", "Close", "Face and shoulders (F)"],
    ["body", "Whole", "All of her (B)"],
  ] as const) {
    const b = btn(
      word,
      null,
      () => {
        setFrame(f);
        record("camera", f);
      },
      tip,
    );
    b.dataset["frame"] = f;
    frames.append(pressed(b, f === framing));
  }
  for (const [yaw, word] of [
    [-0.9, "Right"],
    [0, "Front"],
    [0.9, "Left"],
  ] as const) {
    const b = btn(word, null, () => {
      for (const s of stages) s.body?.orbit(yaw);
      for (const x of orbits.children) pressed(x as HTMLElement, x === b);
      record("camera", "orbit " + yaw);
    });
    orbits.append(pressed(b, yaw === 0));
  }

  let lastMove: unknown = null;
  const summary = (m: Move) => {
    const p: string[] = [];
    if (typeof m["act"] === "string") p.push(ACT_WORDS[m["act"]] ?? m["act"]);
    if (typeof m["gesture"] === "string") p.push(human(m["gesture"]));
    if (typeof m["posture"] === "string") p.push(human(m["posture"]));
    if (m["mood"]) p.push(human(String((m["mood"] as Move)["name"])) + " face");
    if (m["perform"]) p.push("a whole-body performance");
    if (m["look"]) p.push("a look");
    if (Array.isArray(m["then"])) p.push(`then ${m["then"].length} more`);
    return p.join(", ") || "a move";
  };
  dirForm.onsubmit = async (e) => {
    e.preventDefault();
    const text = dir.value.trim();
    if (!text || hooks.direct === undefined) return;
    dirGo.disabled = true;
    said.textContent = "Working out how her body does that...";
    try {
      const r = await hooks.direct(text);
      if (play(r.move, "direction")) {
        said.textContent =
          (r.by === "nearest act" ? "Nearest act: " : "Composed: ") + summary(r.move as Move);
        lastMove = r.move;
        if (tab === "move") render("move");
      }
    } catch (err) {
      said.textContent = (err as Error).message;
    }
    dirGo.disabled = false;
  };

  let tab = "move";
  let pose: Record<string, number[]> = {};
  let faceW: Record<string, number> = {};
  let morphW: Record<string, number> = {};
  let scene: SceneDraft | null = null;
  let beatAt = -1;
  let playing: number[] | null = null;
  let showBody = "her";
  const first = () => stages[0]?.body ?? null;
  const manifest = () => (first()?.state().manifest ?? null) as RigManifest | null;
  const pane = (name: string) => {
    const p = rail.querySelector<HTMLElement>(`[data-pane="${name}"]`)!;
    p.replaceChildren();
    return p;
  };

  const renderMove = () => {
    const p = pane("move");
    const a = sec("Do something");
    const chips = el("div", "chips");
    for (const act of T.ACT_NAMES)
      chips.append(btn(ACT_WORDS[act] ?? human(act), null, () => play({ act }, act)));
    a.append(chips);
    p.append(a);
    const m = sec("Feel");
    const moods = el("div", "chips");
    for (const mood of MOODS)
      moods.append(
        btn(human(mood), null, () =>
          play({ mood: { name: mood, intensity: 0.75 } }, "mood " + mood),
        ),
      );
    m.append(moods);
    p.append(m);
    const inv = sec("On its own");
    inv.append(
      el(
        "p",
        "sub",
        "What her body does by itself. Some she can hold back for a while, the way a person can; reflexes she can't.",
      ),
    );
    const list = el("div", "list");
    const live = first()?.state().involuntary ?? {};
    for (const s of T.INVOLUNTARY) {
      const w = SYSTEM_WORDS[s.id] ?? [human(s.id), ""];
      const row = el("div", "item");
      const on = live[s.id]?.on !== false;
      const txt = el("div", "grow");
      txt.append(el("div", null, w[0]), el("div", "sub", w[1]));
      row.append(el("span", "dot" + (on ? " on" : "")), txt);
      if (s.override.allowed && s.override.maxHoldMs > 0) {
        const secs = Math.round(Math.min(5000, s.override.maxHoldMs) / 1000);
        row.append(
          btn(`Hold ${secs} s`, "btn", () =>
            play({ hold: { [s.id]: secs * 1000 } }, "hold " + s.id),
          ),
        );
      } else row.append(el("span", "sub", "can't hold"));
      list.append(row);
    }
    inv.append(list);
    p.append(inv);
    const adv = el("details");
    adv.append(el("summary", null, "More: write a move by hand"));
    const ta = el("textarea");
    ta.value = JSON.stringify(
      lastMove ?? {
        perform: {
          feel: { valence: 0.6, arousal: 0.5, dominance: 0.1 },
          hands: { left: "heart" },
        },
      },
      null,
      1,
    );
    ta.setAttribute("aria-label", "Body move as JSON");
    adv.append(
      el(
        "p",
        "sub",
        "The same language agents use (tessaya_body_move): act, posture, gesture, mood, look, face, morphs, bones, keys, perform, hold, then.",
      ),
      ta,
      btn("Run it", "btn primary", () => {
        try {
          play(JSON.parse(ta.value), "hand-written");
        } catch {
          note("That isn't valid JSON yet.");
        }
      }),
    );
    p.append(adv);
    const ag = sec("Agents");
    ag.append(
      el(
        "p",
        "sub",
        `Any agent connected to this server drives these stages with tessaya_body_move, tessaya_body_scene and tessaya_body_state, target "playground": ${stages.map((s) => s.bus).join(" and ") || "…"}. Nothing here reaches her desk.`,
      ),
    );
    p.append(ag);
  };

  const reachOf = (bone: string, axis: number): readonly [number, number] => {
    const lim = T.JOINT_LIMITS[bone];
    if (!lim) return [-Math.PI, Math.PI];
    const unit = [0, 0, 0];
    unit[axis] = 1;
    for (const [v, r] of [
      [lim.axis, lim.twist],
      [lim.u, lim.uRange],
      [lim.v, lim.vRange],
    ] as const) {
      const d = v[0] * unit[0]! + v[1] * unit[1]! + v[2] * unit[2]!;
      if (Math.abs(d) > 0.7) return d > 0 ? r : [-r[1], -r[0]];
    }
    return [-Math.PI, Math.PI];
  };
  const slider = (
    label: string,
    value: number,
    min: number,
    max: number,
    reach: readonly [number, number] | null,
    onInput: (x: number) => void,
    onDone: (x: number) => void,
    angle = true,
  ) => {
    const row = el("div", "sl");
    const id = "s" + rand();
    const l = el("label", null, label);
    l.htmlFor = id;
    const tr = el("div", "track");
    const out = el("output", null, angle ? deg(value) : "");
    if (reach) {
      const band = el("i", "reach");
      band.style.left = ((reach[0] - min) / (max - min)) * 100 + "%";
      band.style.width = ((reach[1] - reach[0]) / (max - min)) * 100 + "%";
      band.title = `A person reaches ${deg(reach[0])} to ${deg(reach[1])}`;
      tr.append(band);
    }
    const r = el("input");
    r.type = "range";
    r.id = id;
    r.min = String(min);
    r.max = String(max);
    r.step = "0.01";
    r.value = String(value);
    r.oninput = () => {
      if (angle) out.textContent = deg(Number(r.value));
      onInput(Number(r.value));
    };
    r.onchange = () => onDone(Number(r.value));
    tr.append(r);
    row.append(l, tr, out);
    return row;
  };
  let poseTimer = 0;
  const sendPose = () => {
    clearTimeout(poseTimer);
    poseTimer = window.setTimeout(() => {
      for (const c of T.moveCues({ bones: pose, ms: 250 } as never, "pg-pose")) cue(c);
    }, 30);
  };
  const issues = () => first()?.rig().issues ?? [];
  const renderPose = () => {
    const p = pane("pose");
    const have = new Set(manifest()?.humanoid ?? Object.keys(T.JOINT_LIMITS));
    const head = sec(
      "Pose her by hand",
      btn(
        "Let her go",
        "btn act",
        () => {
          pose = {};
          play({ release: true }, "release");
          render("pose");
        },
        "Hand her body back to her own feelings (R)",
      ),
    );
    head.append(
      el(
        "p",
        "sub",
        "Each slider turns one joint. The shaded band is how far a person's joint reaches; past it, her body keeps the pose inside and tells you below.",
      ),
    );
    p.append(head);
    const fixed = issues();
    if (fixed.length) {
      const w = sec("Kept inside a person's reach");
      for (const i of fixed.slice(0, 8))
        w.append(
          el(
            "p",
            "warn",
            `${boneWord(i.bone)}: ${ISSUE_WORDS[i.kind] ?? "corrected"}${i.by ? " by " + deg(i.by) : ""}`,
          ),
        );
      p.append(w);
    }
    for (const [name, re] of REGION) {
      const bones = Object.keys(T.JOINT_LIMITS).filter((b) => re.test(b) && have.has(b));
      if (!bones.length) continue;
      const d = el("details");
      d.open = name === "Head and neck" || name === "Left arm";
      d.append(el("summary", null, `${name} · ${bones.length}`));
      for (const b of bones) {
        d.append(el("h3", null, boneWord(b)));
        const e = pose[b] ?? [0, 0, 0];
        for (let i = 0; i < 3; i++)
          d.append(
            slider(
              AXIS_WORDS[i]!,
              e[i] ?? 0,
              -3.14,
              3.14,
              reachOf(b, i),
              (x) => {
                const next = (pose[b] ?? [0, 0, 0]).slice();
                next[i] = x;
                pose[b] = next;
                sendPose();
              },
              () => record("pose.bone", b),
            ),
          );
      }
      p.append(d);
    }
    const s = sec("Keep it");
    s.append(
      btn(
        "Add as a scene beat",
        "btn",
        () => {
          addBeat();
          showTab("scenes");
        },
        "Record this pose as the next beat (K)",
      ),
    );
    p.append(s);
  };

  const renderFace = () => {
    const p = pane("face");
    const morphs = manifest()?.morphs ?? [];
    const e = sec(
      "Expressions",
      btn("Clear", "btn act", () => {
        faceW = {};
        morphW = Object.fromEntries(Object.keys(morphW).map((k) => [k, 0]));
        cue({ kind: "morphs", weights: morphW });
        cue({ kind: "face", weights: {}, ms: 1 });
        render("face");
      }),
    );
    for (const n of Object.keys(PRESET_WORDS))
      e.append(
        slider(
          PRESET_WORDS[n]!,
          faceW[n] ?? 0,
          0,
          1,
          null,
          (w) => {
            faceW[n] = w;
            cue({ kind: "face", weights: faceW, ms: 20_000 });
          },
          () => record("face", n),
          false,
        ),
      );
    p.append(e);
    const s = sec("Shape keys", el("span", "act", `${morphs.length} on this model`));
    if (!morphs.length) s.append(el("p", "sub", "This model has no shape keys of its own."));
    else {
      const q = el("input");
      q.type = "search";
      q.placeholder = "Find a shape key";
      q.setAttribute("aria-label", "Find a shape key");
      const list = el("div");
      const draw = () => {
        list.replaceChildren();
        const f = q.value.toLowerCase();
        for (const n of morphs.filter((x) => x.toLowerCase().includes(f)).slice(0, 60)) {
          const row = slider(
            human(n.replace(/^Fcl_/, "")),
            morphW[n] ?? 0,
            0,
            1,
            null,
            (w) => {
              morphW[n] = w;
              cue({ kind: "morphs", weights: { [n]: w } });
            },
            () => record("morph", n),
            false,
          );
          row.title = n;
          list.append(row);
        }
      };
      q.oninput = draw;
      s.append(q, list);
      draw();
    }
    p.append(s);
  };

  const newScene = (): SceneDraft => ({
    version: 2,
    id: "mine",
    title: "My scene",
    bodies: ["her"],
    beats: [],
  });
  const sceneLength = () =>
    scene && scene.beats.length ? scene.beats[scene.beats.length - 1]!.atMs + 1500 : 0;
  const addBeat = () => {
    scene ??= newScene();
    const at = scene.beats.length ? scene.beats[scene.beats.length - 1]!.atMs + 1500 : 0;
    const bones = Object.keys(pose).length
      ? pose
      : Object.fromEntries(
          Object.entries(first()?.state().bones ?? {}).filter(([k]) => T.JOINT_LIMITS[k]),
        );
    scene.beats.push({
      atMs: at,
      label: `Pose ${scene.beats.length + 1}`,
      move: { bones: structuredClone(bones), ms: 600 },
    });
    beatAt = scene.beats.length - 1;
    record("scene.beat.added", scene.id, { beats: scene.beats.length });
    note(`Added beat ${scene.beats.length}.`);
  };
  const goBeat = (i: number) => {
    const b = scene?.beats[i];
    if (!b) return;
    beatAt = i;
    const d = T.decodeBodyMove(b.move);
    if (d.ok) for (const c of T.moveCues(d.move, "beat")) cue(c);
    drawTimeline();
  };
  const stopScene = () => {
    if (playing) for (const t of playing) clearTimeout(t);
    playing = null;
  };
  const playScene = () => {
    if (!scene) return;
    const d = T.decodeScene(scene);
    if (!d.ok) {
      note("The scene has problems: see Check.");
      return;
    }
    stopScene();
    playing = d.scene.beats.map((b, i) =>
      window.setTimeout(() => {
        beatAt = i;
        drawTimeline();
      }, b.atMs),
    );
    playing.push(
      window.setTimeout(() => {
        playing = null;
        drawTimeline();
      }, sceneLength()),
    );
    for (const c of T.sceneCues(d.scene, showBody)) cue(c);
    record("scene.played", scene.id, { beats: scene.beats.length });
    drawTimeline();
  };
  let tl: HTMLElement | null = null;
  let scrub: HTMLInputElement | null = null;
  let playBtn: HTMLButtonElement | null = null;
  const drawTimeline = () => {
    if (playBtn) playBtn.textContent = playing ? "Stop" : "Play";
    if (!tl) return;
    tl.replaceChildren();
    const len = Math.max(1, sceneLength());
    (scene?.beats ?? []).forEach((b, i) => {
      const m = el("button", "beat");
      m.type = "button";
      m.style.left = (b.atMs / len) * 100 + "%";
      m.title = `${b.label ?? "Beat " + (i + 1)} at ${(b.atMs / 1000).toFixed(1)} s`;
      m.setAttribute("aria-label", m.title);
      if (i === beatAt) m.setAttribute("aria-current", "true");
      m.onclick = () => goBeat(i);
      tl!.append(m);
    });
    const cur = scene?.beats[beatAt];
    if (cur) {
      const h = el("i", "head");
      h.style.left = (cur.atMs / len) * 100 + "%";
      tl.append(h);
    }
    if (scrub) {
      scrub.max = String(len);
      scrub.value = String(cur?.atMs ?? 0);
    }
  };
  const renderScenes = () => {
    const p = pane("scenes");
    const from = sec("Start from");
    const chips = el("div", "chips");
    for (const name of Object.keys(T.CORE_SCENES))
      chips.append(
        btn(human(name), null, () => {
          scene = structuredClone(T.CORE_SCENES[name]) as SceneDraft;
          beatAt = -1;
          render("scenes");
          record("scene.opened", name);
        }),
      );
    chips.append(
      btn("New, empty", null, () => {
        scene = newScene();
        beatAt = -1;
        render("scenes");
      }),
    );
    from.append(chips);
    p.append(from);
    const s = sec(
      scene ? (scene.title ?? "Scene") : "No scene open",
      scene
        ? el("span", "act", `${scene.beats.length} beats · ${(sceneLength() / 1000).toFixed(1)} s`)
        : null,
    );
    tl = null;
    scrub = null;
    playBtn = null;
    if (scene) {
      const sc = scene;
      const controls = el("div", "row");
      playBtn = btn(
        playing ? "Stop" : "Play",
        "btn primary",
        () => {
          if (playing) {
            stopScene();
            drawTimeline();
          } else playScene();
        },
        "Play or stop (Space)",
      );
      controls.append(
        playBtn,
        btn("Back", "btn", () => goBeat(Math.max(0, beatAt - 1)), "Previous beat (←)"),
        btn(
          "Next",
          "btn",
          () => goBeat(Math.min(sc.beats.length - 1, beatAt + 1)),
          "Next beat (→)",
        ),
        btn(
          "Add this pose",
          "btn",
          () => {
            addBeat();
            render("scenes");
          },
          "Record the pose as a beat (K)",
        ),
      );
      tl = el("div", "tl");
      scrub = el("input", "scrub");
      scrub.type = "range";
      scrub.min = "0";
      scrub.step = "10";
      scrub.setAttribute("aria-label", "Scrub through the scene");
      const sr = scrub;
      sr.oninput = () => {
        const d = T.decodeScene(sc);
        if (!d.ok) return;
        const at = T.poseAt(d.scene, Number(sr.value), showBody);
        if (Object.keys(at.bones).length)
          for (const c of T.moveCues({ bones: at.bones, ms: 60 } as never, "scrub")) cue(c);
        if (at.beat !== beatAt && at.beat >= 0) {
          beatAt = at.beat;
          const m = sc.beats[at.beat]!.move;
          if (!m["bones"] && !m["keys"]) {
            const x = T.decodeBodyMove(m);
            if (x.ok) for (const c of T.moveCues(x.move, "beat")) cue(c);
          }
          drawTimeline();
        }
      };
      sr.onchange = () => record("scene.scrub", sc.id, { ms: Number(sr.value) });
      s.append(controls, tl, sr);
      const list = el("div", "list");
      sc.beats.forEach((b, i) => {
        const row = el("div", "item");
        const name = el("input");
        name.type = "text";
        name.value = b.label ?? `Beat ${i + 1}`;
        name.setAttribute("aria-label", "Beat name");
        name.onchange = () => {
          b.label = name.value;
          drawTimeline();
        };
        const at = el("input");
        at.type = "text";
        at.value = (b.atMs / 1000).toFixed(1);
        at.style.width = "56px";
        at.setAttribute("aria-label", "Seconds from the start");
        at.onchange = () => {
          b.atMs = Math.max(0, Math.round(Number(at.value) * 1000) || 0);
          sc.beats.sort((x, y) => x.atMs - y.atMs);
          render("scenes");
        };
        row.append(
          name,
          at,
          el("span", "sub", "s"),
          btn(
            "×",
            "btn",
            () => {
              sc.beats.splice(i, 1);
              render("scenes");
            },
            "Remove this beat",
          ),
        );
        list.append(row);
      });
      s.append(list);
      if ((sc.bodies ?? []).length > 1) {
        const pick = el("select");
        pick.setAttribute("aria-label", "Which body this page shows");
        for (const b of sc.bodies!) {
          const o = el("option", null, "This page shows: " + human(b));
          o.value = b;
          o.selected = b === showBody;
          pick.append(o);
        }
        pick.onchange = () => {
          showBody = pick.value;
        };
        s.append(pick);
      }
      if ((sc.branches ?? []).length) {
        const bl = el("div", "list");
        bl.append(el("h2", null, "When something happens"));
        for (const br of sc.branches!) {
          const row = el("div", "item");
          const t = el("div", "grow");
          t.append(
            el("div", null, human(br.id)),
            el(
              "div",
              "sub",
              `${br.beats.length} beats, then ${br.after === "end" ? "it ends" : "it carries on"}`,
            ),
          );
          row.append(
            t,
            btn(
              "Try it",
              "btn",
              () => {
                const d = T.decodeScene(sc);
                if (!d.ok) return note("The scene has problems: see Check.");
                const b = d.scene.branches.find((x) => x.id === br.id);
                if (b) for (const c of T.sceneCues(d.scene, showBody, b.beats)) cue(c);
                record("scene.branch", sc.id, { branch: br.id });
              },
              "Play what happens then",
            ),
          );
          bl.append(row);
        }
        s.append(bl);
      }
      const adv = el("details");
      adv.append(el("summary", null, "More: the scene as data"));
      const ta = el("textarea");
      ta.value = JSON.stringify(sc, null, 1);
      ta.setAttribute("aria-label", "Scene JSON");
      adv.append(
        ta,
        btn("Use this", "btn", () => {
          try {
            scene = JSON.parse(ta.value) as SceneDraft;
            render("scenes");
          } catch {
            note("That isn't valid JSON yet.");
          }
        }),
        btn("Copy", "btn", () => {
          void navigator.clipboard?.writeText(JSON.stringify(sc, null, 1));
          note("Copied.");
        }),
      );
      s.append(adv);
    } else
      s.append(
        el("p", "sub", "Open a scene above, or pose her and press Add this pose to start one."),
      );
    p.append(s);
    drawTimeline();
  };

  const renderBody = () => {
    const p = pane("body");
    const st = first()?.state() ?? null;
    const man = manifest();
    const c = sec("What this body can do");
    if (!man || !st) c.append(el("p", "sub", "Open a model to see what its body can do."));
    else {
      const kv = el("dl", "kv");
      const add = (k: string, v: string) => kv.append(el("dt", null, k), el("dd", null, v));
      add("Rig", human(man.tier));
      add(
        "Body bones",
        `${man.humanoid.length}${man.missing.length ? `, ${man.missing.length} optional missing` : ""}`,
      );
      add("Spine", `${man.spineSegments} segments, neck ${man.neckSegments}`);
      add("Fingers", { none: "None", partial: "Some", full: "All" }[man.fingers]);
      add(
        "Eyes, jaw, toes",
        [man.eyes ? "eyes" : "", man.jaw ? "jaw" : "", man.toes ? "toes" : ""]
          .filter(Boolean)
          .join(", ") || "none",
      );
      add("Rest pose", man.armRestDrop > 0.05 ? "A-pose, corrected" : "T-pose");
      add("Expressions", String(man.expressions.length));
      add("Shape keys", String(man.morphs.length));
      add("Spring chains", String(man.springChains));
      add("Posture now", human(st.posture));
      add("Moving", st.moving ? "yes" : "at rest");
      c.append(kv);
      const adv = el("details");
      const ta = el("textarea");
      ta.value = JSON.stringify(man, null, 1);
      ta.readOnly = true;
      adv.append(el("summary", null, "More: the full manifest"), ta);
      c.append(adv);
    }
    p.append(c);
    const contacts = st?.contacts ?? [];
    const d = sec("Contacts");
    d.append(
      el(
        "p",
        "sub",
        contacts.length
          ? `${contacts.length} now: ${contacts
              .slice(0, 4)
              .map((x) => `${human(x.part)} on ${human(x.with)}`)
              .join(", ")}`
          : "No parts touching each other now.",
      ),
    );
    p.append(d);
  };

  const renderCheck = () => {
    const p = pane("check");
    let problems = 0;
    const lic = sec("This model's licence");
    if (licence === null)
      lic.append(
        el(
          "p",
          "sub",
          model ? "This file doesn't state a licence." : "Open a model to read its licence.",
        ),
      );
    else {
      const kv = el("dl", "kv");
      for (const [k, f] of [
        ["Title", "title"],
        ["Author", "author"],
        ["Who may use it", "who"],
        ["Changes", "changes"],
        ["Redistribution", "redistribution"],
        ["Commercial use", "commercial"],
      ] as const)
        kv.append(el("dt", null, k), el("dd", null, licence[f] ?? "Not stated"));
      lic.append(kv);
    }
    p.append(lic);
    const fixed = issues();
    const r = sec(
      "Her pose",
      el("span", "act", fixed.length ? `${fixed.length} kept inside` : "fine"),
    );
    r.append(
      el(
        "p",
        "sub",
        fixed.length
          ? "The body kept these joints inside a person's reach:"
          : "Nothing in her pose needed correcting.",
      ),
    );
    for (const i of fixed.slice(0, 12))
      r.append(
        el(
          "p",
          "warn",
          `${boneWord(i.bone)}: ${ISSUE_WORDS[i.kind] ?? "corrected"}${i.by ? " by " + deg(i.by) : ""}`,
        ),
      );
    p.append(r);
    if (scene) {
      const d = T.decodeScene(scene);
      const s = sec(
        "The open scene",
        el("span", "act", d.ok ? "fine" : `${d.errors.length} to fix`),
      );
      if (d.ok) {
        const dry = T.dryRun(d.scene, T.REFERENCE_RIG);
        s.append(
          el(
            "p",
            "sub",
            dry.length
              ? `${dry.length} beats would be corrected when played:`
              : "Every beat plays as written.",
          ),
        );
        for (const x of dry.slice(0, 8))
          s.append(
            el("p", "warn", `${x.label}: ${x.corrected.map((c) => boneWord(c.bone)).join(", ")}`),
          );
      } else
        for (const e of d.errors) {
          problems++;
          const row = el("div", "item");
          const t = el("div", "grow");
          t.append(el("div", null, `${e.at}: ${e.message}`), el("div", "sub", "Fix: " + e.fix));
          row.append(el("span", "dot bad"), t);
          s.append(row);
        }
      p.append(s);
    }
    const n = tabsEl.querySelector<HTMLElement>('[data-tab="check"]');
    if (n) {
      n.replaceChildren(document.createTextNode("Check"));
      if (problems) n.append(el("span", "n", String(problems)));
    }
  };

  // "Agent drives her": a model drives these stages through the same body tools an outside agent uses.
  const MODELS: ReadonlyArray<readonly [string, string]> = [
    ["haiku", "Haiku"],
    ["sonnet", "Sonnet"],
    ["opus", "Opus"],
    ["brain", "Her own brain"],
  ];
  const agent = {
    models: ["sonnet", "opus"] as string[],
    directions: "",
    alsoHer: false,
    running: false,
    estimate: "",
    results: [] as Array<{
      said: string;
      runs: Array<{
        id: string;
        model: string;
        run: Record<string, unknown> | null;
        rated?: string;
      }>;
    }>,
  };
  let estimateTimer = 0;
  const estimate = () => {
    clearTimeout(estimateTimer);
    estimateTimer = window.setTimeout(async () => {
      const lines = agent.directions.split("\n").filter((l) => l.trim());
      const models = agent.models.slice(0, stages.length);
      if (!lines.length) {
        agent.estimate = "";
        if (tab === "agent") render("agent");
        return;
      }
      try {
        let usd = 0;
        let priced = true;
        for (const m of models)
          for (const said of lines) {
            const r = await post("agent.estimate", { model: m, said });
            if (typeof r["usd"] === "number") usd += r["usd"];
            else priced = false;
          }
        agent.estimate = priced
          ? `About $${usd < 0.01 ? usd.toFixed(4) : usd.toFixed(3)} at list price for ${lines.length * models.length} run${lines.length * models.length === 1 ? "" : "s"}; on your plan it is the plan's equivalent.`
          : "The price list doesn't know one of these models.";
      } catch (err) {
        agent.estimate = (err as Error).message;
      }
      if (tab === "agent") render("agent");
    }, 400);
  };
  const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
  const runAll = async () => {
    const lines = agent.directions
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .slice(0, 12);
    if (!lines.length || agent.running) return;
    agent.running = true;
    render("agent");
    for (const said of lines) {
      const entry = {
        said,
        runs: [] as Array<{
          id: string;
          model: string;
          run: Record<string, unknown> | null;
          rated?: string;
        }>,
      };
      agent.results.unshift(entry);
      try {
        for (const [i, s] of stages.entries()) {
          const model = agent.models[i] ?? agent.models[0]!;
          const r = await post("agent.start", { said, model, bus: s.bus, alsoHer: agent.alsoHer });
          entry.runs.push({ id: String(r["id"]), model, run: null });
        }
        record("agent.run", said, { models: entry.runs.map((r) => r.model) });
        // polls only while a run is going
        while (entry.runs.some((r) => r.run?.["done"] !== true)) {
          await sleep(500);
          for (const r of entry.runs)
            if (r.run?.["done"] !== true) r.run = await post("agent.poll", { id: r.id });
          if (tab === "agent") render("agent");
        }
      } catch (err) {
        note(
          (err as Error & { status?: number }).status === 404
            ? "Only you can run agents here: they spend your plan or key."
            : (err as Error).message,
        );
        break;
      }
    }
    agent.running = false;
    render("agent");
  };
  const rate = async (r: { id: string; rated?: string }, good: boolean, text: string) => {
    try {
      const a = await post("agent.rate", { id: r.id, good, note: text });
      r.rated = good ? "Good" : "Bad";
      note(
        a["harvest"] === true
          ? "Kept: it is offered to her motion library."
          : "Kept with your note.",
      );
    } catch (err) {
      note((err as Error).message);
    }
    render("agent");
  };
  const renderAgent = () => {
    const p = pane("agent");
    const pick = sec("Who drives");
    for (const [i, s] of stages.entries()) {
      const sel = el("select");
      sel.setAttribute("aria-label", `Model for ${s.bus}`);
      for (const [id, word] of MODELS) {
        const o = el(
          "option",
          null,
          `${stages.length > 1 ? (i === 0 ? "Left: " : "Right: ") : ""}${word}`,
        );
        o.value = id;
        o.selected = (agent.models[i] ?? agent.models[0]) === id;
        sel.append(o);
      }
      sel.onchange = () => {
        agent.models[i] = sel.value;
        estimate();
      };
      pick.append(sel);
    }
    if (stages.length < 2)
      pick.append(
        btn(
          "Compare two models",
          "btn",
          () => compare(true),
          "A second stage for a second model (C)",
        ),
      );
    p.append(pick);
    const d = sec("Directions");
    const ta = el("textarea");
    ta.placeholder = "One per line: shrug like you don't know\nact like you just heard great news";
    ta.value = agent.directions;
    ta.setAttribute("aria-label", "Directions, one per line");
    ta.oninput = () => {
      agent.directions = ta.value;
      estimate();
    };
    const also = el("label", "row");
    const cb = el("input");
    cb.type = "checkbox";
    cb.checked = agent.alsoHer;
    cb.onchange = () => {
      agent.alsoHer = cb.checked;
    };
    also.append(
      cb,
      el("span", "grow", "Also on her desk body (waits while a conversation you are in has her)"),
    );
    const go = btn(agent.running ? "Running…" : "Run", "btn primary", () => void runAll());
    go.disabled = agent.running || !agent.directions.trim();
    d.append(ta, also, el("p", "sub", agent.estimate || "Nothing runs until you press Run."), go);
    p.append(d);
    for (const e of agent.results.slice(0, 12)) {
      const s = sec(e.said);
      for (const r of e.runs) {
        const run = r.run as
          | (Record<string, unknown> & {
              calls?: Array<Record<string, unknown>>;
              graded?: Record<string, unknown> | null;
            })
          | null;
        const head = el("h3", null, MODELS.find(([id]) => id === r.model)?.[1] ?? r.model);
        s.append(head);
        for (const c of run?.calls ?? [])
          s.append(
            el(
              "p",
              c["ok"] ? "sub" : "warn",
              `${((c["atMs"] as number) / 1000).toFixed(1)} s · ${String(c["name"]).replace("tessaya_body_", "")}${c["ok"] ? "" : ": " + String(c["said"])}`,
            ),
          );
        if (run?.["done"] !== true) {
          s.append(el("p", "sub", "Running…"));
          continue;
        }
        if (run["error"]) s.append(el("p", "warn", String(run["error"])));
        const g = run.graded;
        const kv = el("dl", "kv");
        const add = (k: string, v: string) => kv.append(el("dt", null, k), el("dd", null, v));
        add(
          "First motion",
          run["firstMotionMs"] == null ? "never moved" : `${run["firstMotionMs"]} ms`,
        );
        add("Whole run", `${((run["ms"] as number) / 1000).toFixed(1)} s`);
        if (g) {
          add("Channels", (g["channels"] as string[]).join(", ") || "none");
          add("Kept inside reach", String(g["corrections"]));
          add("Too fast", (g["overSpeed"] as string[]).join(", ") || "none");
          if ((g["errors"] as string[]).length) add("Errors", (g["errors"] as string[]).join("; "));
        }
        s.append(kv);
        if (run["reasoning"]) s.append(el("p", "sub", String(run["reasoning"])));
        if (r.rated) s.append(el("p", "sub", `Rated ${r.rated}.`));
        else {
          const why = el("input");
          why.type = "text";
          why.placeholder = "A note: what was right or wrong";
          why.setAttribute("aria-label", "A note on this run");
          const row = el("div", "row");
          row.append(
            btn("Good", "btn", () => void rate(r, true, why.value)),
            btn("Bad", "btn", () => void rate(r, false, why.value)),
          );
          s.append(why, row);
        }
      }
      p.append(s);
    }
  };

  const own: Record<string, () => void> = {
    move: renderMove,
    pose: renderPose,
    face: renderFace,
    scenes: renderScenes,
    check: renderCheck,
    body: renderBody,
    agent: renderAgent,
  };
  const TABS: ReadonlyArray<readonly [string, string]> = [
    ["move", "Move"],
    ["pose", "Pose"],
    ["face", "Face"],
    ["scenes", "Scenes"],
    ["check", "Check"],
    ["body", "Body"],
    ["agent", "Agent"],
    ...(hooks.tabs ?? []).map((t) => [t.id, t.label] as const),
  ];
  for (const [id, label] of TABS) {
    const b = el("button", null, label);
    b.type = "button";
    b.dataset["tab"] = id;
    b.setAttribute("role", "tab");
    b.onclick = () => showTab(id);
    tabsEl.append(b);
    const p = el("div", "pane");
    p.dataset["pane"] = id;
    p.hidden = true;
    rail.append(p);
  }
  function render(name: string = tab) {
    const mine = own[name];
    if (mine) return mine();
    const t = hooks.tabs?.find((x) => x.id === name);
    if (t) t.render(pane(name), pg);
  }
  function showTab(name: string) {
    tab = name;
    for (const b of tabsEl.children)
      b.setAttribute("aria-selected", String((b as HTMLElement).dataset["tab"] === name));
    for (const p of rail.querySelectorAll<HTMLElement>(".pane"))
      p.hidden = p.dataset["pane"] !== name;
    render(name);
  }

  const KEYS: ReadonlyArray<readonly [string, string]> = [
    ...(hooks.direct ? ([["/", "Tell her body what to do"]] as const) : []),
    ["1 to 9", "Sections"],
    ["H", "Hide or show the controls"],
    ["C", "Compare: two stages"],
    ["F / B", "Close or whole body"],
    ["R", "Let her go (release the pose)"],
    ["K", "Add the pose as a scene beat"],
    ["Space", "Play or stop the scene"],
    ["← →", "Step through beats"],
    ["?", "These shortcuts"],
  ];
  for (const [k, w] of KEYS) keys.append(el("dt", null, k), el("dd", null, w));
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      help(false);
      (document.activeElement as HTMLElement | null)?.blur();
      return;
    }
    const a = document.activeElement?.tagName ?? "";
    if (/INPUT|SELECT|TEXTAREA/.test(a) || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (k === "/" && hooks.direct) {
      e.preventDefault();
      dir.focus();
    } else if (k === "?") help(helpEl.hidden !== false);
    else if (/^[1-9]$/.test(k)) {
      const b = tabsEl.children[Number(k) - 1] as HTMLElement | undefined;
      if (b) showTab(b.dataset["tab"]!);
    } else if (k === "h") setFold(!root.classList.contains("full"));
    else if (k === "c") compare(stages.length < 2);
    else if (k === "f") setFrame("bust");
    else if (k === "b") setFrame("body");
    else if (k === "r") {
      pose = {};
      play({ release: true }, "release");
      if (tab === "pose") render("pose");
    } else if (k === "k") {
      addBeat();
      if (tab === "scenes") render("scenes");
    } else if (k === " " && scene) {
      e.preventDefault();
      if (playing) {
        stopScene();
        drawTimeline();
      } else playScene();
    } else if (k === "arrowright" && scene) goBeat(Math.min(scene.beats.length - 1, beatAt + 1));
    else if (k === "arrowleft" && scene) goBeat(Math.max(0, beatAt - 1));
  };
  addEventListener("keydown", onKey);

  const pg: Playground = {
    control: T,
    body: first,
    stage: () => stagesEl,
    cue,
    play,
    open,
    note,
    render: (name) => render(name),
    record,
    buses: () => stages.map((s) => s.bus),
    playOn,
    compare,
    frame: setFrame,
    title: (name, why) => {
      title.textContent = name;
      if (why !== undefined) subtitle.textContent = why;
    },
  };

  addStage();
  stages[0]!.root.append(load, drop, empty, fold, cam, direct);
  showTab("move");
  void (async () => {
    const hello = hooks.models
      ? { models: await hooks.models().catch(() => []) }
      : await post("hello", {})
          .then((r) => ({ models: (r["models"] as PlaygroundModel[]) ?? [] }))
          .catch(() => ({ models: [] as PlaygroundModel[] }));
    for (const m of modelOrder(hello.models, store.get(LAST))) if (await open(m)) return;
    title.textContent = "Body playground";
    subtitle.textContent = "No model yet";
    empty.replaceChildren(
      el("p", null, "Drop a .vrm or .glb here, or open one, to give the playground a body."),
    );
    empty.hidden = false;
  })();
  return pg;
}

window.tessayaPlayground = { mount: mountPlayground };

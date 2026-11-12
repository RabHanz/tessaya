// @effect-diagnostics nodeBuiltinImport:off
/**
 * Her face in the pill: the Character Studio's rig, cropped to her body, in place of the mark while he talks to her.
 * The studio's scripts are read from the app's companion folder and run in the pill's page the first time the face is
 * wanted, so a pill that never shows it never loads them.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

const STUDIO = ["rig.js", "bodies.js", "props.js", "speech.js"];

/** The studio's scripts, or null when they are missing (the mark stays). */
export const studioScripts = (companionDir: string): string | null => {
  try {
    return STUDIO.map((name) =>
      NodeFS.readFileSync(NodePath.join(companionDir, name), "utf8"),
    ).join(";\n");
  } catch {
    return null;
  }
};

/** Runs once in the pill's page after the studio's scripts; `window.pillFace` is what the main process drives. */
export const PILL_FACE_SCRIPT = String.raw`(() => {
 if (window.pillFace) return;
 const style = document.createElement("style");
 style.textContent = "#mk.face{width:22px;height:17px}#mk.face svg{display:block;width:100%;height:100%;overflow:hidden}";
 document.head.append(style);
 const mk = document.getElementById("mk"), mark = mk.innerHTML, BOX = "-86 -26 172 140";
 let rig = null, persona = "", level = 0, peak = 0.02, speaking = false;
 // The pill hears her voice's level in dBFS while she speaks (and his while he talks); the mouth reads hers only.
 window.pillIpc.onLevel((db) => { const v = Math.pow(10, db / 20); level = v; peak = Math.max(v, peak * 0.995); });
 const mouth = () => {
  const open = level < peak * 0.08 ? 0 : Math.min(1, Math.pow(level / (peak * 0.85), 0.7));
  return { open, shape: open < 0.08 ? "mbp" : open > 0.6 ? "aa" : open > 0.3 ? "oh" : "ee" };
 };
 const forever = { words: [], syl: [], events: [], vis: [], end: 1e9 };
 window.pillFace = {
  show(p) {
   const P = TCS.PERSONAS[p] || TCS.PERSONAS.tessaya;
   if (!rig) {
    mk.innerHTML = '<svg aria-hidden="true"></svg>';
    mk.classList.add("face");
    rig = TCS.create(mk.firstChild, { character: P.character, personality: P.traits, expression: "neutral", quiet: true });
    mk.firstChild.setAttribute("viewBox", BOX);
   } else if (p !== persona) { rig.setCharacter(P.character); rig.setPersonality(P.traits); }
   persona = p;
  },
  hide() {
   if (rig) { rig.destroy(); rig = null; }
   speaking = false;
   if (mk.classList.contains("face")) { mk.classList.remove("face"); mk.innerHTML = mark; }
  },
  cue(c) { if (rig) rig.setExpression(c.expression, { noCut: true }); },
  speak(on) {
   if (!rig || on === speaking) return;
   speaking = on;
   if (on) { peak = 0.02; rig.speak(forever, { mouth }); } else rig.stopSpeech();
  },
 };
})();`;

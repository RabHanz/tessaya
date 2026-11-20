/**
 * Her body on the phone: the one light body renderer (apps/web/src/body/vrmBody.ts) in the Talk tab's WebView. The
 * app sends the model's bytes (it holds the server's credentials; the page holds none) and her cues; the page draws
 * only while the tab shows it, and stops when the app tells it to.
 */
import { mountBody } from "../../../../../web/src/body/vrmBody";

type Incoming =
  | { readonly type: "model"; readonly persona: string; readonly base64: string }
  | { readonly type: "cue"; readonly cue: unknown }
  | { readonly type: "visible"; readonly on: boolean }
  | { readonly type: "inset"; readonly bottom: number };

// every frame the renderer draws, counted for the app's own cost check (talkCost.ts), sent every ten seconds
let frames = 0;
const raf = window.requestAnimationFrame.bind(window);
window.requestAnimationFrame = (cb) => raf((t) => (frames++, cb(t)));
setInterval(() => {
  if (frames > 0) tell({ type: "frames", n: frames });
  frames = 0;
}, 10_000);

const canvas = document.createElement("canvas");
canvas.style.cssText = "position:fixed;inset:0;width:100%;height:100%;touch-action:none";
document.body.append(canvas);
// a phone frames her from mid-thigh up, face in the upper third, turned a little: her face reads on a small screen
const body = mountBody(canvas, { framing: "half" });
body.orbit(0.35);
let whole = false;
const toggle = () => {
  whole = !whole;
  body.frame(whole ? "body" : "half");
};
// a double tap or a pinch shows all of her, and again brings her back close
canvas.addEventListener("dblclick", toggle);
let pinchFrom = 0;
canvas.addEventListener("touchstart", (e) => {
  if (e.touches.length === 2)
    pinchFrom = Math.hypot(
      e.touches[0]!.clientX - e.touches[1]!.clientX,
      e.touches[0]!.clientY - e.touches[1]!.clientY,
    );
});
canvas.addEventListener("touchmove", (e) => {
  if (e.touches.length !== 2 || pinchFrom === 0) return;
  const d = Math.hypot(
    e.touches[0]!.clientX - e.touches[1]!.clientX,
    e.touches[0]!.clientY - e.touches[1]!.clientY,
  );
  if ((d < pinchFrom * 0.7 && !whole) || (d > pinchFrom * 1.4 && whole)) {
    toggle();
    pinchFrom = 0;
  }
});
let shownUrl: string | null = null;
const tell = (data: object) => window.ReactNativeWebView?.postMessage(JSON.stringify(data));

const onMessage = (raw: unknown) => {
  let m: Incoming;
  try {
    m = JSON.parse(String(raw)) as Incoming;
  } catch {
    return;
  }
  if (m.type === "model") {
    const bytes = Uint8Array.from(atob(m.base64), (c) => c.charCodeAt(0));
    if (shownUrl !== null) URL.revokeObjectURL(shownUrl);
    shownUrl = URL.createObjectURL(new Blob([bytes], { type: "model/gltf-binary" }));
    body.cue({ kind: "show" });
    body.cue({ kind: "model", persona: m.persona, url: shownUrl });
  } else if (m.type === "cue") body.cue(m.cue);
  // backgrounded or another tab: the canvas is hidden, so the renderer draws nothing at all
  else if (m.type === "visible") canvas.style.visibility = m.on ? "visible" : "hidden";
  else if (m.type === "inset") body.inset(m.bottom);
};
// iOS posts to window, Android to document
window.addEventListener("message", (e) => onMessage(e.data));
document.addEventListener("message", (e) => onMessage((e as MessageEvent).data));
tell({ type: "ready" });

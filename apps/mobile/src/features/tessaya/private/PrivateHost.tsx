/**
 * Her private layer on the phone (M-133): his step-up, then the layer's own page full screen, incognito. Only the
 * machinery is here. It is covered in the app switcher, closed on background or after idle (telling the layer at once,
 * so her form snaps back), and her voice stays off the loudspeaker unless her brain is sure he is alone.
 */
import { PhoneAudio } from "../../../../modules/t3-phone-audio";
import { Image } from "expo-image";
import { useEffect, useRef, useState } from "react";
import { AppState, Pressable, StatusBar, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

import { AppText as Text } from "../../../components/ui/AppText";
import { UnlockSheet } from "../lock/UnlockSheet";
import { privateSoundAllowed } from "./privateOutput.logic";
import {
  setPrivateShown,
  usePrivateLayer,
  usePrivateShown,
  type LayerAnswer,
} from "./privateLayer";

const IDLE_MS = 5 * 60_000;
const REPORT_MS = 10_000;

/** Same-origin requests from the layer's page carry this phone's token; her sound is gated from here, not the page. */
const pageScript = (token: string) => `(function(){
var T=${JSON.stringify(token)},O=location.origin,sound=false,ctxs=[];
var f=window.fetch;window.fetch=function(i,o){try{var u=new URL(typeof i==="string"?i:i.url,location.href);if(u.origin===O){o=Object.assign({},o||{});var h=new Headers(o.headers||(typeof i!=="string"?i.headers:undefined));if(!h.has("authorization"))h.set("authorization","Bearer "+T);o.headers=h;}}catch(e){}return f.call(this,i,o);};
var op=XMLHttpRequest.prototype.open,sd=XMLHttpRequest.prototype.send;
XMLHttpRequest.prototype.open=function(m,u){try{this.__t3=new URL(u,location.href).origin===O;}catch(e){}return op.apply(this,arguments);};
XMLHttpRequest.prototype.send=function(){if(this.__t3)try{this.setRequestHeader("authorization","Bearer "+T);}catch(e){}return sd.apply(this,arguments);};
var AC=window.AudioContext||window.webkitAudioContext;
if(AC){var W=function(o){var c=new AC(o);ctxs.push(c);if(!sound)c.suspend();return c;};W.prototype=AC.prototype;window.AudioContext=W;window.webkitAudioContext=W;}
document.addEventListener("play",function(e){if(!sound&&e.target)e.target.muted=true;},true);
window.__tessayaSurface="phone";
window.__tessayaSound=function(on){sound=on;document.querySelectorAll("audio,video").forEach(function(m){m.muted=!on;});ctxs.forEach(function(c){on?c.resume():c.suspend();});window.dispatchEvent(new CustomEvent("tessaya-output",{detail:{sound:on}}));};
})();true;`;

export function PrivateHost() {
  const shown = usePrivateShown();
  const layer = usePrivateLayer();
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks once per server whether it has a private layer, so More shows the entry only there
  useEffect(() => {
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- report closes over this server
    void layer.report();
  }, [layer.base, layer.token]);
  // every way out unmounts the flow, so the next open asks again
  return shown ? <PrivateFlow layer={layer} /> : null;
}

function PrivateFlow(props: { readonly layer: ReturnType<typeof usePrivateLayer> }) {
  const { layer } = props;
  const [open, setOpen] = useState(false);
  if (!open)
    return (
      <View className="absolute inset-0 bg-black">
        <UnlockSheet
          title="Private"
          detail="Use Face ID or your PIN. It opens on this phone only, until you close it or put the phone away."
          check={layer.activate}
          onUnlocked={() => setOpen(true)}
          onCancel={() => setPrivateShown(false)}
        />
      </View>
    );
  return <PrivateView layer={layer} />;
}

function PrivateView(props: { readonly layer: ReturnType<typeof usePrivateLayer> }) {
  const { layer } = props;
  const insets = useSafeAreaInsets();
  const view = useRef<WebView<object>>(null);
  const [answer, setAnswer] = useState<LayerAnswer | null>(null);
  const [covered, setCovered] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const touchedAt = useRef(0);
  const close = () => {
    void layer.report(["windowClosed"]);
    setPrivateShown(false);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the app switcher's snapshot and the background are outside React
  useEffect(() => {
    const change = AppState.addEventListener("change", (s) => {
      if (s === "background") close();
      else setCovered(s !== "active");
    });
    const blur = AppState.addEventListener("blur", () => setCovered(true));
    const focus = AppState.addEventListener("focus", () => setCovered(false));
    return () => {
      change.remove();
      blur.remove();
      focus.remove();
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- close only reports and hides
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows who is home and where the sound goes, and the idle clock
  useEffect(() => {
    touchedAt.current = Date.now();
    const tick = async () => {
      if (Date.now() - touchedAt.current > IDLE_MS) return close();
      const next = await layer.report();
      if (next === null) return;
      setAnswer(next);
      const output = PhoneAudio?.getRoute().output ?? null;
      const sound = privateSoundAllowed(output, next.presence);
      view.current?.injectJavaScript(
        `window.__tessayaSound&&window.__tessayaSound(${sound});true;`,
      );
    };
    void tick();
    const timer = setInterval(() => void tick(), REPORT_MS);
    return () => clearInterval(timer);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- one clock while the screen is open
  }, []);
  const page = answer?.page;
  return (
    <View
      className="absolute inset-0 bg-black"
      onTouchStart={() => {
        touchedAt.current = Date.now();
      }}
    >
      <StatusBar hidden />
      {page != null && layer.base !== null && layer.token !== null ? (
        <WebView<object>
          ref={view}
          source={{
            uri: new URL(`${page}/chat?surface=phone`, layer.base).href,
            headers: { authorization: `Bearer ${layer.token}` },
          }}
          incognito
          cacheEnabled={false}
          injectedJavaScriptBeforeContentLoaded={pageScript(layer.token)}
          mediaPlaybackRequiresUserAction={false}
          onLoadEnd={() => setLoaded(true)}
          style={{ flex: 1, backgroundColor: "black" }}
        />
      ) : null}
      {loaded ? null : (
        // her face at once, while the layer's page and her private form come in
        <View pointerEvents="none" className="absolute inset-0 items-center justify-center gap-3">
          <Image
            source={require("../welcome/face-neutral.webp")}
            style={{ width: 160, height: 160 }}
            contentFit="contain"
            accessibilityIgnoresInvertColors
          />
        </View>
      )}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close private"
        onPress={close}
        className="absolute rounded-full bg-white/15 px-4 py-2"
        style={{ top: insets.top + 8, left: insets.left + 16 }}
      >
        <Text className="text-sm text-white">Close</Text>
      </Pressable>
      {covered ? <View className="absolute inset-0 bg-black" /> : null}
    </View>
  );
}

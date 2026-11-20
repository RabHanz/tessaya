/**
 * Talk, the phone's first tab (D-038): she fills the screen, the same body the desk and the web draw (one renderer, in
 * a WebView), with her personas as chips and one button to hold while he speaks. Her answer comes from her brain
 * through the household's environment (M-097), is shown, said in that persona's voice and mouthed by her body. The
 * WebView exists only while the tab shows and the app is in front, so a backgrounded phone renders nothing.
 */
import { useAtomValue } from "@effect/atom-react";
import { useIsFocused } from "@react-navigation/native";
import type { TessayaPersona, TessayaVoiceCallResult } from "@t3tools/tessaya-contracts";
import bodyStreamScript from "@t3tools/mobile-body-stream";
import { lineCues } from "@t3tools/tessaya-shared/bodyCues";
import { phoneManifest } from "@t3tools/tessaya-shared/phoneDevice";
import { modelOrder, type OfferedModel } from "@t3tools/tessaya-shared/playgroundOrder";
import * as Battery from "expo-battery";
import * as Device from "expo-device";
import { createAudioPlayer } from "expo-audio";
import { File, Paths } from "expo-file-system";
import { useEffect, useRef, useState } from "react";
import { AppState, Pressable, ScrollView, useWindowDimensions, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

import { AppText as Text } from "../../../components/ui/AppText";
import { useSavedRemoteConnection } from "../../../state/use-remote-environment-registry";
import { tessayaEnvironmentIdAtom } from "../../../state/tessayaHousehold";
import { tessayaWorkSessions } from "../../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useVoiceInputController } from "../../voice-input/useVoiceInputController";
import { askOutcome, talkPersona, toBase64 } from "./talk.logic";
import {
  addFrames,
  batteryDrain,
  type BatteryRead,
  startStretch,
  STRETCH_MS,
  stretchSummary,
  tick,
  TICK_MS,
  type Stretch,
} from "./talkCost";

const PAGE = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><style>html,body{margin:0;height:100%;background:transparent;overflow:hidden}</style></head><body><script>${bodyStreamScript}</script></body></html>`;
const POLL_MS = 1500;
const POLLS = 60;

export function TalkRouteScreen() {
  const environmentId = useAtomValue(tessayaEnvironmentIdAtom);
  const connection = useSavedRemoteConnection(environmentId);
  const insets = useSafeAreaInsets();
  const screenHeight = useWindowDimensions().height;
  const focused = useIsFocused();
  const [active, setActive] = useState(AppState.currentState === "active");
  const [personas, setPersonas] = useState<ReadonlyArray<TessayaPersona>>([]);
  const [picked, setPicked] = useState<string | null>(null);
  const [heard, setHeard] = useState("");
  const [said, setSaid] = useState("");
  const [model, setModel] = useState<{ readonly persona: string; readonly base64: string } | null>(
    null,
  );
  const webView = useRef<WebView<object>>(null);
  const inset = useRef(0);
  const listPersonas = useAtomCommand(tessayaWorkSessions.personasList, { reportFailure: false });
  const phoneCall = useAtomCommand(tessayaWorkSessions.phoneCall, { reportFailure: false });
  const voiceCall = useAtomCommand(tessayaWorkSessions.voiceCall, { reportFailure: false });
  const persona = talkPersona(personas, picked);
  const drawing = focused && active;
  const devicesCall = useAtomCommand(tessayaWorkSessions.devicesCall, { reportFailure: false });
  const cost = useRef<Stretch | null>(null);
  const awayAt = useRef<number | null>(null);
  // the battery at the start of the stretch on screen, and when she went off it
  const batteryAt = useRef<BatteryRead | null>(null);
  const awayBattery = useRef<BatteryRead | null>(null);
  const reportCost = (line: string) => {
    if (environmentId === null) return;
    const manifest = phoneManifest({
      installId: `${Device.modelName ?? ""}${Device.deviceName ?? ""}`,
      model: Device.modelName ?? null,
      os: Device.osName === null ? null : `${Device.osName} ${Device.osVersion ?? ""}`.trim(),
      motion: Device.isDevice,
    });
    void devicesCall({
      environmentId,
      input: {
        kind: "vessel",
        op: "publish",
        args: {
          deviceId: manifest.deviceId,
          manifest,
          values: [{ itemId: "talk.cost", value: line }],
        },
      },
    });
  };

  const readBattery = (): Promise<BatteryRead | null> =>
    Promise.all([Battery.getBatteryLevelAsync(), Battery.getBatteryStateAsync()]).then(
      ([level, state]) => ({
        level,
        charging: state === Battery.BatteryState.CHARGING || state === Battery.BatteryState.FULL,
        at: Date.now(),
      }),
      () => null,
    );
  const withBattery = (line: string, from: BatteryRead | null) =>
    void readBattery().then((now) => {
      const drain = batteryDrain(from, now);
      reportCost(drain === null ? line : `${line}, ${drain}`);
    });

  // her cost while she is on screen: frames from the page, busy time from a timer, one report per ten minutes
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a timer measures the JS thread only while she is drawn
  useEffect(() => {
    if (!drawing) {
      cost.current = null;
      if (awayAt.current === null) {
        awayAt.current = Date.now();
        void readBattery().then((b) => (awayBattery.current = b));
      }
      return;
    }
    // back from ten minutes or more away: her page was closed the whole time, so it drew nothing
    if (awayAt.current !== null && Date.now() - awayAt.current >= STRETCH_MS)
      withBattery(
        `background: 0 frames (her page closed) over ${Math.round((Date.now() - awayAt.current) / 60_000)} min`,
        awayBattery.current,
      );
    awayAt.current = null;
    cost.current = startStretch(Date.now());
    void readBattery().then((b) => (batteryAt.current = b));
    const timer = setInterval(() => {
      if (cost.current === null) return;
      const now = Date.now();
      cost.current = tick(cost.current, now);
      const line = stretchSummary(cost.current, now, "visible");
      if (line !== null) {
        withBattery(line, batteryAt.current);
        cost.current = startStretch(now);
        void readBattery().then((b) => (batteryAt.current = b));
      }
    }, TICK_MS);
    return () => clearInterval(timer);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- restarts only when she starts or stops being drawn
  }, [drawing]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the app going to the background stops her drawing
  useEffect(() => {
    const sub = AppState.addEventListener("change", (s) => setActive(s === "active"));
    return () => sub.remove();
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the household's personas once per environment
  useEffect(() => {
    if (environmentId === null) return;
    void listPersonas({ environmentId, input: {} }).then((r) => {
      if (r._tag === "Success") setPersonas(r.value.personas.filter((p) => p.private !== true));
    });
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- one read per environment; the command is stable
  }, [environmentId]);

  // Her body's model: what the server offers him first (his last-used, her worn body, else the CC0 fallback).
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fetches the model's bytes once per environment and persona
  useEffect(() => {
    const base = connection?.httpBaseUrl;
    const token = connection?.bearerToken;
    if (!base || !token || persona === null) return;
    const auth = { authorization: `Bearer ${token}` };
    let cancelled = false;
    void (async () => {
      const hello = (await fetch(new URL("/tessaya/playground/api/hello", base), {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: "{}",
      })
        .then((r) => r.json())
        .catch(() => ({}))) as { models?: ReadonlyArray<OfferedModel> };
      for (const m of modelOrder(hello.models ?? [], null)) {
        if (m.url === undefined) continue;
        const res = await fetch(new URL(m.url, base), { headers: auth }).catch(() => null);
        if (res === null || !res.ok) continue;
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (!cancelled) setModel({ persona: persona.id, base64: toBase64(bytes) });
        return;
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connection?.httpBaseUrl, connection?.bearerToken, persona]);

  const post = (data: object) => webView.current?.postMessage(JSON.stringify(data));

  const speak = async (text: string) => {
    if (environmentId === null || persona === null || text.trim() === "") return;
    // her body speaks in the brain's one mood for this persona (as every other body does), neutral if unread
    const read = await voiceCall({
      environmentId,
      input: { kind: "read", op: "mood", args: { persona: persona.id } },
    });
    const felt =
      read._tag === "Success"
        ? ((read.value as TessayaVoiceCallResult).value as {
            label?: unknown;
            intensity?: unknown;
          } | null)
        : null;
    const mood = typeof felt?.label === "string" ? felt.label : "neutral";
    const intensity = typeof felt?.intensity === "number" ? felt.intensity : 0.4;
    for (const cue of lineCues({ persona: persona.id, text, mood, intensity }))
      post({ type: "cue", cue });
    const reply = await voiceCall({
      environmentId,
      input: { kind: "act", op: "say", args: { engine: "pocket", voice: persona.voice, text } },
    });
    const clip = reply._tag === "Success" ? (reply.value as TessayaVoiceCallResult).value : null;
    if (clip === null || clip === undefined) return;
    const file = new File(Paths.cache, "tessaya-talk.wav");
    file.write((clip as { base64: string }).base64, { encoding: "base64" });
    createAudioPlayer(file.uri).play();
  };

  const ask = async (text: string) => {
    if (environmentId === null || text.trim() === "") return;
    setHeard(text);
    setSaid("…");
    const id = `phone-${Date.now().toString(36)}`;
    const opened = await phoneCall({
      environmentId,
      input: { op: "ask", args: { id, text, origin: "phone talk" } },
    });
    if (opened._tag !== "Success") return setSaid("She couldn't be reached. Try again.");
    for (let i = 0; i < POLLS; i++) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const got = await phoneCall({ environmentId, input: { op: "askGet", args: { id } } });
      const outcome = askOutcome(
        got._tag === "Success"
          ? (got.value.value as { status?: string; line?: string } | null)
          : null,
      );
      setSaid(outcome.line);
      if (outcome.done) return void speak(outcome.line);
    }
  };

  const voice = useVoiceInputController({
    ownerKey: "tessaya-talk",
    label: "Talk to her",
    readDraftMessage: () => "",
    selection: { start: 0, end: 0 },
    onChangeDraftMessage: (text) => void ask(text),
    onChangeSelection: () => undefined,
  });
  const listening = voice.state.phase === "recording";

  return (
    <View className="flex-1 bg-background" style={{ paddingTop: insets.top }}>
      {drawing ? (
        <WebView<object>
          ref={webView}
          source={{ html: PAGE }}
          originWhitelist={["*"]}
          scrollEnabled={false}
          bounces={false}
          style={{ flex: 1, backgroundColor: "transparent" }}
          onMessage={(e) => {
            const data = e.nativeEvent.data;
            if (data.includes('"ready"') && model !== null) post({ type: "model", ...model });
            const frames = /"frames","n":(\d+)/.exec(data)?.[1];
            if (frames !== undefined && cost.current !== null)
              cost.current = addFrames(cost.current, Number(frames));
          }}
          onLoadEnd={() => {
            post({ type: "inset", bottom: inset.current });
            if (model !== null) post({ type: "model", ...model });
          }}
        />
      ) : (
        <View className="flex-1" />
      )}
      <View
        className="absolute inset-x-0 bottom-0 gap-3 rounded-t-3xl bg-background/85 px-4 pt-4"
        style={{ paddingBottom: insets.bottom + 12 }}
        // the panel grows with her reply or the keyboard; her framing keeps her face above it
        onLayout={(e) => {
          if (screenHeight === 0) return;
          inset.current = e.nativeEvent.layout.height / screenHeight;
          post({ type: "inset", bottom: inset.current });
        }}
      >
        {heard === "" ? null : (
          <Text className="text-sm text-muted-foreground" numberOfLines={2}>
            {heard}
          </Text>
        )}
        {said === "" ? null : (
          <Text className="text-base text-foreground" numberOfLines={6}>
            {said}
          </Text>
        )}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="gap-2"
        >
          {personas.map((p) => (
            <Pressable
              key={p.id}
              accessibilityRole="button"
              accessibilityState={{ selected: p.id === persona?.id }}
              onPress={() => setPicked(p.id)}
              className={`rounded-full px-3 py-1.5 ${p.id === persona?.id ? "bg-primary" : "bg-secondary"}`}
            >
              <Text
                className={p.id === persona?.id ? "text-primary-foreground" : "text-foreground"}
              >
                {p.name}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            listening ? "Let go to send" : `Hold to talk to ${persona?.name ?? "her"}`
          }
          disabled={!voice.isAvailable || environmentId === null}
          onPressIn={voice.start}
          onPressOut={() => void voice.stop()}
          className={`items-center rounded-full py-4 ${listening ? "bg-primary" : "bg-secondary"}`}
        >
          <Text className={listening ? "text-primary-foreground" : "text-foreground"}>
            {environmentId === null
              ? "Pair with one of your machines to talk to her"
              : listening
                ? "Listening… let go to send"
                : `Hold to talk to ${persona?.name ?? "her"}`}
          </Text>
        </Pressable>
      </View>
    </View>
  );
}

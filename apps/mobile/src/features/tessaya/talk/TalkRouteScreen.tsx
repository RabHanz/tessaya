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
import { renderFor, VESSELS, type PropState } from "@t3tools/tessaya-shared/expressionMap";
import { phoneManifest } from "@t3tools/tessaya-shared/phoneDevice";
import { touchOpKind } from "@t3tools/tessaya-shared/touchReaction";
import { modelOrder, type OfferedModel } from "@t3tools/tessaya-shared/playgroundOrder";
import * as Battery from "expo-battery";
import * as Device from "expo-device";
import {
  createAudioPlayer,
  getRecordingPermissionsAsync,
  requestRecordingPermissionsAsync,
} from "expo-audio";
import { File, Paths } from "expo-file-system";
import { Image } from "expo-image";
import { useEffect, useRef, useState } from "react";
import {
  AppState,
  Linking,
  Pressable,
  ScrollView,
  type ScrollViewInstance,
  TextInput,
  useWindowDimensions,
  View,
} from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

import { AppText as Text } from "../../../components/ui/AppText";
import { useSavedRemoteConnection } from "../../../state/use-remote-environment-registry";
import { tessayaEnvironmentIdAtom } from "../../../state/tessayaHousehold";
import { tessayaWorkSessions } from "../../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useVoiceInputController } from "../../voice-input/useVoiceInputController";
import { askOutcome, bodyCacheName, talkPersona } from "./talk.logic";
import { mergeLines, talkRows, type TalkLine } from "./talkHistory.logic";
import { setHerPhase } from "../island/herPhase";
import { phoneSoulIs } from "../private/privateLayer";
import { useBottomClearance } from "../layout/screenInsets";
import { useSleeveCovering } from "../sleeve/useSleeve";
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
  // under a Sleeve the tab draws nothing: the Sleeve's own body is the one on screen
  const covered = useSleeveCovering();
  return <TalkView focused={useIsFocused() && !covered} sleeve={false} />;
}

/**
 * Talk itself. In Sleeve (M-120) she fills the screen edge to edge, behind the camera hole too; only her last line
 * and the place to hold stay, inside the safe area.
 */
export function TalkView(props: { readonly focused: boolean; readonly sleeve: boolean }) {
  const environmentId = useAtomValue(tessayaEnvironmentIdAtom);
  const connection = useSavedRemoteConnection(environmentId);
  const insets = useSafeAreaInsets();
  const screenHeight = useWindowDimensions().height;
  const { focused, sleeve } = props;
  const [active, setActive] = useState(AppState.currentState === "active");
  const [personas, setPersonas] = useState<ReadonlyArray<TessayaPersona>>([]);
  const [picked, setPicked] = useState<string | null>(null);
  // his one conversation with her (M-124): the room transcript a page at a time, then this phone's own exchanges
  const [lines, setLines] = useState<ReadonlyArray<TalkLine>>([]);
  const [earliest, setEarliest] = useState<number | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  // the microphone, asked for by a tap with its reason first, never as a system prompt in the middle of a hold
  const [mic, setMic] = useState<"unknown" | "ask" | "granted" | "denied">("unknown");
  const [typed, setTyped] = useState("");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the system's microphone permission when she shows, and again on return from Settings
  useEffect(() => {
    if (!active) return;
    void getRecordingPermissionsAsync().then(
      (p) => setMic(p.granted ? "granted" : p.canAskAgain ? "ask" : "denied"),
      () => setMic("ask"),
    );
  }, [active]);
  const allowMic = async () => {
    const p = await requestRecordingPermissionsAsync().catch(() => null);
    setMic(p?.granted === true ? "granted" : "denied");
  };
  // she shows as her face at once, until her body has loaded and drawn
  const [bodyShown, setBodyShown] = useState(false);
  // his computer offered no body of his: her face stays, and says so rather than "on her way"
  const [bodyless, setBodyless] = useState(false);
  const [model, setModel] = useState<{ readonly persona: string; readonly base64: string } | null>(
    null,
  );
  const webView = useRef<WebView<object>>(null);
  // the hat her body here wears (renderFor for its form), sent only when it changes
  const hat = useRef<string | null>(null);
  const inset = useRef(0);
  // the panel's height, so her face and its words stay above it
  const [panel, setPanel] = useState(0);
  const bottom = useBottomClearance();
  const listPersonas = useAtomCommand(tessayaWorkSessions.personasList, { reportFailure: false });
  const phoneCall = useAtomCommand(tessayaWorkSessions.phoneCall, { reportFailure: false });
  const voiceCall = useAtomCommand(tessayaWorkSessions.voiceCall, { reportFailure: false });
  const persona = talkPersona(personas, picked);
  // the private layer opens for the soul he is talking to here
  phoneSoulIs(persona?.id ?? null);
  const drawing = focused && active;
  const devicesCall = useAtomCommand(tessayaWorkSessions.devicesCall, { reportFailure: false });
  const cost = useRef<Stretch | null>(null);
  const awayAt = useRef<number | null>(null);
  // the battery at the start of the stretch on screen, and when she went off it
  const batteryAt = useRef<BatteryRead | null>(null);
  const awayBattery = useRef<BatteryRead | null>(null);
  const manifestNow = () =>
    phoneManifest({
      installId: `${Device.modelName ?? ""}${Device.deviceName ?? ""}`,
      model: Device.modelName ?? null,
      os: Device.osName === null ? null : `${Device.osName} ${Device.osVersion ?? ""}`.trim(),
      motion: Device.isDevice,
    });
  /** His finger on her body here, felt by her one nervous system (the desk's own `touch` path); her mood answers. */
  const touched = async (t: {
    part?: unknown;
    kind?: unknown;
    pressure?: unknown;
    cmPerS?: unknown;
  }) => {
    const kind = typeof t.kind === "string" ? touchOpKind(t.kind) : null;
    if (environmentId === null || persona === null || kind === null || typeof t.part !== "string")
      return;
    const answer = await voiceCall({
      environmentId,
      input: {
        kind: "act",
        op: "touch",
        args: {
          part: t.part,
          kind,
          pressure: typeof t.pressure === "number" ? Math.min(1, Math.max(0, t.pressure)) : 0.4,
          cmPerS: typeof t.cmPerS === "number" ? Math.min(2000, Math.max(0, t.cmPerS)) : 0,
          durationMs: 0,
          persona: persona.id,
          device: manifestNow().deviceId,
        },
      },
    });
    const r =
      answer._tag === "Success"
        ? ((answer.value as TessayaVoiceCallResult).value as {
            face?: unknown;
            gesture?: unknown;
            intensity?: unknown;
          } | null)
        : null;
    if (typeof r?.face === "string")
      post({
        type: "cue",
        cue: {
          kind: "mood",
          mood: r.face,
          intensity: typeof r.intensity === "number" ? r.intensity : 0.6,
        },
      });
    if (typeof r?.gesture === "string")
      post({ type: "cue", cue: { kind: "gesture", gesture: r.gesture } });
  };
  const reportCost = (line: string) => {
    if (environmentId === null) return;
    const manifest = manifestNow();
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

  // Her body's model: what the server offers him first (his last-used, then her worn body).
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
        // fetched once into the phone's cache and read back natively: a JS base64 of a large model took minutes (20 Nov)
        const kept = new File(Paths.cache, bodyCacheName(m.url));
        if (!kept.exists || kept.size === 0) {
          const got = await File.downloadFileAsync(new URL(m.url, base).href, kept, {
            headers: auth,
            idempotent: true,
          }).catch(() => null);
          if (got === null) continue;
        }
        const base64 = await kept.base64().catch(() => null);
        if (base64 === null) continue;
        if (cancelled) return;
        const next = { persona: persona.id, base64 };
        setModel(next);
        // her page may already have said "ready" while the model was still on its way: send it now too
        webView.current?.postMessage(JSON.stringify({ type: "model", ...next }));
        return;
      }
      if (!cancelled) setBodyless(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [connection?.httpBaseUrl, connection?.bearerToken, persona]);

  const post = (data: object) => webView.current?.postMessage(JSON.stringify(data));

  const readHistory = async (before?: number) => {
    if (environmentId === null) return;
    const got = await voiceCall({
      environmentId,
      input: { kind: "read", op: "conversation", args: before === undefined ? {} : { before } },
    });
    const page =
      got._tag === "Success"
        ? ((got.value as TessayaVoiceCallResult).value as {
            from?: unknown;
            lines?: ReadonlyArray<TalkLine>;
          } | null)
        : null;
    if (page === null || !Array.isArray(page.lines)) return;
    setLines((held) => mergeLines(page.lines ?? [], held));
    if (typeof page.from === "number") setEarliest(page.from);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads his conversation from her brain once per environment
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect, react/exhaustive-effect-dependencies -- the read closes over this environment
    void readHistory();
  }, [environmentId]);
  const said = (role: "them" | "her", text: string) =>
    setLines((held) =>
      mergeLines(held, [
        { at: Date.now(), vessel: manifestNow().deviceId, role, text, private: false },
      ]),
    );

  const speak = async (text: string) => {
    if (environmentId === null || persona === null || text.trim() === "") return;
    // her body speaks in the brain's one mood for this persona (as every other body does), neutral if unread
    const read = await voiceCall({
      environmentId,
      input: {
        kind: "read",
        op: "mood",
        args: { persona: persona.id, device: manifestNow().deviceId },
      },
    });
    const felt =
      read._tag === "Success"
        ? ((read.value as TessayaVoiceCallResult).value as {
            label?: unknown;
            intensity?: unknown;
            props?: PropState;
            brows?: unknown;
          } | null)
        : null;
    const mood = typeof felt?.label === "string" ? felt.label : "neutral";
    const intensity = typeof felt?.intensity === "number" ? felt.intensity : 0.4;
    const prop = renderFor(VESSELS.body, mood, intensity, felt?.props).prop ?? null;
    if (prop !== hat.current)
      post({
        type: "cue",
        cue:
          prop === null
            ? { kind: "prop", id: "state" }
            : { kind: "prop", id: "state", url: `builtin:${prop}` },
      });
    hat.current = prop;
    if (felt !== null)
      post({
        type: "cue",
        cue: { kind: "brows", dark: typeof felt.brows === "boolean" ? felt.brows : null },
      });
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
    const player = createAudioPlayer(file.uri);
    setHerPhase("speaking");
    const done = player.addListener("playbackStatusUpdate", (status) => {
      if (!status.didJustFinish) return;
      done.remove();
      player.release();
      setHerPhase("idle");
    });
    player.play();
  };

  const ask = async (text: string) => {
    if (environmentId === null || text.trim() === "") return;
    said("them", text);
    setPending("…");
    setHerPhase("thinking");
    const id = `phone-${Date.now().toString(36)}`;
    const opened = await phoneCall({
      environmentId,
      input: { op: "ask", args: { id, text, origin: "phone talk" } },
    });
    if (opened._tag !== "Success") {
      setHerPhase("idle");
      return setPending("She couldn't be reached. Try again.");
    }
    for (let i = 0; i < POLLS; i++) {
      await new Promise((r) => setTimeout(r, POLL_MS));
      const got = await phoneCall({ environmentId, input: { op: "askGet", args: { id } } });
      const outcome = askOutcome(
        got._tag === "Success"
          ? (got.value.value as { status?: string; line?: string } | null)
          : null,
      );
      setPending(outcome.line);
      if (outcome.done) {
        setPending(null);
        said("her", outcome.line);
        return void speak(outcome.line);
      }
    }
    setHerPhase("idle");
  };

  const voice = useVoiceInputController({
    ownerKey: "tessaya-talk",
    label: "Talk to her",
    // the tab's Talk and the Sleeve's share this key; only the one on screen claims it
    hidden: !focused,
    readDraftMessage: () => "",
    selection: { start: 0, end: 0 },
    onChangeDraftMessage: (text) => void ask(text),
    onChangeSelection: () => undefined,
  });
  const listening = voice.state.phase === "recording";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- tells the island (outside this screen) that she is listening
  useEffect(() => {
    if (listening) setHerPhase("listening");
    else setHerPhase(pending === null ? "idle" : "thinking");
  }, [listening, pending]);

  return (
    <View className="flex-1 bg-screen" style={{ paddingTop: sleeve ? 0 : insets.top }}>
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
            if (data.includes('"touch"')) {
              try {
                void touched(JSON.parse(data) as Record<string, unknown>);
              } catch {
                // not one of her page's messages
              }
            }
            if (data.includes('"shown"')) setBodyShown(true);
            const frames = /"frames","n":(\d+)/.exec(data)?.[1];
            if (frames !== undefined && cost.current !== null)
              cost.current = addFrames(cost.current, Number(frames));
          }}
          onLoadStart={() => setBodyShown(false)}
          onLoadEnd={() => {
            post({ type: "inset", bottom: inset.current });
            if (model !== null) post({ type: "model", ...model });
          }}
        />
      ) : (
        <View className="flex-1" />
      )}
      {bodyShown ? null : (
        <View
          pointerEvents="none"
          className="absolute inset-x-0 items-center justify-center gap-3 px-8"
          style={{ top: sleeve ? insets.top : 0, bottom: panel }}
        >
          <Image
            source={require("../welcome/face-neutral.webp")}
            style={{ width: 160, height: 160 }}
            contentFit="contain"
            accessibilityIgnoresInvertColors
          />
          <Text className="text-center text-base text-foreground-muted">
            {environmentId === null
              ? "Pair a computer to talk to her"
              : bodyless
                ? `${persona?.name ?? "She"} has no body on your computer yet. You can still talk to her.`
                : `${persona?.name ?? "She"} is on her way…`}
          </Text>
        </View>
      )}
      <View
        className={`absolute inset-x-0 bottom-0 gap-3 pt-4 ${sleeve ? "" : "rounded-t-3xl bg-screen"}`}
        style={{
          paddingBottom: bottom + 12,
          paddingLeft: insets.left + 20,
          paddingRight: insets.right + 20,
        }}
        // the panel grows with her reply or the keyboard; her framing keeps her face above it
        onLayout={(e) => {
          if (screenHeight === 0) return;
          setPanel(e.nativeEvent.layout.height);
          inset.current = e.nativeEvent.layout.height / screenHeight;
          post({ type: "inset", bottom: inset.current });
        }}
      >
        <TalkHistory
          lines={sleeve ? lines.filter((l) => l.role === "her").slice(-1) : lines}
          pending={pending}
          maxHeight={sleeve ? screenHeight * 0.2 : screenHeight * 0.3}
          earlier={sleeve || earliest === null ? null : () => void readHistory(earliest)}
        />
        <ScrollView
          style={sleeve ? { display: "none" } : { flexGrow: 0 }}
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
        {mic === "ask" && environmentId !== null ? (
          <Pressable
            accessibilityRole="button"
            onPress={() => void allowMic()}
            className="items-center gap-1 rounded-full bg-secondary py-4"
          >
            <Text className="text-foreground">Let {persona?.name ?? "her"} hear you</Text>
            <Text className="text-xs text-foreground-muted">
              She listens only while you hold the button.
            </Text>
          </Pressable>
        ) : null}
        {mic === "denied" && environmentId !== null ? (
          <View className="gap-2">
            <View className="flex-row items-center gap-2 rounded-full bg-secondary px-4">
              <TextInput
                value={typed}
                onChangeText={setTyped}
                placeholder={`Type to ${persona?.name ?? "her"}`}
                returnKeyType="send"
                onSubmitEditing={() => {
                  void ask(typed);
                  setTyped("");
                }}
                className="flex-1 py-3 text-base text-foreground"
              />
            </View>
            <Pressable accessibilityRole="link" onPress={() => void Linking.openSettings()}>
              <Text className="text-center text-xs text-foreground-muted">
                The microphone is off for Tessaya. Turn it on in Settings to talk.
              </Text>
            </Pressable>
          </View>
        ) : null}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            listening ? "Let go to send" : `Hold to talk to ${persona?.name ?? "her"}`
          }
          style={
            mic === "granted" || mic === "unknown" || environmentId === null
              ? undefined
              : { display: "none" }
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

/** His conversation with her, newest at the bottom: her last line is the largest thing here, his last words above it. */
function TalkHistory(props: {
  readonly lines: ReadonlyArray<TalkLine>;
  readonly pending: string | null;
  readonly maxHeight: number;
  readonly earlier: (() => void) | null;
}) {
  const scroller = useRef<ScrollViewInstance>(null);
  // follows the newest line unless he has scrolled up to read
  const atEnd = useRef(true);
  const [now] = useState(() => Date.now());
  const rows = talkRows(props.lines, now);
  const lastHer = rows.findLastIndex((r) => r.kind === "line" && r.role === "her");
  if (rows.length === 0 && props.pending === null) return null;
  return (
    <ScrollView
      ref={scroller}
      style={{ maxHeight: props.maxHeight }}
      contentContainerClassName="gap-2"
      showsVerticalScrollIndicator={false}
      onScroll={(e) => {
        const n = e.nativeEvent;
        atEnd.current = n.contentOffset.y + n.layoutMeasurement.height >= n.contentSize.height - 24;
      }}
      scrollEventThrottle={200}
      onContentSizeChange={() => {
        if (atEnd.current) scroller.current?.scrollToEnd({ animated: false });
      }}
    >
      {props.earlier === null ? null : (
        <Pressable accessibilityRole="button" onPress={props.earlier} className="py-1">
          <Text className="text-center text-xs text-foreground-muted">Earlier</Text>
        </Pressable>
      )}
      {rows.map((r, i) =>
        r.kind === "day" ? (
          <Text
            key={r.key}
            className="pt-2 text-center text-xs uppercase tracking-wide text-foreground-muted"
          >
            {r.label}
          </Text>
        ) : (
          <View key={r.key} className={r.role === "them" ? "items-end pl-12" : "items-start pr-6"}>
            <Text
              className={
                r.private
                  ? "text-sm italic text-foreground-muted"
                  : r.role === "them"
                    ? "text-sm text-foreground-muted"
                    : i === lastHer && props.pending === null
                      ? "text-xl text-foreground"
                      : "text-base text-foreground"
              }
            >
              {r.text}
            </Text>
          </View>
        ),
      )}
      {props.pending === null ? null : (
        <Text className="text-xl text-foreground">{props.pending}</Text>
      )}
    </ScrollView>
  );
}

/**
 * Companion mode: this phone becomes a Tessaya satellite in the room, like the R1. Her face fills the screen; the
 * microphone and speaker join the room voice loop through this environment's server (baton-shared/satellite for what
 * goes up and when); her name wakes it through the server's own wake check. The screen stays on while open.
 */
import { useAtomMount } from "@effect/atom-react";
import { type CompanionDown } from "@t3tools/baton-contracts";
import { cueFor } from "@t3tools/baton-shared/companion";
import {
  createFramer,
  createUplink,
  expressionOfMood,
  pcmToBase64,
  satelliteInbox,
  satelliteMoment,
  type UplinkMessage,
} from "@t3tools/baton-shared/satellite";
import { EnvironmentId } from "@t3tools/contracts";
import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { requestRecordingPermissionsAsync, useAudioStream } from "expo-audio";
import { useKeepAwake } from "expo-keep-awake";
import { useEffect, useRef, useState } from "react";
import { Pressable, StyleSheet, View, useWindowDimensions } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { WebView } from "react-native-webview";

import { AppText as Text } from "../../components/ui/AppText";
import { batonWorkSessions } from "../../state/batonWorkSessions";
import { usePreparedConnection } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { COMPANION_PAGE_SCRIPT, companionPageMessage } from "./companionPage";
import { satelliteIdentity } from "./satelliteIdentity";

const QUIET = { reportFailure: false } as const;
/** The microphone's frames go up in small batches: two 60 ms frames a call. */
const SEND_MS = 120;
/** How often the face is checked against the session; it changes only when the moment does. */
const FACE_MS = 250;
const MOOD_WORD: Readonly<Record<string, string>> = {
  rest: "steady",
  listening: "listening",
  thinking: "thinking",
  speaking: "speaking",
};

type Props = StaticScreenProps<{ readonly environmentId: string }>;

export function CompanionModeRouteScreen({ route }: Props) {
  const [identity] = useState(satelliteIdentity);
  return (
    <CompanionMode
      environmentId={EnvironmentId.make(route.params.environmentId)}
      identity={identity}
    />
  );
}

function CompanionMode({
  environmentId,
  identity,
}: {
  readonly environmentId: EnvironmentId;
  readonly identity: { readonly id: string; readonly name: string };
}) {
  useKeepAwake();
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const landscape = width > height;
  const connection = usePreparedConnection(environmentId);
  const httpBase = connection._tag === "Some" ? connection.value.httpBaseUrl : null;
  useAtomMount(
    batonWorkSessions.companionLink({
      environmentId,
      input: { id: identity.id, name: identity.name },
    }),
  );
  const up = useAtomCommand(batonWorkSessions.companionUp, QUIET);

  const webView = useRef<WebView<object>>(null);
  const uplink = useRef(createUplink());
  const framer = useRef(createFramer());
  const pending = useRef<Array<{ topic: UplinkMessage["topic"]; data: string }>>([]);
  const live = useRef({
    session: false,
    playing: false,
    persona: "tessaya",
    mood: "neutral",
    moment: "",
  });
  const [shown, setShown] = useState({ moment: "rest", mood: "neutral", persona: "Tessaya" });

  const page = (code: string) => webView.current?.injectJavaScript(`${code};true;`);
  const queue = (messages: ReadonlyArray<UplinkMessage>) => {
    for (const m of messages)
      pending.current.push({ topic: m.topic, data: m.pcm === undefined ? "" : pcmToBase64(m.pcm) });
  };

  const { stream } = useAudioStream({
    sampleRate: 16_000,
    channels: 1,
    encoding: "int16",
    onBuffer: (buffer) => {
      const pcm = new Int16Array(buffer.data);
      for (const frame of framer.current(pcm, buffer.sampleRate))
        queue(uplink.current.push(frame, Date.now()));
    },
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the microphone is a native stream: opened while this screen is up, closed when it goes
  useEffect(() => {
    let stopped = false;
    void requestRecordingPermissionsAsync().then((p) => {
      if (p.granted && !stopped) void stream.start();
    });
    return () => {
      stopped = true;
      stream.stop();
    };
  }, [stream]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the room's messages arrive on the link's stream, outside React
  useEffect(
    () =>
      satelliteInbox.listen((down: CompanionDown) => {
        const now = live.current;
        switch (down.kind) {
          case "audio":
            return page(`companion.audio(${JSON.stringify(down.pcm)})`);
          case "flush":
            return page("companion.flush()");
          case "start":
          case "stop":
            now.session = down.kind === "start";
            return queue(uplink.current.session(now.session));
          case "face":
            now.mood = expressionOfMood(down.mood);
            now.moment = "";
            return;
          case "persona":
            now.persona = down.name.toLowerCase();
            return page(`companion.persona(${JSON.stringify(now.persona)})`);
        }
      }),
    [],
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- sends the microphone's batches and follows the session on a timer while open
  useEffect(() => {
    const send = setInterval(() => {
      if (pending.current.length === 0) return;
      void up({ environmentId, input: { id: identity.id, items: pending.current.splice(0, 40) } });
    }, SEND_MS);
    const face = setInterval(() => {
      const now = live.current;
      const last = uplink.current.lastVoiceAt();
      const moment = satelliteMoment({
        session: now.session,
        playing: now.playing,
        hearing: uplink.current.hearing(),
        sinceVoiceMs: last === null ? null : Date.now() - last,
      });
      const key = `${moment}:${now.mood}`;
      if (key === now.moment) return;
      now.moment = key;
      const cue = moment === "rest" ? { expression: now.mood } : cueFor(moment, "calm");
      if (cue !== null) page(`companion.cue(${JSON.stringify(cue)})`);
      setShown({ moment, mood: now.mood, persona: now.persona });
    }, FACE_MS);
    return () => {
      clearInterval(send);
      clearInterval(face);
    };
  }, [environmentId, identity.id, up]);

  const name = shown.persona.charAt(0).toUpperCase() + shown.persona.slice(1);
  const line = shown.moment === "rest" ? `Say “${name}”` : (MOOD_WORD[shown.moment] ?? "");
  return (
    <View style={styles.ground}>
      {httpBase === null ? null : (
        <WebView
          ref={webView}
          source={{ uri: new URL("/companion/stage.html", httpBase).href }}
          injectedJavaScript={`${COMPANION_PAGE_SCRIPT};companion.persona(${JSON.stringify(live.current.persona)});true;`}
          onMessage={(event) => {
            const message = companionPageMessage(event.nativeEvent.data);
            if (message?.type !== "playing") return;
            live.current.playing = message.on;
            uplink.current.playing(message.on, Date.now());
          }}
          mediaPlaybackRequiresUserAction={false}
          allowsInlineMediaPlayback
          scrollEnabled={false}
          style={[styles.face, landscape ? styles.faceLandscape : styles.facePortrait]}
          containerStyle={styles.transparent}
        />
      )}
      <View
        pointerEvents="box-none"
        style={[
          styles.words,
          landscape ? styles.wordsLandscape : styles.wordsPortrait,
          { paddingBottom: insets.bottom + 24 },
        ]}
      >
        <Text style={styles.name}>{name}</Text>
        <Text style={styles.mood}>{shown.mood === "neutral" ? "steady" : shown.mood}</Text>
        <Text style={styles.line} accessibilityLiveRegion="polite">
          {line}
        </Text>
      </View>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Leave companion mode"
        onPress={() => navigation.goBack()}
        style={[styles.done, { top: insets.top + 8 }]}
      >
        <Text style={styles.doneText}>Done</Text>
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  ground: { flex: 1, backgroundColor: "#0F1B1E" },
  transparent: { backgroundColor: "transparent" },
  face: { position: "absolute", backgroundColor: "transparent" },
  facePortrait: { left: "8%", right: "8%", top: "12%", aspectRatio: 1 },
  faceLandscape: { left: "4%", top: "8%", bottom: "8%", aspectRatio: 1 },
  words: { position: "absolute", alignItems: "center" },
  wordsPortrait: { left: 0, right: 0, bottom: "14%" },
  wordsLandscape: { left: "52%", right: 24, top: "30%", alignItems: "flex-start" },
  name: { color: "#EEEDE4", fontSize: 30, fontWeight: "500" },
  mood: { color: "#a2a6a1", fontSize: 14, marginTop: 4 },
  line: { color: "#EEEDE4", fontSize: 16, fontWeight: "600", marginTop: 14 },
  done: { position: "absolute", left: 16, paddingHorizontal: 12, paddingVertical: 6 },
  doneText: { color: "#a2a6a1", fontSize: 15 },
});

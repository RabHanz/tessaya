import type { EnrolCard } from "@t3tools/tessaya-contracts";
import { Modal, ScrollView, View } from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { ControlPill } from "../../components/ui/ControlPill";

const MARK = { done: "✓", again: "↺", now: "▸" } as const;

/** The sentence being read: the words he has said, the one he is on, and the rest. */
function Followed(props: {
  readonly text: string;
  readonly heard: number;
  readonly again: boolean;
}) {
  const words = props.text.split(" ");
  const said = words.slice(0, props.heard).join(" ");
  const next = words[props.heard];
  const rest = words.slice(props.heard + 1).join(" ");
  return (
    <>
      <Text className={props.again ? "text-warning-foreground" : "text-primary"}>{said}</Text>
      {said && next !== undefined ? " " : null}
      {next === undefined ? null : <Text className="underline">{next}</Text>}
      {rest ? ` ${rest}` : null}
    </>
  );
}

/** The guided read while he enrols an R1, on the phone in his hand: the room loop builds the card, this only draws it. */
export function VoiceEnrolCard(props: {
  readonly card: EnrolCard;
  readonly onClose: () => void;
  readonly onRedo: () => void;
}) {
  const { card } = props;
  const over = card.phase === "done" || card.phase === "failed";
  const read = card.lines.filter((l) => l.state === "done").length;
  const current = card.lines.find((l) => l.state === "again" || l.state === "now");
  return (
    // No slide: the card is there at once, so a reduced-motion setting has nothing to soften.
    <Modal
      visible
      animationType="none"
      presentationStyle="pageSheet"
      onRequestClose={props.onClose}
    >
      <SafeAreaView style={{ flex: 1 }} className="bg-screen">
        <ScrollView contentContainerClassName="gap-3 px-5 py-6">
          <Text textRole="title" className="text-foreground" accessibilityRole="header">
            {over && card.summary ? card.summary.headline : card.title}
          </Text>
          {over ? null : (
            <Text className="text-sm text-foreground-muted">
              {card.phase === "saving" ? "Making the voice profile from your read…" : card.lead}
            </Text>
          )}
          {over && card.summary ? (
            <View className="gap-2">
              {card.summary.rows.map((r) => (
                <View key={r.label} className="flex-row gap-3">
                  <Text className="w-28 text-sm text-foreground-muted">{r.label}</Text>
                  <Text className="flex-1 text-sm text-foreground">
                    {r.label === "Quality"
                      ? `${"●".repeat(card.summary!.quality)}${"○".repeat(3 - card.summary!.quality)} `
                      : ""}
                    {r.value}
                  </Text>
                </View>
              ))}
              {card.summary.tip ? (
                <Text className="rounded-lg border-l-2 border-primary bg-card px-3 py-2 text-sm text-foreground-muted">
                  {card.summary.tip}
                </Text>
              ) : null}
            </View>
          ) : (
            <>
              <Text
                accessibilityLiveRegion="polite"
                accessibilityLabel={current ? (current.why ?? `Read: ${current.text}`) : undefined}
                className="text-xs text-foreground-muted"
              >
                {read} of {card.lines.length} read
              </Text>
              <View className="h-1.5 overflow-hidden rounded-full bg-card">
                <View
                  className="h-full bg-primary"
                  style={{ width: `${Math.round((100 * read) / card.lines.length)}%` }}
                />
              </View>
              {card.lines.map((l, i) => {
                const live = l.state === "now" || l.state === "again";
                return (
                  <View
                    key={l.text}
                    className={`flex-row gap-2 rounded-lg px-3 py-2 ${l.state === "now" ? "bg-primary/10" : l.state === "again" ? "bg-warning/10" : ""}`}
                  >
                    <Text
                      importantForAccessibility="no"
                      className={`w-4 text-xs ${l.state === "again" ? "text-warning-foreground" : l.state === "todo" ? "text-foreground-muted" : "text-primary"}`}
                    >
                      {l.state === "todo" ? String(i + 1) : MARK[l.state]}
                    </Text>
                    <View className="flex-1">
                      <Text
                        numberOfLines={l.state === "done" ? 1 : undefined}
                        className={
                          live ? "text-base text-foreground" : "text-sm text-foreground-muted"
                        }
                      >
                        {live ? (
                          <Followed text={l.text} heard={l.heard} again={l.state === "again"} />
                        ) : (
                          l.text
                        )}
                      </Text>
                      {l.why ? (
                        <Text className="mt-1 text-xs font-medium text-warning-foreground">
                          {l.why}
                        </Text>
                      ) : null}
                    </View>
                  </View>
                );
              })}
              <View className="flex-row items-center gap-2">
                <Text className="flex-1 text-xs text-foreground-muted">
                  Listening through {card.mic}
                </Text>
                {card.phase === "reading" ? (
                  <View
                    accessibilityLabel="Microphone level"
                    className="h-1.5 w-20 overflow-hidden rounded-full bg-card"
                  >
                    <View
                      className="h-full bg-primary"
                      style={{ width: `${Math.round(card.level * 100)}%` }}
                    />
                  </View>
                ) : null}
              </View>
            </>
          )}
          <View className="flex-row justify-end gap-2 pt-2">
            {over ? <ControlPill variant="pill" label="Redo" onPress={props.onRedo} /> : null}
            <ControlPill variant="pill" label={over ? "Done" : "Cancel"} onPress={props.onClose} />
          </View>
        </ScrollView>
      </SafeAreaView>
    </Modal>
  );
}

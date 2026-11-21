/** "Is it you?": Face ID or a fingerprint when he kept his PIN for it, else his PIN, both checked by her brain. */
import { useEffect, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../../components/ui/AppText";
import {
  biometricOffered,
  biometricSaved,
  stepUpWithBiometric,
  stepUpWithPin,
  type StepUpCall,
} from "./stepUp";
import { useStepUpCall } from "./useStepUp";

export function UnlockSheet(props: {
  readonly title: string;
  readonly detail: string;
  /** What checks his PIN; her brain's household step-up unless the caller has its own (the private layer's). */
  readonly check?: StepUpCall;
  readonly onUnlocked: () => void;
  readonly onCancel: () => void;
}) {
  const household = useStepUpCall();
  const call = props.check ?? household;
  const insets = useSafeAreaInsets();
  const [saved, setSaved] = useState(false);
  const [pin, setPin] = useState("");
  const [line, setLine] = useState("");
  const [busy, setBusy] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads from the keychain whether Face ID can stand in for his PIN
  useEffect(() => {
    void biometricSaved().then(setSaved);
  }, []);
  const settle = (r: { readonly ok: boolean; readonly line: string }) => {
    setBusy(false);
    if (r.ok) props.onUnlocked();
    else setLine(r.line);
  };
  const withBiometric = () => {
    if (call === null || busy) return;
    setBusy(true);
    void stepUpWithBiometric(call, props.title).then(settle);
  };
  const withPin = () => {
    if (call === null || busy || pin.trim() === "") return;
    setBusy(true);
    void stepUpWithPin(call, pin.trim(), biometricOffered()).then((r) => {
      setPin("");
      settle(r);
    });
  };
  return (
    <KeyboardAvoidingView behavior="padding" className="absolute inset-0 justify-end bg-black/40">
      <Pressable accessibilityLabel="Cancel" className="flex-1" onPress={props.onCancel} />
      <View
        className="gap-3 rounded-t-3xl bg-background px-5 pt-5"
        style={{
          paddingBottom: Math.max(insets.bottom, 16) + 8,
          paddingLeft: insets.left + 20,
          paddingRight: insets.right + 20,
        }}
      >
        <Text className="text-lg text-foreground">{props.title}</Text>
        <Text className="text-sm text-foreground-muted">{props.detail}</Text>
        {call === null ? (
          <Text className="text-sm text-foreground-muted">Pair a computer first.</Text>
        ) : (
          <>
            {saved ? (
              <Pressable
                accessibilityRole="button"
                onPress={withBiometric}
                className="items-center rounded-full bg-primary py-3.5"
              >
                <Text className="text-primary-foreground">Unlock with Face ID or fingerprint</Text>
              </Pressable>
            ) : null}
            <View className="flex-row items-center gap-2 rounded-full bg-secondary px-4">
              <TextInput
                value={pin}
                onChangeText={setPin}
                placeholder="Your PIN"
                secureTextEntry
                keyboardType="number-pad"
                returnKeyType="go"
                onSubmitEditing={withPin}
                accessibilityLabel="Your PIN"
                className="flex-1 py-3 text-base text-foreground"
              />
              <Pressable accessibilityRole="button" onPress={withPin} disabled={busy}>
                <Text className="text-foreground">{busy ? "Checking…" : "Unlock"}</Text>
              </Pressable>
            </View>
            {line === "" ? null : <Text className="text-sm text-foreground-muted">{line}</Text>}
          </>
        )}
      </View>
    </KeyboardAvoidingView>
  );
}

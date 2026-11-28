/** "Is it you?": Face ID or a fingerprint when he kept his PIN for it, else his PIN, both checked by her brain. */
import { useEffect, useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../../components/ui/AppText";
import {
  biometricOffered,
  biometricSaved,
  ownerWithBiometric,
  stepUpWithBiometric,
  stepUpWithPin,
  type StepUpCall,
} from "./stepUp";
import { exitFallback } from "./exitFallback.logic";
import { useStepUpCall } from "./useStepUp";

export function UnlockSheet(props: {
  readonly title: string;
  readonly detail: string;
  /** What checks his PIN; her brain's household step-up unless the caller has its own (the private layer's). */
  readonly check?: StepUpCall;
  /** Another home's PIN: never offered or kept for Face ID, which holds his own home's. */
  readonly pinOnly?: boolean;
  /**
   * What is his phone's alone (leaving the Sleeve): his Face ID here is enough with no PIN, and when neither Face ID nor
   * his PIN can be checked a long hold lets him out. He is never locked out of his own phone.
   */
  readonly owner?: boolean;
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
  const [lastPin, setLastPin] = useState<{ readonly ok: boolean; readonly line: string } | null>(
    null,
  );
  const hold =
    props.owner === true && exitFallback({ biometric: biometricOffered(), pin: lastPin });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads from the keychain whether Face ID can stand in for his PIN
  useEffect(() => {
    if (props.pinOnly !== true) void biometricSaved().then(setSaved);
  }, [props.pinOnly]);
  const settle = (r: { readonly ok: boolean; readonly line: string }) => {
    setBusy(false);
    if (r.ok) props.onUnlocked();
    else setLine(r.line);
  };
  const withBiometric = () => {
    if (busy) return;
    if (props.owner === true) {
      setBusy(true);
      void ownerWithBiometric(props.title).then((ok) =>
        settle({ ok, line: ok ? "" : "Face ID didn't confirm it. Use your PIN instead." }),
      );
      return;
    }
    if (call === null) return;
    setBusy(true);
    void stepUpWithBiometric(call, props.title).then(settle);
  };
  const withPin = () => {
    if (call === null || busy || pin.trim() === "") return;
    setBusy(true);
    void stepUpWithPin(call, pin.trim(), props.pinOnly !== true && biometricOffered()).then((r) => {
      setPin("");
      setLastPin(r);
      settle(r);
    });
  };
  return (
    <KeyboardAvoidingView behavior="padding" className="absolute inset-0 justify-end bg-black/40">
      <Pressable accessibilityLabel="Cancel" className="flex-1" onPress={props.onCancel} />
      <View
        className="gap-3 rounded-t-3xl bg-screen px-5 pt-5"
        style={{
          paddingBottom: Math.max(insets.bottom, 16) + 8,
          paddingLeft: insets.left + 20,
          paddingRight: insets.right + 20,
        }}
      >
        <Text className="text-lg text-foreground">{props.title}</Text>
        <Text className="text-sm text-foreground-muted">{props.detail}</Text>
        {props.owner === true && biometricOffered() ? (
          <Pressable
            accessibilityRole="button"
            onPress={withBiometric}
            disabled={busy}
            className="items-center rounded-full bg-primary py-3.5"
          >
            <Text className="text-primary-foreground">Use Face ID or fingerprint</Text>
          </Pressable>
        ) : null}
        {hold || (props.owner === true && call === null) ? (
          <Pressable
            accessibilityRole="button"
            accessibilityHint="Hold for three seconds"
            delayLongPress={3000}
            onLongPress={props.onUnlocked}
            className="items-center rounded-full bg-secondary py-3.5"
          >
            <Text className="text-foreground">Hold here for 3 seconds to continue</Text>
          </Pressable>
        ) : null}
        {call === null ? (
          props.owner === true ? null : (
            <Text className="text-sm text-foreground-muted">Pair a computer first.</Text>
          )
        ) : (
          <>
            {saved && props.owner !== true ? (
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

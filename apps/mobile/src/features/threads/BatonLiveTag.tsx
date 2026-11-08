import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

/** A Claude Code session running now, in T3's own thread row (P5); the row already shows state and machine. */
export function BatonLiveTag({ live }: { readonly live: boolean }) {
  if (!live) return null;
  return (
    <View className="rounded bg-primary/10 px-1" accessibilityLabel="Live session">
      <Text className="text-[10px] font-medium text-primary">Live</Text>
    </View>
  );
}

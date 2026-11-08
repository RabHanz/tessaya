import { isLiveThreadId } from "@t3tools/baton-shared/liveThread";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";

/** A Claude Code session mirrored from a terminal, in T3's own thread row (P5); the row already shows state and machine. */
export function BatonLiveTag({ threadId }: { readonly threadId: string }) {
  if (!isLiveThreadId(threadId)) return null;
  return (
    <View className="rounded bg-primary/10 px-1" accessibilityLabel="Live session">
      <Text className="text-[10px] font-medium text-primary">Live</Text>
    </View>
  );
}

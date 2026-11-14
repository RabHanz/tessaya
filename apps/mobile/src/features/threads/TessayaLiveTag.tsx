import { View } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";

/** A Claude Code session running now, in T3's own thread row (P5); the row already shows state and machine. */
export function TessayaLiveTag({ live }: { readonly live: boolean }) {
  if (!live) return null;
  return (
    <View
      className="flex-row items-center gap-0.5 rounded bg-primary/10 px-1"
      accessibilityLabel="Terminal session"
      accessibilityHint="Running in a terminal; Tessaya controls it by typing into it."
    >
      <SymbolView name="terminal" size={10} tintColorClassName="accent-primary" type="monochrome" />
      <Text className="text-[10px] font-medium text-primary">Terminal</Text>
    </View>
  );
}

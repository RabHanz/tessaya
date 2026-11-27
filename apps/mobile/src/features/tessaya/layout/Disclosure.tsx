import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../../components/ui/AppSymbol";
import { AppText as Text } from "../../../components/ui/AppText";

/** A group that opens on a tap: its name and one line of what is inside, then its sections. */
export function Disclosure(props: {
  readonly title: string;
  readonly summary: string;
  readonly initiallyOpen?: boolean;
  readonly children: ReactNode;
}) {
  // his own choice, once he has made one; until then it follows initiallyOpen, which may change as data arrives
  const [chosen, setChosen] = useState<boolean | null>(null);
  const open = chosen ?? props.initiallyOpen === true;
  return (
    <View className="gap-4">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setChosen(!open)}
        className="min-h-14 flex-row items-center gap-3 rounded-2xl bg-grouped-card px-4 py-3 active:opacity-65"
      >
        <View className="min-w-0 flex-1 gap-0.5">
          <Text textRole="body" className="font-t3-medium text-foreground">
            {props.title}
          </Text>
          <Text textRole="footnote" className="text-foreground-muted" numberOfLines={2}>
            {props.summary}
          </Text>
        </View>
        <SymbolView
          name={open ? "chevron.up" : "chevron.down"}
          size={13}
          tintColorClassName="accent-icon-muted"
        />
      </Pressable>
      {open ? props.children : null}
    </View>
  );
}

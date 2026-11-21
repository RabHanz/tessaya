/**
 * The in-app island (M-126): a black pill under the notch or camera hole with the most urgent thing, and the rest
 * when tapped. It never animates; its dot and words change only when the state does.
 */
import type { IslandItem } from "@t3tools/tessaya-shared/island";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../../components/ui/AppText";

const DOT: Readonly<Record<IslandItem["kind"], string>> = {
  her: "#b9a3e3",
  needsYou: "#fcd34d",
  timer: "#ffffff",
  upcoming: "#7dd3c0",
  working: "#9ca3af",
};

export function IslandPill(props: {
  readonly items: ReadonlyArray<IslandItem>;
  readonly open: (href: string) => void;
}) {
  const { items } = props;
  const insets = useSafeAreaInsets();
  const [expanded, setExpanded] = useState(false);
  const top = items[0];
  if (top === undefined) return null;
  const go = (item: IslandItem) => {
    setExpanded(false);
    if (item.href !== null) props.open(item.href);
  };
  return (
    <View
      pointerEvents="box-none"
      style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: expanded ? 0 : undefined }}
    >
      {expanded ? (
        <Pressable
          accessibilityLabel="Close the island"
          onPress={() => setExpanded(false)}
          style={{ position: "absolute", left: 0, right: 0, top: 0, bottom: 0 }}
        />
      ) : null}
      <View
        pointerEvents="box-none"
        style={{
          paddingTop: insets.top + 4,
          paddingLeft: insets.left + 16,
          paddingRight: insets.right + 16,
        }}
        className="items-center"
      >
        {expanded ? (
          <View className="w-full max-w-md gap-1 rounded-3xl bg-black p-3">
            {items.map((item) => (
              <Pressable
                key={item.key}
                accessibilityRole="button"
                disabled={item.href === null}
                onPress={() => go(item)}
                className="flex-row items-center gap-3 rounded-2xl px-3 py-2.5"
              >
                <View
                  style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: DOT[item.kind] }}
                />
                <View className="flex-1">
                  <Text className="text-[15px] text-white" numberOfLines={1}>
                    {item.kind === "her" ? `Tessaya is ${item.label}` : item.label}
                  </Text>
                  {item.detail === "" ? null : (
                    <Text className="text-xs text-white/60" numberOfLines={1}>
                      {item.detail}
                    </Text>
                  )}
                </View>
              </Pressable>
            ))}
          </View>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${top.label}${items.length > 1 ? `, and ${items.length - 1} more` : ""}. Open the island`}
            onPress={() => setExpanded(true)}
            className="flex-row items-center gap-2 rounded-full bg-black px-3.5 py-1.5"
          >
            <View
              style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: DOT[top.kind] }}
            />
            <Text className="text-[13px] text-white" numberOfLines={1}>
              {top.label}
            </Text>
            {items.length > 1 ? (
              <Text className="text-[12px] text-white/60">+{items.length - 1}</Text>
            ) : null}
          </Pressable>
        )}
      </View>
    </View>
  );
}

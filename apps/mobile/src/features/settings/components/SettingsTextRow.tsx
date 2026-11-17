import type { ReactNode } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../../components/ui/AppText";

/** A row of words with optional controls under them: Tessaya's read-out pages (usage, activity, mood, presence). */
export function SettingsTextRow(props: {
  readonly title: string;
  readonly description?: string;
  readonly divider?: boolean;
  readonly children?: ReactNode;
}) {
  return (
    <View className={`gap-2 px-4 py-3${props.divider ? " border-t border-border-subtle" : ""}`}>
      <View accessible className="min-w-0 gap-0.5">
        <Text textRole="body" className="text-foreground">
          {props.title}
        </Text>
        {props.description === undefined || props.description === "" ? null : (
          <Text textRole="footnote" className="text-foreground-muted">
            {props.description}
          </Text>
        )}
      </View>
      {props.children === undefined ? null : (
        <View className="flex-row flex-wrap gap-2">{props.children}</View>
      )}
    </View>
  );
}

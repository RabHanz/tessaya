import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { IS_TESSAYA_APP } from "../../lib/tessayaBrand";
import { SettingsSection } from "./components/SettingsSection";

// The one place the Tessaya build names T3 Code: the MIT licence requires its notice to stay.
// The Tessaya babel rewrite skips files named upstreamCredit.*, so this text survives it.
export const UPSTREAM_CREDIT = "Built on T3 Code (open source, MIT)";
export const UPSTREAM_LICENSE = `MIT License

Copyright (c) 2026 T3 Tools Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the "Software"), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

export function UpstreamCreditSection() {
  if (!IS_TESSAYA_APP) return null;
  return (
    <SettingsSection title="Credits">
      <View className="gap-3 p-4">
        <Text className="text-lg text-foreground">{UPSTREAM_CREDIT}</Text>
        <Text selectable className="text-xs text-foreground-muted">
          {UPSTREAM_LICENSE}
        </Text>
      </View>
    </SettingsSection>
  );
}

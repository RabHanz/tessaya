import { type NavigationTab } from "./navigation-tab-order";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { UsageRouteScreen } from "../../usage/UsageRouteScreen";
import { TessayaDevicesScreen } from "../../tessaya/TessayaDevicesScreen";
import { TessayaTodayScreen } from "../../tessaya/TessayaTodayScreen";

export function WorkspaceExtraTab(props: {
  tab: Exclude<NavigationTab, "threads" | "pullRequests">;
}) {
  // Baton (0025-tessaya-phone.patch): Tessaya's app has its own Today and Devices tabs.
  if (props.tab === "today") return <TessayaTodayScreen />;
  if (props.tab === "devices") return <TessayaDevicesScreen />;
  return (
    <>
      <NativeStackScreenOptions options={{ headerSearchBarOptions: undefined }} />
      <UsageRouteScreen workspace />
    </>
  );
}

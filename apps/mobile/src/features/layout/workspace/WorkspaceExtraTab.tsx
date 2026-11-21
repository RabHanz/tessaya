import { type NavigationTab } from "./navigation-tab-order";
import { NativeStackScreenOptions } from "../../../native/StackHeader";
import { SettingsPersonasRouteScreen } from "../../settings/SettingsPersonasRouteScreen";
import { DevicesRouteScreen } from "../../tessaya/devices/DevicesRouteScreen";
import { TalkRouteScreen } from "../../tessaya/talk/TalkRouteScreen";
import { UsageRouteScreen } from "../../usage/UsageRouteScreen";

export function WorkspaceExtraTab(props: {
  tab: Exclude<NavigationTab, "threads" | "pullRequests">;
}) {
  return (
    <>
      <NativeStackScreenOptions options={{ headerSearchBarOptions: undefined }} />
      {props.tab === "talk" ? (
        <TalkRouteScreen />
      ) : props.tab === "personas" ? (
        <SettingsPersonasRouteScreen />
      ) : props.tab === "devices" ? (
        <DevicesRouteScreen />
      ) : (
        <UsageRouteScreen workspace />
      )}
    </>
  );
}

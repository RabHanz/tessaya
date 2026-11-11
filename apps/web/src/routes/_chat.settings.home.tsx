import { createFileRoute } from "@tanstack/react-router";

import { HomeSettingsPanel } from "../components/settings/HomeSettings";

export const Route = createFileRoute("/_chat/settings/home")({
  component: HomeSettingsPanel,
});

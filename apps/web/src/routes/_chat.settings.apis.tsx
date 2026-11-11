import { createFileRoute } from "@tanstack/react-router";

import { ApisSettingsPanel } from "../components/settings/ApisSettings";

export const Route = createFileRoute("/_chat/settings/apis")({
  component: ApisSettingsPanel,
});

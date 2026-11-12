import { createFileRoute } from "@tanstack/react-router";

import { TessayaPlacesPanel } from "../components/settings/TessayaPlaces";

export const Route = createFileRoute("/_chat/settings/tessaya")({
  component: () => <TessayaPlacesPanel />,
});

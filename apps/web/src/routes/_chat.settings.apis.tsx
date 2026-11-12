import { createFileRoute } from "@tanstack/react-router";

import { TessayaPlacesPanel } from "../components/settings/TessayaPlaces";

// Moved to Tessaya's window (2026-11); old links say where for one release, then this route goes.
export const Route = createFileRoute("/_chat/settings/apis")({
  component: () => <TessayaPlacesPanel moved="apis" />,
});

import { createFileRoute, notFound, redirect } from "@tanstack/react-router";

import { isTessayaPage, TessayaPageView } from "../components/settings/TessayaPlaces";

// Tessaya's window shows these pages inline; a browser can open them too.
export const Route = createFileRoute("/tessaya/$page")({
  // the Lab's bench (?bench=prompts): one page, opened on the bench a link or her voice names
  validateSearch: (search: Record<string, unknown>): { bench?: string } =>
    typeof search["bench"] === "string" ? { bench: search["bench"] } : {},
  beforeLoad: ({ context, params }) => {
    const { authGateState } = context;
    if (authGateState.status !== "authenticated") throw redirect({ to: "/pair", replace: true });
    if (!isTessayaPage(params.page)) throw notFound();
  },
  component: TessayaRouteView,
});

function TessayaRouteView() {
  const { page } = Route.useParams();
  return isTessayaPage(page) ? <TessayaPageView page={page} /> : null;
}

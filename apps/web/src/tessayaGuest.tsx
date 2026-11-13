/**
 * Tessaya's window shows T3's Tessaya pages (Hardware, Home Assistant, accounts, voices) in a webview. This is that
 * page's whole app: the pages, the environment connections and Clerk's identity, and nothing that owns client state.
 * The full app here was a second T3 that thought it was the main window: it wrote drafts back over T3's and ran
 * every app service twice. tessayaGuest.test.ts keeps those stores out of this module graph.
 */
import React from "react";
import ReactDOM from "react-dom/client";
import {
  createHashHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";

import "@fontsource-variable/inter";
import "./index.css";

import { hasCloudPublicConfig } from "./cloud/publicConfig";
import { TessayaPageView, isTessayaPage } from "./components/settings/TessayaPlaces";
import { AnchoredToastProvider, ToastProvider } from "./components/ui/toast";
import { resolveInitialServerAuthGateState } from "./environments/primary";
import { I18nProvider } from "./i18n/I18nProvider";
import { startI18n, whenLocaleReady } from "./i18n/runtime";
import { AppAtomRegistryProvider } from "./rpc/atomRegistry";
import { startHostEnvironmentLookup } from "./state/primaryEnvironment";

const rootRoute = createRootRoute({
  component: () => (
    <ToastProvider>
      <AnchoredToastProvider>
        <Outlet />
      </AnchoredToastProvider>
    </ToastProvider>
  ),
  // Tessaya's window sends any other address on to T3's own window (batonHome's did-navigate-in-page).
  notFoundComponent: () => null,
});

const pageRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/tessaya/$page",
  beforeLoad: async () => ({ authGateState: await resolveInitialServerAuthGateState() }),
  component: function GuestPage() {
    const { page } = pageRoute.useParams();
    const { authGateState } = pageRoute.useRouteContext();
    if (authGateState.status !== "authenticated")
      return <p className="p-6 text-sm text-muted-foreground">Open T3 Code to sign in first.</p>;
    return isTessayaPage(page) ? <TessayaPageView page={page} /> : null;
  },
});

const router = createRouter({
  routeTree: rootRoute.addChildren([pageRoute]),
  history: createHashHistory(),
});

startI18n();
startHostEnvironmentLookup();

const clerkPublishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;
// Remote environments sign in with T3 Connect; the identity is the desktop's one Clerk store.
const managedAuthShell =
  clerkPublishableKey && hasCloudPublicConfig()
    ? import("./components/clerk/ElectronManagedAuthShell").then((module) => module.default)
    : null;

export const startup = Promise.all([managedAuthShell, router.load().then(whenLocaleReady)]).then(
  ([ManagedAuthShell]) => {
    const app = (
      <I18nProvider>
        <AppAtomRegistryProvider>
          <RouterProvider router={router} />
        </AppAtomRegistryProvider>
      </I18nProvider>
    );
    ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
      <React.StrictMode>
        {ManagedAuthShell && clerkPublishableKey ? (
          <ManagedAuthShell publishableKey={clerkPublishableKey}>{app}</ManagedAuthShell>
        ) : (
          app
        )}
      </React.StrictMode>,
    );
  },
);

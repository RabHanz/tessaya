import { createMemoryHistory } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily; importing it here keeps its first transform out of the test's timeout.
import "~/components/ChatView";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import { selectThreadTerminalUiState, useTerminalUiStateStore } from "~/terminalUiStateStore";
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import { useTessayaPanesStore } from "./tessayaPanesStore";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock(
  "../../../../../packages/client-runtime/src/connection/driver.ts",
  async (importOriginal) => {
    const [actual, { fakeDriver }, Layer] = await Promise.all([
      importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
      import("../../../test/fakeEnvironment"),
      import("effect/Layer"),
    ]);
    return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
  },
);

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("opening the route's pane focuses its own composer, and each pane's terminal toggle opens its own terminal", async () => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1400, 800);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  const a = threadWithHistory("split-terminal-a", 1);
  const b = threadWithHistory("split-terminal-b", 1);
  using _environment = installFakeEnvironment([a, b]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const aRef = scopeThreadRef(ENVIRONMENT_ID, a.id);
  const bRef = scopeThreadRef(ENVIRONMENT_ID, b.id);
  useTessayaPanesStore
    .getState()
    .open({ kind: "server", threadRef: aRef }, { kind: "server", threadRef: bRef });
  using _panes = {
    [Symbol.dispose]: () => useTessayaPanesStore.setState(useTessayaPanesStore.getInitialState()),
  };
  const router = getRouter(createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${a.id}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText(`Answer 0 for ${b.id}.`), { timeout: 5_000 }).toBeVisible();
  const paneOf = (thread: { readonly title: string }) =>
    page.getByRole("region", { name: thread.title, exact: true }).element();

  // Every pane's composer once shared one handle, so the last pane mounted took the focus.
  await vi.waitFor(() => {
    expect(document.activeElement?.getAttribute("data-testid")).toBe("composer-editor");
    expect(paneOf(a).contains(document.activeElement)).toBe(true);
  });

  for (const thread of [a, b]) {
    const pane = paneOf(thread);
    pane.scrollIntoView();
    const toggle = pane.querySelector<HTMLElement>('[aria-label="Toggle terminal drawer"]');
    expect(toggle, `${thread.title} has a terminal toggle`).not.toBeNull();
    const paneBox = pane.getBoundingClientRect();
    const box = toggle!.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(paneBox.left);
    expect(box.right).toBeLessThanOrEqual(paneBox.right);
    // Nothing from another pane sits over it, so a click reaches this pane's own toggle.
    const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
    expect(toggle!.contains(hit)).toBe(true);
  }

  await page
    .getByRole("region", { name: b.title, exact: true })
    .getByRole("button", { name: "Toggle terminal drawer" })
    .click();
  await vi.waitFor(() => {
    const terminals = useTerminalUiStateStore.getState().terminalUiStateByThreadKey;
    expect(selectThreadTerminalUiState(terminals, bRef).terminalOpen).toBe(true);
    expect(selectThreadTerminalUiState(terminals, aRef).terminalOpen).toBe(false);
  });
});

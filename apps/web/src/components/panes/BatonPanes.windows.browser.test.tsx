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
import {
  ENVIRONMENT_ID,
  installFakeEnvironment,
  threadWithHistory,
  type FakeDriver,
} from "../../../test/fakeEnvironment";
import { render } from "../../../test/render";
import { useBatonPanesStore } from "./batonPanesStore";

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

it("a pane dragged in from another window docks here, and one dropped in another window leaves", async () => {
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(1400, 800);
  await using _viewport = {
    [Symbol.asyncDispose]: () => page.viewport(viewport.width, viewport.height),
  };
  const a = threadWithHistory("cross-a", 1);
  const b = threadWithHistory("cross-b", 1);
  const c = threadWithHistory("cross-c", 1);
  using _environment = installFakeEnvironment([a, b, c]);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const cTarget = { kind: "server" as const, threadRef: scopeThreadRef(ENVIRONMENT_ID, c.id) };
  useBatonPanesStore
    .getState()
    .open(
      { kind: "server", threadRef: scopeThreadRef(ENVIRONMENT_ID, a.id) },
      { kind: "server", threadRef: scopeThreadRef(ENVIRONMENT_ID, b.id) },
    );
  using _panes = {
    [Symbol.dispose]: () => useBatonPanesStore.setState(useBatonPanesStore.getInitialState()),
  };
  using other = Object.assign(new BroadcastChannel("t3code:baton-panes"), {
    [Symbol.dispose]: () => other.close(),
  });
  const router = getRouter(createMemoryHistory({ initialEntries: [`/${ENVIRONMENT_ID}/${a.id}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByText(`Answer 0 for ${b.id}.`), { timeout: 5_000 }).toBeVisible();
  const dropTargets = () =>
    document.querySelectorAll<HTMLElement>('[data-testid^="baton-pane-drop-"]');
  const [first, second] = useBatonPanesStore.getState().slots;

  // A drag that ends in the other window takes its drop targets away here too.
  other.postMessage({ type: "pane-drag", drag: { token: "t0", target: cTarget }, from: "w2" });
  await vi.waitFor(() => expect(dropTargets().length).toBe(2));
  other.postMessage({ type: "pane-drag-end", token: "t0" });
  await vi.waitFor(() => expect(dropTargets().length).toBe(0));

  other.postMessage({ type: "pane-drag", drag: { token: "t1", target: cTarget }, from: "w2" });
  await vi.waitFor(() => expect(dropTargets().length).toBe(2));
  const target = page.getByTestId(`baton-pane-drop-${second!.id}`).element();
  const box = target.getBoundingClientRect();
  const at = { clientX: box.right - 4, clientY: box.top + box.height / 2, bubbles: true };
  const carried = new DataTransfer();
  carried.setData("application/x-baton-pane", "t1");
  target.dispatchEvent(
    new DragEvent("dragover", { ...at, cancelable: true, dataTransfer: carried }),
  );
  await vi.waitFor(() => expect(target.querySelector("span")).not.toBeNull());
  target.dispatchEvent(new DragEvent("drop", { ...at, cancelable: true, dataTransfer: carried }));
  await vi.waitFor(() => {
    const keys = useBatonPanesStore.getState().slots.map((slot) => slot.target);
    expect(keys).toContainEqual(cTarget);
    expect(dropTargets().length).toBe(0);
  });

  // The pane this window drags out is dropped in another window: it leaves this one.
  const bar = page.getByTestId(`baton-pane-bar-${first!.id}`).element();
  bar.dispatchEvent(
    new DragEvent("dragstart", { bubbles: true, dataTransfer: new DataTransfer() }),
  );
  await vi.waitFor(() => expect(dropTargets().length).toBe(2));
  const moved = new DataTransfer();
  // Outside a real drag Chromium ignores the setter; the other window's drop is what sets it.
  Object.defineProperty(moved, "dropEffect", { value: "move" });
  bar.dispatchEvent(
    new DragEvent("dragend", {
      bubbles: true,
      dataTransfer: moved,
      screenX: window.screenX + 10,
      screenY: window.screenY + 10,
    }),
  );
  await vi.waitFor(() => {
    const slots = useBatonPanesStore.getState().slots;
    expect(slots.map((slot) => slot.id)).not.toContain(first!.id);
    expect(dropTargets().length).toBe(0);
  });
});

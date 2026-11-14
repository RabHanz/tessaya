import { R1_SETUP_CHARS } from "@t3tools/tessaya-shared/r1Setup";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { R1SetupSection, type R1Call } from "./R1SetupSection";

const QR = "T3R1:R1-A1B2C3:000102030405060708090A0B0C0D0E0F";

/** A pretend R1 over Web Bluetooth: records writes, says online after join. */
const fakeBluetooth = () => {
  const writes: Array<[string, string]> = [];
  const listeners: Array<() => void> = [];
  let status = new DataView(new ArrayBuffer(0));
  const characteristic = (uuid: string) => ({
    readValue: async () => status,
    writeValueWithResponse: async (v: Uint8Array) => {
      writes.push([uuid, new TextDecoder().decode(v)]);
      if (uuid === R1_SETUP_CHARS.join) {
        const bytes = new TextEncoder().encode('{"op":"join","state":"done","ok":true}');
        status = new DataView(bytes.buffer);
        for (const l of listeners) l();
      }
    },
    startNotifications: async () => undefined,
    addEventListener: (_: string, l: () => void) => void listeners.push(l),
    removeEventListener: () => {},
    dispatchEvent: () => true,
  });
  return {
    writes,
    bluetooth: {
      requestDevice: async () => ({
        gatt: {
          connect: async () => ({
            getPrimaryService: async () => ({
              getCharacteristic: async (uuid: string) => characteristic(uuid),
            }),
          }),
        },
      }),
    },
  };
};

describe("Add an R1", () => {
  it("pairs over Bluetooth with the server's claim, then asks about away once", async () => {
    const r1 = fakeBluetooth();
    const call = vi.fn<R1Call>(async (_kind, op) =>
      op === "claim"
        ? { ok: true, value: { blob: "SEALED" } }
        : { ok: true, value: { status: "done", line: "Away from home is on." } },
    );
    await using screen = await render(
      <R1SetupSection
        call={call}
        awayOffered={false}
        bluetooth={r1.bluetooth as never}
        onChanged={() => {}}
      />,
      { router: false }, // a settings section with no links
    );
    await userEvent.fill(screen.getByLabelText("Pairing code"), QR);
    // Nothing to type until a pairing asks: the R1's eyes show its own digits then.
    await expect
      .element(screen.getByLabelText("The 6 digits on the Tessel's eyes"))
      .not.toBeInTheDocument();
    await userEvent.fill(screen.getByLabelText("Wi-Fi name"), "Home");
    await userEvent.fill(screen.getByLabelText("Wi-Fi password"), "secret");
    await userEvent.click(screen.getByRole("button", { name: "Set up over Bluetooth" }));
    await expect.element(screen.getByText("Your Tessel is set up.")).toBeVisible();
    expect(call).toHaveBeenCalledWith("owner", "claim", {
      deviceId: "r1-a1b2c3",
      oneTimeKey: "000102030405060708090A0B0C0D0E0F",
    });
    expect(r1.writes.map(([uuid]) => uuid)).toEqual([
      R1_SETUP_CHARS.ssid,
      R1_SETUP_CHARS.pass,
      R1_SETUP_CHARS.claim,
      R1_SETUP_CHARS.join,
    ]);
    expect(r1.writes[2]![1]).toBe("SEALED");
    await userEvent.click(screen.getByRole("button", { name: "Yes, turn it on" }));
    await expect.element(screen.getByText("Away from home is on.")).toBeVisible();
    expect(call).toHaveBeenLastCalledWith("owner", "away", { id: "r1-a1b2c3", enabled: true });
  });

  it("gives a setup code without Bluetooth, and does not ask about away again", async () => {
    const call = vi.fn<R1Call>(async () => ({ ok: true, value: { blob: "SEALED" } }));
    await using screen = await render(
      <R1SetupSection call={call} awayOffered bluetooth={null} onChanged={() => {}} />,
      { router: false }, // a settings section with no links
    );
    await userEvent.fill(screen.getByLabelText("Pairing code"), QR);
    await expect
      .element(screen.getByRole("button", { name: "Set up over Bluetooth" }))
      .not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Get a setup code" }));
    await expect.element(screen.getByLabelText("Setup code")).toHaveValue("SEALED");
    await expect
      .element(screen.getByText("Use your Tessel away from home too?"))
      .not.toBeInTheDocument();
  });

  it("in the desktop app, asks him for the digits on the R1's eyes when the pairing needs them", async () => {
    let ask: ((r: { kind: "providePin" }) => Promise<{ confirmed: boolean; pin?: string }>) | null =
      null;
    const answers: Array<unknown> = [];
    using _bridge = {
      saved: (globalThis as { batonDesktopBridge?: unknown }).batonDesktopBridge,
      [Symbol.dispose]() {
        (globalThis as { batonDesktopBridge?: unknown }).batonDesktopBridge = this.saved;
      },
    };
    (globalThis as { batonDesktopBridge?: unknown }).batonDesktopBridge = {
      onR1BlePairing: (handler: typeof ask) => {
        ask = handler;
        return () => {};
      },
    };
    const r1 = fakeBluetooth();
    // The system pairs while connecting: here the desktop's handler asks the page.
    const connect = r1.bluetooth.requestDevice;
    r1.bluetooth.requestDevice = async () => {
      answers.push(await ask!({ kind: "providePin" }));
      return connect();
    };
    const call = vi.fn<R1Call>(async () => ({ ok: true, value: { blob: "SEALED" } }));
    await using screen = await render(
      <R1SetupSection
        call={call}
        awayOffered
        bluetooth={r1.bluetooth as never}
        onChanged={() => {}}
      />,
      { router: false }, // a settings section with no links
    );
    await userEvent.fill(screen.getByLabelText("Pairing code"), QR);
    await userEvent.fill(screen.getByLabelText("Wi-Fi name"), "Home");
    await userEvent.click(screen.getByRole("button", { name: "Set up over Bluetooth" }));
    const digits = screen.getByLabelText("The 6 digits on the Tessel's eyes");
    await expect.element(digits).toHaveValue("");
    await userEvent.fill(digits, "48 29 13");
    await userEvent.click(screen.getByRole("button", { name: "Pair" }));
    await expect.element(screen.getByText("Your Tessel is set up.")).toBeVisible();
    expect(answers).toEqual([{ confirmed: true, pin: "482913" }]);
  });
});

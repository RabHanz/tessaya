import { R1_SETUP_CHARS } from "@t3tools/baton-shared/r1Setup";
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
    get value() {
      return status;
    },
    writeValueWithResponse: async (v: Uint8Array) => {
      writes.push([uuid, new TextDecoder().decode(v)]);
      if (uuid === R1_SETUP_CHARS.join) {
        const bytes = new TextEncoder().encode('{"state":"online"}');
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
  it("shows the passkey, pairs over Bluetooth with the server's claim, then asks about away once", async () => {
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
    await expect.element(screen.getByText("975000")).toBeVisible();
    await userEvent.fill(screen.getByLabelText("Wi-Fi name"), "Home");
    await userEvent.fill(screen.getByLabelText("Wi-Fi password"), "secret");
    await userEvent.click(screen.getByRole("button", { name: "Set up over Bluetooth" }));
    await expect.element(screen.getByText("Your R1 is set up.")).toBeVisible();
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
      .element(screen.getByText("Use your R1 away from home too?"))
      .not.toBeInTheDocument();
  });
});

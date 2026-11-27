import type { RegisteredDevice } from "@t3tools/tessaya-contracts";
import { when } from "@t3tools/tessaya-shared/deviceView";

export interface DeviceListRow {
  readonly id: string;
  readonly name: string;
  readonly line: string;
  readonly kind: "tessel" | "phone" | "desktop" | "other";
  readonly here: boolean;
}

const KIND_ORDER = { tessel: 0, phone: 1, desktop: 2, other: 3 } as const;

const kindOf = (d: Pick<RegisteredDevice, "kind" | "via">): DeviceListRow["kind"] =>
  d.kind === "phone"
    ? "phone"
    : d.kind === "desktop"
      ? "desktop"
      : d.via === "mqtt"
        ? "tessel"
        : "other";

const KIND_LABEL = {
  tessel: "Tessel",
  phone: "Phone",
  desktop: "Desk body",
  other: "Device",
} as const;

/** Every body she lives in, one line each: Tessels first, this phone, then his other phones and desks. */
export const deviceRows = (
  registry: ReadonlyArray<RegisteredDevice>,
  thisPhone: string | null,
): ReadonlyArray<DeviceListRow> =>
  registry
    .filter((d) => d.stale !== true || d.deviceId === thisPhone)
    .map((d): DeviceListRow => {
      const kind = kindOf(d);
      const here = d.deviceId === thisPhone;
      const state = here
        ? "here"
        : d.asleep === true
          ? "asleep"
          : d.online
            ? "on"
            : d.lastSeenAt === null
              ? "offline"
              : `last heard ${when(d.lastSeenAt)}`;
      return {
        id: d.deviceId,
        name: here ? "This phone" : d.name,
        line: `${KIND_LABEL[kind]} · ${state}`,
        kind,
        here,
      };
    })
    .sort(
      (a, b) =>
        KIND_ORDER[a.kind] - KIND_ORDER[b.kind] ||
        Number(b.here) - Number(a.here) ||
        a.name.localeCompare(b.name),
    );

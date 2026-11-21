import type { FleetFingerprint } from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  DEPLOY_WINDOW_MS,
  FLEET_STALE_MS,
  fleetFindings,
  storeOf,
  talksToHome,
} from "./coherence.ts";

const NOW = 1_800_000_000_000;
const fp = (over: Partial<FleetFingerprint> = {}): FleetFingerprint => ({
  id: "brain-env",
  name: "my server",
  kind: "server",
  host: "studio",
  addresses: ["10.0.0.5"],
  version: "0.1.5-tessaya.209",
  commit: "3a6475a56f",
  startedAt: NOW - 3_600_000,
  brain: null,
  account: null,
  stores: {},
  sentAt: NOW,
  receivedAt: NOW,
  ...over,
});
const home = fp();
const keys = (fleet: ReadonlyArray<FleetFingerprint>) =>
  fleetFindings(fleet, NOW).map((f) => f.key);

describe("talksToHome", () => {
  it.each([
    ["a worker naming home's environment", { brain: "env:brain-env" }, true],
    ["a worker naming another environment", { brain: "env:office-env" }, false],
    [
      "a loop on the office box sending to the brain's tailnet IP",
      { host: "office", brain: "url:10.0.0.5:3773" },
      true,
    ],
    [
      "a loop sending to the brain's MagicDNS name",
      { host: "office", brain: "url:studio.tail.example" },
      true,
    ],
    // 21 Nov: the laptop's standby loop ran Tumble's turns on the laptop's own server
    [
      "a standby loop on the laptop sending to loopback",
      { host: "laptop", brain: "url:127.0.0.1:3773" },
      false,
    ],
    [
      "a loop on the brain's own host sending to loopback",
      { host: "studio", brain: "url:127.0.0.1:3773" },
      true,
    ],
    ["a server that thinks it is the brain", { brain: null }, false],
  ] as const)("%s", (_, over, expected) => {
    expect(talksToHome(fp({ id: "other", ...over }), home)).toBe(expected);
  });
});

describe("fleetFindings", () => {
  it("says nothing when the fleet agrees", () => {
    const same = { voiceProfiles: storeOf(["owner|9|abc"]) };
    expect(
      keys([
        fp({ stores: same }),
        fp({ id: "office", name: "office", host: "office", brain: "env:brain-env", stores: same }),
      ]),
    ).toEqual([]);
  });

  it("names a copy that drifted from the brain's, and ignores stores that are each machine's own", () => {
    const fleet = [
      fp({ stores: { voiceProfiles: storeOf(["owner|9|57b5"]), wakeTrace: storeOf(["a"]) } }),
      fp({
        id: "laptop",
        name: "the laptop's server",
        host: "laptop",
        brain: "env:brain-env",
        stores: { voiceProfiles: storeOf(["owner|61|2cd5"]), wakeTrace: storeOf(["b"]) },
      }),
    ];
    const [found] = fleetFindings(fleet, NOW);
    expect(found).toMatchObject({ key: "fleet:store:laptop:voiceProfiles", severity: "degraded" });
    expect(found!.says).toBe(
      "the laptop's server keeps a different copy of your voice profile from mine",
    );
    expect(keys(fleet)).toEqual(["fleet:store:laptop:voiceProfiles"]);
  });

  it("allows a rolling deploy, then names the build skew", () => {
    const behind = (startedAt: number) =>
      keys([
        fp({ startedAt }),
        fp({
          id: "laptop",
          name: "the laptop",
          brain: "env:brain-env",
          commit: "9bad270b15",
          startedAt: NOW - 7_200_000,
        }),
      ]);
    expect(behind(NOW - 60_000)).toEqual([]);
    expect(behind(NOW - DEPLOY_WINDOW_MS - 60_000)).toEqual(["fleet:version:laptop"]);
  });

  it("names one credential under two labels (a stale login label, 21 Nov)", () => {
    const fleet = [
      fp({ account: { label: "alice-token", digest: "13ec60" } }),
      fp({
        id: "office",
        name: "office",
        brain: "env:brain-env",
        account: { label: "alice", digest: "13ec60" },
      }),
    ];
    expect(keys(fleet)).toEqual(["fleet:account:13ec60"]);
  });

  it("names a skewed clock and a machine that went quiet, and judges nothing else of a quiet one", () => {
    const fleet = [
      home,
      fp({ id: "laptop", name: "the laptop", brain: "env:brain-env", sentAt: NOW - 5_000 }),
      fp({
        id: "phone",
        name: "your phone",
        brain: "env:wrong",
        sentAt: NOW - FLEET_STALE_MS - 1,
        receivedAt: NOW - FLEET_STALE_MS - 1,
      }),
    ];
    expect(keys(fleet).toSorted()).toEqual(["fleet:clock:laptop", "fleet:quiet:phone"]);
  });

  it("orders the findings worst first", () => {
    const fleet = [
      home,
      fp({
        id: "loop",
        name: "Tumble's room loop",
        host: "laptop",
        brain: "url:127.0.0.1:3773",
        commit: null,
      }),
    ];
    expect(fleetFindings(fleet, NOW).map((f) => f.severity)).toEqual(["degraded", "minor"]);
  });
});

describe("storeOf", () => {
  it("is the same digest whatever the order", () => {
    expect(storeOf(["b", "a"])).toEqual(storeOf(["a", "b"]));
    expect(storeOf(["a"]).digest).not.toBe(storeOf(["b"]).digest);
  });
});

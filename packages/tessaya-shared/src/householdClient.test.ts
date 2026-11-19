import { EnvironmentId } from "@t3tools/contracts";
import type { PhonePairingResult } from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vitest";

import { householdToJoin, pickTessayaEnvironment } from "./householdClient.ts";

const id = (s: string) => EnvironmentId.make(s);

describe("one Tessaya on a client", () => {
  it("reads the brain while it is connected, else any connected machine, else none", () => {
    expect(pickTessayaEnvironment([id("laptop"), id("studio")], id("studio"))).toBe("studio");
    expect(pickTessayaEnvironment([id("laptop")], id("studio"))).toBe("laptop");
    expect(pickTessayaEnvironment([id("laptop")], null)).toBe("laptop");
    expect(pickTessayaEnvironment([], id("studio"))).toBeNull();
  });

  it("adds only the household machines the phone doesn't have yet", () => {
    const codes = {
      linked: [
        { environmentId: id("studio"), label: "studio", pairingUrl: "https://studio/pair#token=A" },
        { environmentId: id("office"), label: "office", pairingUrl: "https://office/pair#token=B" },
      ],
    } as unknown as PhonePairingResult;
    expect(householdToJoin(codes, new Set(["studio", "laptop"]))).toEqual([
      { environmentId: "office", pairingUrl: "https://office/pair#token=B" },
    ]);
  });
});

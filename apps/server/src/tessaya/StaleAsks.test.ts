import { describe, expect, it } from "vite-plus/test";

import { staleAskIds } from "./StaleAsks.ts";

const PREFIX = "baton-live4:ask:";
const session = "cc828d1b-2b64-4a21-8aaf-2d1f0c2f99eb";
const ids = [
  `${PREFIX}${session}:1793747877700`,
  `${PREFIX}${session}:1793748188513`,
  `${PREFIX}${session}:1793749000000`,
];

describe("question cards left pending on a live thread", () => {
  it("replays the incident: three pending asks and a pane no longer waiting expire all of them", () => {
    expect(
      staleAskIds(
        ids.map((id) => ({ id })),
        PREFIX,
        null,
      ),
    ).toEqual(ids);
  });
  it("keeps only the card shown now, and leaves requests that are not the mirror's alone", () => {
    expect(
      staleAskIds(
        [...ids, "native-request-1"].map((id) => ({ id })),
        PREFIX,
        ids[2]!,
      ),
    ).toEqual([ids[0], ids[1]]);
  });
});

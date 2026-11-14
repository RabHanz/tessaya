import { buildNightly } from "@t3tools/tessaya-shared/nightly";
import { describe, expect, it } from "vite-plus/test";

import { createNightlyCache, readNightly } from "./nightlyRead.ts";

const file = JSON.stringify(
  buildNightly({
    now: "2026-11-03T03:30:00Z",
    runUrl: "u",
    main: "abc",
    release: null,
    checks: [{ name: "memory evals", ref: "main", outcome: "success" }],
  }),
);
const b64 = Buffer.from(file).toString("base64");

describe("reading the last nightly", () => {
  it("decodes the file from the status branch and says null for anything else", async () => {
    expect((await readNightly("o/r", async () => `${b64}\n`))?.checks).toHaveLength(1);
    expect(await readNightly("o/r", async () => Promise.reject(new Error("no gh")))).toBeNull();
    expect(await readNightly("o/r", async () => Buffer.from("junk").toString("base64"))).toBeNull();
  });
  it("asks the repository once per half hour", async () => {
    let asked = 0;
    let t = 0;
    const read = createNightlyCache(
      "o/r",
      async () => (asked++, b64),
      () => t,
    );
    await read();
    t = 10 * 60_000;
    await read();
    expect(asked).toBe(2); // the nightly file and the sync file, once
    t = 31 * 60_000;
    await read();
    expect(asked).toBe(4);
  });
});

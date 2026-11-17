import { expect, it } from "vite-plus/test";

import { createHealthReport, readHost } from "./healthReport.ts";

it("counts each Tessel's wakes for the hour, keeps the median round trip and every failed turn", () => {
  let now = 0;
  const r = createHealthReport(() => now);
  const input = { host: readHost(0), services: [], replay: { line: "", degraded: false } };
  r.attempt("t1");
  r.attempt("t1");
  r.accept("t1");
  r.attempt("t2");
  for (const ms of [900, 80, 70]) r.rtt(ms);
  r.brainFailed();
  expect(r.report("t1", input)).toMatchObject({
    wake: { attempts: 2, accepts: 1, since: 0 },
    brain: { rttMs: 80, failures: [0] },
  });
  now = 3_600_001;
  expect(r.report("t1", input).wake).toEqual({ attempts: 0, accepts: 0, since: now });
});

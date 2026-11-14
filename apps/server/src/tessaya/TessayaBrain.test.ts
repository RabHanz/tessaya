import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import type { RoomToolSet } from "../home/R1Brain.ts";
import { personaTools } from "./TessayaBrain.ts";

it.effect("a persona's own tool list is all the brain offers or runs for it, on every vessel", () =>
  Effect.gen(function* () {
    const ran: Array<string> = [];
    const all: RoomToolSet = {
      specs: ["home_do", "tessaya_jobs", "job_start"].map((name) => ({
        name,
        description: name,
        input_schema: {},
      })),
      run: (name) => Effect.sync(() => (ran.push(name), { text: "ok", isError: false })),
    };
    const hers = personaTools(all, ["tessaya_jobs"]);
    expect(hers.specs.map((t) => t.name)).toEqual(["tessaya_jobs"]);
    expect((yield* hers.run("job_start", {})).isError).toBe(true);
    expect((yield* hers.run("tessaya_jobs", {})).text).toBe("ok");
    expect(ran).toEqual(["tessaya_jobs"]);
  }),
);

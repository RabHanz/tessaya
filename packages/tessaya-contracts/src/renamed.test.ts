import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { TessayaAccountPoolSource } from "./accountPool.ts";
import { TessayaContextProducer } from "./context.ts";
import { TessayaIntentEvent } from "./intent.ts";
import { TessayaJobRevision } from "./jobs.ts";

const decodeIntentEvent = Schema.decodeSync(TessayaIntentEvent);
const decodeJobRevision = Schema.decodeSync(TessayaJobRevision);

describe("rename R1: the Tessaya spelling decodes to the name this build writes", () => {
  it.each([
    [TessayaContextProducer, "tessaya", "fabric"],
    [TessayaContextProducer, "fabric", "fabric"],
    [TessayaContextProducer, "voice", "voice"],
    [TessayaAccountPoolSource, "tessaya", "fabric"],
    [TessayaAccountPoolSource, "cswap", "cswap"],
  ] as const)("%#: %s", (schema: Schema.Codec<string, string>, wire, decoded) => {
    expect(Schema.decodeSync(schema)(wire)).toBe(decoded);
    expect(Schema.encodeSync(schema)(decoded)).toBe(decoded);
  });

  it("an event kind and a job revision written by the next build", () => {
    const at = "2026-11-09T10:00:00.000Z";
    const received = { id: "intent-1", text: "hello", at };
    expect(decodeIntentEvent({ ...received, kind: "tessaya.intent.received" as const })).toEqual({
      ...received,
      kind: "fabric.intent.received",
    });
    const revision = { at, via: "thread" as const, text: "add tests" };
    expect(decodeJobRevision({ ...revision, by: "tessaya" as const })).toEqual({
      ...revision,
      by: "baton",
    });
  });
});

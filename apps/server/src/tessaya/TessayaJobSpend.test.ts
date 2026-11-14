// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { findTranscript, spendOf } from "./TessayaJobSpend.ts";
import { parseRateTable } from "../usage/usagePricing.ts";

const rates = parseRateTable({
  "claude-sonnet-4-5": {
    input_cost_per_token: 3e-6,
    output_cost_per_token: 15e-6,
    cache_read_input_token_cost: 3e-7,
    cache_creation_input_token_cost: 3.75e-6,
  },
});

const claudeLine = (id: string, out: number, model = "claude-sonnet-4-5") =>
  JSON.stringify({
    type: "assistant",
    requestId: `r${id}`,
    message: {
      id,
      model,
      usage: {
        input_tokens: 1000,
        output_tokens: out,
        cache_read_input_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    },
  });

const home = () => {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "spend-"));
  NodeFS.mkdirSync(NodePath.join(dir, ".claude", "projects", "proj-a"), { recursive: true });
  return dir;
};

describe("a job's spend from its transcript", () => {
  it("finds the session's transcript and prices what it used", () => {
    const h = home();
    const id = "11111111-2222-3333-4444-555555555555";
    NodeFS.writeFileSync(
      NodePath.join(h, ".claude", "projects", "proj-a", `${id}.jsonl`),
      [claudeLine("m1", 1000), claudeLine("m2", 2000)].join("\n"),
    );
    expect(findTranscript(id, h)?.kind).toBe("claude");
    const s = spendOf({ nativeIds: [id], stateDir: h, home: h, rates });
    // 2000 in at 3e-6 + 3000 out at 15e-6
    expect(s.tokens).toBe(5000);
    expect(s.dollars).toBeCloseTo(0.006 + 0.045, 6);
    expect(s.partial).toBe(false);
  });
  it("says it is a floor when a transcript is missing or a model has no price, and never invents zero", () => {
    const h = home();
    const id = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    NodeFS.writeFileSync(
      NodePath.join(h, ".claude", "projects", "proj-a", `${id}.jsonl`),
      claudeLine("m1", 10, "mystery-model"),
    );
    const unpriced = spendOf({ nativeIds: [id], stateDir: h, home: h, rates });
    expect(unpriced.dollars).toBeNull();
    expect(unpriced.partial).toBe(true);
    const missing = spendOf({
      nativeIds: ["99999999-9999-9999-9999-999999999999"],
      stateDir: h,
      home: h,
      rates,
    });
    expect(missing).toEqual({ tokens: 0, dollars: null, partial: true });
    expect(spendOf({ nativeIds: [id], stateDir: h, home: h, rates: null }).dollars).toBeNull();
  });
  it("will not follow an id that could climb out of the folders", () => {
    expect(findTranscript("../../etc/passwd", home())).toBeNull();
  });
});

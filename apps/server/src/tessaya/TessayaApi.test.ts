import type { PhoneState } from "@t3tools/tessaya-shared/phone";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { describe, expect, it } from "vite-plus/test";

import type { PhoneAsk } from "@t3tools/tessaya-shared/phoneRelay";

import {
  CLOUD_APPROVE_SCOPE,
  handlePhone,
  OPERATE_SCOPE,
  READ_SCOPE,
  readCapped,
  uploadRefusal,
  type PhoneDeps,
} from "./TessayaApi.ts";

const state: PhoneState = {
  badge: 1,
  needs: [],
  approvals: [
    {
      id: "p:j1",
      kind: "plan",
      title: "Site",
      action: "Start the work as planned",
      permission: "x",
      ref: "j1",
      answerable: true,
    },
    {
      id: "s:k",
      kind: "session",
      title: "Sess",
      action: "Answer its question",
      permission: "x",
      ref: "k",
      answerable: false,
    },
    {
      id: "d:pr1",
      kind: "prompt",
      title: "Run it?",
      action: "Click Save in Notes",
      permission: "Asked on your computer",
      ref: "pr1",
      answerable: true,
      yes: 0,
      cancel: 1,
    },
  ],
  now: [],
  jobs: [
    { id: "j1", title: "Site", status: "waiting", canStop: false, canRetry: false, retryWhy: "no" },
    {
      id: "run",
      title: "R",
      status: "working",
      canStop: true,
      canRetry: false,
      retryWhy: "It has not failed",
    },
    { id: "bad", title: "B", status: "failed", canStop: false, canRetry: true, retryWhy: null },
  ],
  weaves: [],
  desktop: { connected: true },
  asks: [],
};
const make = (connected = true) => {
  const calls: string[] = [];
  const asks = new Map<string, PhoneAsk>();
  const deps: PhoneDeps = {
    state: async () => state,
    agree: async (id) => void calls.push(`agree ${id}`),
    stop: async (id) => (calls.push(`stop ${id}`), true),
    retry: async (id) => (calls.push(`retry ${id}`), "Asked it to try again."),
    ask: async (id, text) => {
      if (text.trim() === "") return { ok: false, why: "Say something." };
      const ask: PhoneAsk = asks.get(id) ?? {
        id,
        text: text.trim(),
        source: "phone",
        origin: "phone",
        hisVoice: false,
        status: "queued",
        createdAt: 0,
        expiresAt: 1,
        spoken: null,
        card: null,
        error: null,
      };
      if (!asks.has(id)) calls.push(`ask ${text.trim()}`);
      asks.set(id, ask);
      return { ok: true, ask };
    },
    askGet: async (id) => ({ ask: asks.get(id) ?? null, connected }),
    answerPrompt: async (id, index) => (calls.push(`prompt ${id} ${index}`), id === "pr1"),
    transcribe: async () => ({ ok: true, text: "what needs me" }),
  };
  return { deps, calls, asks };
};
const read = new Set([READ_SCOPE]);
const operate = new Set([READ_SCOPE, OPERATE_SCOPE]);
const approver = new Set([...operate, CLOUD_APPROVE_SCOPE]);
const wav = () => {
  const b = new Uint8Array(100);
  const v = new DataView(b.buffer);
  b.set([82, 73, 70, 70], 0);
  b.set([87, 65, 86, 69], 8);
  v.setUint16(22, 1, true);
  v.setUint32(24, 16_000, true);
  v.setUint16(34, 16, true);
  return b;
};

describe("the phone API", () => {
  it("reads with the read scope and refuses every change without the operate scope", async () => {
    const { deps, calls } = make();
    expect((await handlePhone(deps, { method: "GET", path: "state", scopes: read })).status).toBe(
      200,
    );
    expect(
      (await handlePhone(deps, { method: "GET", path: "state", scopes: new Set() })).status,
    ).toBe(403);
    for (const path of ["approvals/p:j1", "jobs/run/stop", "ask", "voice"]) {
      expect(
        (
          await handlePhone(deps, {
            method: "POST",
            path,
            scopes: read,
            json: { decision: "approve", text: "x" },
            bytes: wav(),
          })
        ).status,
      ).toBe(403);
    }
    expect(calls).toEqual([]);
  });

  it("answers an approval only while it waits and still says what the page showed", async () => {
    const { deps, calls } = make();
    const post = (path: string, json: unknown) =>
      handlePhone(deps, { method: "POST", path, scopes: operate, json });
    expect(
      (await post("approvals/p:j1", { decision: "approve", action: "Start the work as planned" }))
        .status,
    ).toBe(200);
    expect(
      (await post("approvals/p:j1", { decision: "deny", action: "Start the work as planned" }))
        .status,
    ).toBe(200);
    expect(
      (await post("approvals/p:j1", { decision: "approve", action: "Something else" })).status,
    ).toBe(409);
    expect((await post("approvals/p:gone", { decision: "approve", action: "x" })).status).toBe(404);
    expect(
      (await post("approvals/s:k", { decision: "approve", action: "Answer its question" })).status,
    ).toBe(409);
    expect((await post("approvals/p:j1", { decision: "maybe" })).status).toBe(400);
    expect(calls).toEqual(["agree j1", "stop j1"]);
  });

  it("stops what runs and retries what failed, and says why not otherwise", async () => {
    const { deps, calls } = make();
    const post = (path: string) => handlePhone(deps, { method: "POST", path, scopes: operate });
    expect((await post("jobs/run/stop")).status).toBe(200);
    expect((await post("jobs/bad/stop")).status).toBe(409);
    expect((await post("jobs/bad/retry")).json["message"]).toBe("Asked it to try again.");
    expect(await post("jobs/run/retry")).toMatchObject({
      status: 409,
      json: { message: "It has not failed" },
    });
    expect(calls).toEqual(["stop run", "retry bad"]);
  });

  it("queues typed and heard words for the desktop with a client id, once, and tells him when the computer is away", async () => {
    const { deps, calls, asks } = make(false);
    const post = (json: unknown) =>
      handlePhone(deps, { method: "POST", path: "ask", scopes: operate, json });
    const first = await post({ id: "client-1234", text: "  what is running " });
    expect(first).toMatchObject({
      status: 202,
      json: {
        id: "client-1234",
        status: "queued",
        line: "Your computer is not connected; it will answer when it is back.",
      },
    });
    await post({ id: "client-1234", text: "what is running" });
    expect((await post({ id: "client-1234", text: "   " })).status).toBe(400);
    expect(calls).toEqual(["ask what is running"]);
    asks.set("client-1234", {
      ...asks.get("client-1234")!,
      status: "answered",
      card: "Two jobs are running.",
    });
    expect(
      (await handlePhone(deps, { method: "GET", path: "ask/client-1234", scopes: read })).json,
    ).toMatchObject({ status: "answered", line: "Two jobs are running." });
    expect(
      (await handlePhone(deps, { method: "GET", path: "ask/nope", scopes: read })).status,
    ).toBe(404);
    const heard = await handlePhone(deps, {
      method: "POST",
      path: "voice",
      scopes: operate,
      bytes: wav(),
      clientId: "voice-client-1",
    });
    expect(heard).toMatchObject({
      status: 202,
      json: { heard: "what needs me", id: "voice-client-1" },
    });
    expect(
      (
        await handlePhone(deps, {
          method: "POST",
          path: "voice",
          scopes: operate,
          bytes: new Uint8Array(100),
        })
      ).status,
    ).toBe(400);
  });

  it("carries a question the desktop is asking to the phone and back: the exact text, the right button, once", async () => {
    const { deps, calls } = make();
    const post = (decision: string, action = "Click Save in Notes", scopes = approver) =>
      handlePhone(deps, {
        method: "POST",
        path: "approvals/d:pr1",
        scopes,
        json: { decision, action },
      });
    // The desktop's own gate (hands, vault, screen) is not answerable with operate alone.
    expect((await post("approve", "Click Save in Notes", operate)).status).toBe(403);
    expect((await post("approve")).status).toBe(200);
    expect((await post("deny")).status).toBe(200);
    expect((await post("approve", "Delete everything")).status).toBe(409);
    expect(calls).toEqual(["prompt pr1 0", "prompt pr1 1"]);
    // A person whose role may not give this yes is told why, not that it was already answered.
    const refusing = { ...deps, answerPrompt: async () => "A child can't say yes to this." };
    const childYes = await handlePhone(refusing, {
      method: "POST",
      path: "approvals/d:pr1",
      scopes: approver,
      json: { decision: "approve", action: "Click Save in Notes" },
    });
    expect([childYes.status, JSON.stringify(childYes.json)]).toEqual([
      403,
      expect.stringContaining("A child can't say yes"),
    ]);
  });

  it("answers a question with a button for each answer by its index, only within range", async () => {
    const { deps, calls } = make();
    const withButtons: PhoneDeps = {
      ...deps,
      state: async () => {
        const s = await deps.state();
        return {
          ...s,
          approvals: [
            {
              id: "d:pr1",
              kind: "prompt",
              title: "Cloud task waiting",
              action: "Fix the flaky test",
              permission: "x",
              ref: "pr1",
              answerable: true,
              yes: 0,
              cancel: 3,
              buttons: ["Claude - a", "Codex - b", "Deny", "Decide later"],
            },
          ],
        };
      },
    };
    const post = (json: Record<string, unknown>) =>
      handlePhone(withButtons, { method: "POST", path: "approvals/d:pr1", scopes: approver, json });
    expect((await post({ choice: 1, action: "Fix the flaky test" })).status).toBe(200);
    expect((await post({ choice: 4, action: "Fix the flaky test" })).status).toBe(400);
    expect((await post({ choice: -1, action: "Fix the flaky test" })).status).toBe(400);
    expect((await post({ choice: 0, action: "Something else" })).status).toBe(409);
    expect(calls).toEqual(["prompt pr1 1"]);
  });

  it("lets a phone answer a cloud approval only if it holds the approval permission", async () => {
    const { deps, calls } = make();
    const cloudQuestion: PhoneDeps = {
      ...deps,
      state: async () => {
        const s = await deps.state();
        return {
          ...s,
          approvals: [
            {
              id: "d:pr1",
              kind: "prompt",
              title: "Cloud task waiting",
              action: "Fix it",
              permission: "x",
              ref: "pr1",
              answerable: true,
              yes: 0,
              cancel: 3,
              needs: "cloud-approve",
              buttons: ["Claude - a", "Codex - b", "Deny", "Decide later"],
            },
          ],
        };
      },
    };
    const post = (scopes: ReadonlySet<string>) =>
      handlePhone(cloudQuestion, {
        method: "POST",
        path: "approvals/d:pr1",
        scopes,
        json: { choice: 0, action: "Fix it" },
      });
    const refused = await post(operate);
    expect(refused.status).toBe(403);
    expect(calls).toEqual([]);
    expect((await post(new Set([...operate, "baton:cloud-approve"]))).status).toBe(200);
    expect(calls).toEqual(["prompt pr1 0"]);
  });

  it("refuses a recording before reading it: no operate scope, or a stated size over the cap", () => {
    expect(uploadRefusal(read, "1000")?.status).toBe(403);
    expect(uploadRefusal(read, undefined)?.status).toBe(403);
    expect(uploadRefusal(operate, undefined)).toBeNull();
    expect(uploadRefusal(operate, String(6 * 1024 * 1024 + 1))?.status).toBe(413);
    expect(uploadRefusal(operate, "abc")?.status).toBe(413);
    expect(uploadRefusal(operate, "1000")).toBeNull();
  });

  effectIt.effect(
    "reads a chunked recording whole under the cap and stops reading at once past it",
    () =>
      Effect.gen(function* () {
        const chunk = new Uint8Array([1, 2, 3, 4]);
        const whole = yield* readCapped(Stream.make(chunk, chunk), 8);
        expect(whole).toEqual(new Uint8Array([1, 2, 3, 4, 1, 2, 3, 4]));
        let pulled = 0;
        const endless = Stream.fromEffectRepeat(Effect.sync(() => ((pulled += 1), chunk)));
        const over = yield* readCapped(endless, 8);
        expect(over).toMatchObject({ status: 413 });
        expect(pulled).toBe(3);
      }),
  );

  it("says 501 when the server cannot transcribe", async () => {
    const { deps } = make();
    const off: PhoneDeps = {
      ...deps,
      transcribe: async () => ({
        ok: false,
        why: "Voice is not available on this server: it has no speech model here. Type instead.",
      }),
    };
    expect(
      await handlePhone(off, { method: "POST", path: "voice", scopes: operate, bytes: wav() }),
    ).toMatchObject({ status: 501 });
  });
});

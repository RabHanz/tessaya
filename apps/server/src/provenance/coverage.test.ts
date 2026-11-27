// @effect-diagnostics nodeBuiltinImport:off - the gate reads the wiring as source, the only way to see a bypass.
/**
 * The provenance coverage gate (B-046), like the voice-parity gate: a new tool, RPC, device command, job or Tessel
 * event must reach the action log without anyone remembering to add a line. Each check pins the one choke point
 * that does it, so a new path around it fails here.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  BATON_DEVICES_WS_METHODS,
  BATON_RECORD_WS_METHODS,
  TessayaRpcGroup,
} from "@t3tools/tessaya-contracts";
import { ORCHESTRATION_V2_WS_METHODS, WsRpcGroup } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { repeatedFault, roomActionOf } from "./roomActions.ts";
import { rpcChangesState } from "./rpcActions.ts";

const src = (file: string) =>
  NodeFS.readFileSync(NodePath.join(import.meta.dirname, "..", file), "utf8");

describe("every action reaches the log", () => {
  it("every MCP tool is registered through the wrapper that records it", () => {
    const mcp = src("mcp/McpHttpServer.ts");
    // The only two registration paths, both through withToolSpans, which records each call as tool.call.
    expect(mcp).toMatch(
      /withToolAnalytics\(\s*withToolResultCapture\(\s*withToolSpans\(\s*withClientInput\(\s*withAdvertisedSchemas/,
    );
    expect(mcp).toContain(
      "Layer.effectDiscard(withToolAnalytics(withToolResultCapture(withToolSpans(register))))",
    );
    expect(mcp).toMatch(/kind: "tool\.call"/);
    // No toolkit registers anywhere else.
    for (const file of NodeFS.readdirSync(NodePath.join(import.meta.dirname, ".."), {
      recursive: true,
    })) {
      const name = String(file);
      if (!name.endsWith(".ts") || name.endsWith(".test.ts") || name.endsWith("McpHttpServer.ts"))
        continue;
      const text = src(name);
      expect(text.includes("McpServer.registerToolkit") || text.includes(".addTool("), name).toBe(
        false,
      );
    }
  });

  it("every client RPC goes through the middleware that records the ones that change something", () => {
    const ws = src("ws.ts");
    expect(ws).toContain("rpcActionLayer(session)");
    expect(ws).not.toContain("rpcInstrumentationLayer");
    // Every method is classified; a mutation is never mistaken for a read by a missing scope.
    const tags = [...WsRpcGroup.requests.keys(), ...TessayaRpcGroup.requests.keys()];
    expect(tags.length).toBeGreaterThan(50);
    expect(rpcChangesState(ORCHESTRATION_V2_WS_METHODS.dispatchCommand)).toBe(true);
    expect(rpcChangesState(BATON_RECORD_WS_METHODS.list)).toBe(false);
    expect(rpcChangesState(BATON_DEVICES_WS_METHODS.call)).toBe(true);
    expect(rpcChangesState("a.method.nobody.mapped")).toBe(true);
  });

  it("device commands, model calls, Record rows (jobs, schedules, the pulse) and outcomes emit at their one door", () => {
    expect(src("home/HomeDevices.ts")).toMatch(/kind: "device\.cmd"/);
    expect(src("tessaya/BrainUsage.ts")).toMatch(/kind: "model\.call"/);
    expect(src("tessaya/TessayaRecordService.ts")).toMatch(/kind: `record\.\$\{entry\.kind\}`/);
    expect(src("tessaya/TessayaPlaybook.ts")).toMatch(/kind: "outcome\.job"/);
    expect(src("home/HomeDevices.ts")).toContain("roomActionOf(result.id, tail, payload)");
  });

  it("a fault the Tessel already reported is not recorded again when a reconnect replays it", () => {
    const seen = new Map<string, string>();
    const fault = JSON.stringify({ core: "ap", pc: "022f948e" });
    expect(repeatedFault(seen, "t1", "event/wake/fault", fault)).toBe(false);
    expect(repeatedFault(seen, "t1", "event/wake/fault", fault)).toBe(true);
    expect(repeatedFault(seen, "t2", "event/wake/fault", fault)).toBe(false);
    expect(
      repeatedFault(seen, "t1", "event/wake/fault", JSON.stringify({ core: "ap", pc: "1" })),
    ).toBe(false);
    expect(repeatedFault(seen, "t1", "event/key", "{}")).toBe(false);
  });

  it("Tessel and room-loop events become actions, and what he said never does", () => {
    const metrics = JSON.stringify({
      device: "t1",
      turn: 3,
      reason: "endpoint",
      text: "my bank pin is four four",
      speaker: "owner",
      speakerScore: 0.93,
      verified: false,
      host: "tessel-host",
      voiceIdMs: 120,
    });
    const action = roomActionOf("t1", "event/voice/metrics", metrics);
    // The verdict her brain acted on and the loop's host, so a turn is findable whichever host served it (G-30).
    expect(action).toMatchObject({
      kind: "room.voice_id",
      actor: { kind: "owner", certainty: 0.93 },
      outcome: "owner",
      data: { verified: false, host: "tessel-host" },
    });
    expect(JSON.stringify(action)).not.toContain("bank");
    expect(roomActionOf("t1", "event/button", JSON.stringify({ b: 1, long: true }))?.kind).toBe(
      "room.button",
    );
    expect(
      roomActionOf(
        "t1",
        "event/test/playback",
        JSON.stringify({ open: true, run: "osp replay 1" }),
      ),
    ).toMatchObject({ actor: { kind: "system" }, outcome: "open", data: { run: "osp replay 1" } });
    expect(
      roomActionOf(
        "t1",
        "event/wake/boot",
        JSON.stringify({ reason: 1, why: "a voice start or stop" }),
      )?.data,
    ).toMatchObject({ why: "a voice start or stop" });
    // A reset's power at its end, and who set the heap's low-water: one level of numbers and short enums is kept.
    const boot = roomActionOf(
      "t1",
      "event/wake/boot",
      JSON.stringify({
        reason: 0,
        ram: true,
        prev: { up_s: 540, bat_mv: 3612, spk: 1, note: "a b c" },
      }),
    )?.data;
    expect(boot).toMatchObject({ ram: true, prev: { up_s: 540, bat_mv: 3612, spk: 1 } });
    expect(JSON.stringify(boot)).not.toContain("a b c");
    expect(
      roomActionOf(
        "t1",
        "event/wake/stats",
        JSON.stringify({ heap: 51504, low: { task: "wdrv_thread", size: 32 } }),
      )?.data,
    ).toMatchObject({ low: { task: "wdrv_thread", size: 32 } });
    // the loop's remote reset of a wedged link is the loop's act, not the Tessel's
    expect(
      roomActionOf("t1", "event/link/dead", JSON.stringify({ silent_s: 180, try: 1, arp: true })),
    ).toMatchObject({
      kind: "room.link.dead",
      actor: { kind: "system", id: "room-loop" },
      data: { silent_s: 180, try: 1 },
    });
    expect(roomActionOf("t1", "event/enrol", "{}")).toBeNull();
    expect(roomActionOf("t1", "state/battery", "80")).toBeNull();
    expect(roomActionOf("t1", "state/online", "0")?.outcome).toBe("offline");
  });

  it("a tool call by voice, and the desktop's own acts and Settings saves, take the same doors", () => {
    // The room and the desk run the shared toolkit without MCP's wrapper, so the runner traces its own changes.
    expect(src("home/R1Tools.ts")).toMatch(/traced\(\{\s*kind: "tool\.call"/);
    expect(src("tessaya/TessayaRoutes.ts")).toContain('if (calledAs === "action")');
    const desktop = (file: string) => src(`../../desktop/src/tessaya/${file}`);
    expect(desktop("agent/tessayaTools.ts")).toContain("withActed(t, acted)");
    expect(desktop("screen/ScreenCompanion.ts")).toMatch(/acted: \(tool, outcome, ms, look\) =>/);
    for (const file of ["screen/ScreenCompanion.ts", "voice/DesktopTessayaVoice.ts"])
      expect(desktop(file), file).toMatch(/const save = [^\n]+\n\s+settingsSaved\(/);
  });
});

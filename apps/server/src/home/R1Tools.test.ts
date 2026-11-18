import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { TessayaToolkit } from "../mcp/toolkits/tessaya/tools.ts";
import {
  asAdvertised,
  CORE_TOOLS,
  DESK_TOOL_SPECS,
  jobVerdict,
  NOT_IN_ROOM,
  replayDryRun,
  roomRefusal,
  ROOM_TOOL_SPECS,
  setRoomVolume,
  stepUpNeeds,
} from "./R1Tools.ts";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { HomeAssistantService } from "./HomeAssistantService.ts";
import * as Layer from "effect/Layer";

import { EnvironmentId } from "@t3tools/contracts";
import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";
import { DeviceRefusedError } from "./DeviceRegistry.ts";
import { HomeDevices } from "./HomeDevices.ts";

const decodes = (name: keyof typeof TessayaToolkit.tools, input: unknown) => {
  const spec = ROOM_TOOL_SPECS.find((s) => s.name === name)!;
  const decode = Schema.decodeUnknownOption(TessayaToolkit.tools[name].parametersSchema);
  return Option.isSome(decode(asAdvertised(spec, input)));
};

describe("voice parity", () => {
  it("every Tessaya tool is in the room or says why not (16 Nov)", () => {
    const room = new Set(ROOM_TOOL_SPECS.map((s) => s.name));
    for (const name of Object.keys(TessayaToolkit.tools)) {
      const why = (NOT_IN_ROOM as Record<string, string>)[name];
      expect(room.has(name) !== (why !== undefined), name).toBe(true);
      if (why !== undefined) expect(why.length, name).toBeGreaterThan(10);
    }
    // What his keyboard could do and her voice could not: the playground, his dictionary, the main session.
    for (const name of ["tessaya_voice", "tessaya_vocabulary", "tessaya_main_session"])
      expect(DESK_TOOL_SPECS.map((s) => s.name)).toContain(name);
  });
});

describe("the room's tools for a replay", () => {
  it("never sends a replay's write, and leaves his own R1's calls alone (01:29, 13 Nov)", () => {
    const ask = { text: "approve the front door" };
    expect(replayDryRun("tessaya_ask", ask, "replay-1")).toMatchObject({
      isError: false,
      status: "done",
    });
    expect(replayDryRun("tessaya_ask", {}, "replay-1")?.isError).toBe(true);
    expect(replayDryRun("tessaya_ask", ask, "r1-3d57b3")).toBeNull();
    expect(replayDryRun("tessaya_record", {}, "replay-1")).toBeNull();
    // The house's writes go through the house's own checks as a dry run (HomeActor.dryRun).
    expect(replayDryRun("home_do", { domain: "fan" }, "replay-1")).toBeNull();
    // What she keeps (13 Nov audit, R1-P9): a replay's "say it this way" is answered, never saved.
    const word = { word: "Tessaya", sayAs: "Tess eye ya" };
    expect(replayDryRun("tessaya_pronounce", word, "replay-1")?.text).toContain("nothing was kept");
    expect(replayDryRun("tessaya_pronounce", word, "r1-3d57b3")).toBeNull();
    expect(replayDryRun("settings_set", { key: "holdKeyCues" }, "replay-1")).toBeNull();
    // A switch's read-back runs for real in a replay; flipping it does not.
    expect(replayDryRun("intercom_switch", {}, "replay-1")).toBeNull();
    expect(replayDryRun("memory_sync_switch", { on: false }, "replay-1")?.isError).toBe(false);
    // A hand-off answers as the real one does, so she never says "nothing changed" aloud (15 Nov suite).
    expect(replayDryRun("tessaya_persona_handoff", { to: "Onyx" }, "replay-1")?.text).toContain(
      "Onyx has this conversation now",
    );
    // "Forget me" asks first in a replay too; only the confirmed call is the write.
    expect(replayDryRun("people_forget_me", {}, "replay-1")?.text).toContain('"status":"asked"');
    expect(replayDryRun("people_forget_me", { confirmed: true }, "replay-1")?.text).toContain(
      "nothing changed",
    );
    // The pretend desktop's device acts are answered, never sent.
    const eye = { id: "r1-3d57b3", op: "eye", mood: "happy" };
    expect(replayDryRun("device_act", eye, "replay-desktop")?.isError).toBe(false);
    expect(replayDryRun("device_act", eye, "desktop")).toBeNull();
    const rule = {
      rule: {
        name: "Low battery",
        deviceId: "r1-3d57b3",
        itemId: "power.battery_pct",
        when: null,
        intent: "under 15 percent",
        then: null,
      },
      request: "warn me under 15 percent",
    };
    expect(replayDryRun("device_watch", rule, "replay-1")?.text).toContain("Saved the rule");
    // A job is opened as for real in words, and nothing starts.
    const job = { title: "Fix login", goal: "fix the login bug", project: "acme" };
    expect(replayDryRun("job_start", job, "replay-1")?.text).toContain("nothing was started");
    expect(replayDryRun("job_start", job, "r1-3d57b3")).toBeNull();
  });

  it("lists every vessel's tools core first, then by name, so a prompt's tool block stays cached", () => {
    for (const specs of [ROOM_TOOL_SPECS, DESK_TOOL_SPECS]) {
      const planned = specs.map((s) => [!CORE_TOOLS.has(s.name), s.name].join(" "));
      expect(planned).toEqual(planned.toSorted());
    }
    const desk = new Map(DESK_TOOL_SPECS.map((s) => [s.name, s.readonly]));
    expect([desk.get("home_find"), desk.get("home_do"), desk.get("device_act")]).toEqual([
      true,
      false,
      false,
    ]);
    // The desktop's own screen stays its own; the room's laptop is not its tool.
    expect(["laptop_ask", "tessaya_ask"].some((n) => desk.has(n))).toBe(false);
    // One set_device_volume: the desktop speaks through its own, and sets another device (`id`) through this one.
    expect(desk.get("set_device_volume")).toBe(false);
    // His work reaches the desktop from the one table: no job tool of its own (SPINE-UNIFY S2).
    expect(
      ["job_start", "job_agree", "job_schedule", "schedules_list", "project_add"].every((n) =>
        desk.has(n),
      ),
    ).toBe(true);
  });

  it("takes a number or a yes/no sent as a string, as every timer was (07:39, 13 Nov)", () => {
    const timer = {
      alias: "Fan off",
      kind: "temporary",
      runInMinutes: "1",
      actions: [],
      request: "on for one minute",
    };
    expect(decodes("home_automation_save", timer)).toBe(true);
    expect(decodes("tessaya_record", { limit: "10" })).toBe(true);
    expect(decodes("home_automations", { all: "true" })).toBe(true);
    expect(decodes("home_automation_save", { ...timer, runInMinutes: "soon" })).toBe(false);
  });

  it("reaches only what a guest's or another member's role does; the owner and an unjudged voice keep theirs", () => {
    const sara = { member: "sara", assurance: 2 as const };
    const adult = { role: "adult" as const, machine: false };
    const child = { role: "child" as const, machine: false };
    expect(roomRefusal({ member: "owner", assurance: 0 }, null, "laptop_ask")).toBeNull();
    expect(roomRefusal({ member: undefined }, null, "laptop_ask")).toBeNull();
    expect(roomRefusal(sara, adult, "laptop_ask")).not.toBeNull();
    expect(roomRefusal(sara, { ...adult, machine: true }, "laptop_ask")).toBeNull();
    expect(roomRefusal(sara, child, "home_do")).toBeNull();
    expect(roomRefusal(sara, child, "room_look")).not.toBeNull();
    expect(roomRefusal(sara, child, "tessaya_sessions")).not.toBeNull();
    // Only the owner (or a machine grant) flips the home's intercom or his memory sync.
    expect(roomRefusal(sara, adult, "intercom_switch")).not.toBeNull();
    expect(roomRefusal(sara, adult, "memory_sync_switch")).not.toBeNull();
    expect(
      roomRefusal({ member: null, assurance: 0 }, null, "tessaya_memory_search"),
    ).not.toBeNull();
    expect(roomRefusal({ member: null, assurance: 0 }, null, "settings_get")).toBeNull();
    expect(roomRefusal({ ...sara, assurance: 1 }, adult, "tessaya_memory_search")).toContain(
      "sure it's you",
    );
  });
  it("holds for a step-up only a change that needs more than the voice gave, never a read or their own memory", () => {
    expect(stepUpNeeds("settings_set", 1)).toBe(2);
    expect(stepUpNeeds("home_automation_save", 0)).toBe(2);
    expect(stepUpNeeds("settings_set", 2)).toBeNull();
    // A lamp needs A1, a read nothing, and their own memory has its rule in the turn.
    expect(stepUpNeeds("home_do", 0)).toBeNull();
    expect(stepUpNeeds("settings_get", 0)).toBeNull();
    expect(stepUpNeeds("tessaya_memory_remember", 0)).toBeNull();
    // 15 Nov, 08:19 GMT+5: his "say it in AM/PM" was held for a step-up that cut her reply off.
    expect(stepUpNeeds("tessaya_preference_set", 0)).toBeNull();
    // 18 Nov, 00:38 GMT+5: "who's on which device?" waited on an "Is this you?" card; a look is never held.
    expect(stepUpNeeds("tessaya_cast", 1, { action: "who" })).toBeNull();
    expect(stepUpNeeds("tessaya_cast", 1, { action: "call", persona: "alfred" })).toBe(2);
    expect(stepUpNeeds("access_manage", 1, { op: "links" })).toBeNull();
  });
  it("judges a job act by the desktop's own table: a schedule waits for his phone, a stop needs only his voice", () => {
    expect(jobVerdict("job_start", { project: "acme", goal: "fix it" }, false)).toBe("allow");
    expect(jobVerdict("job_stop", { id: "job-1" }, false)).toBe("allow");
    expect(jobVerdict("job_schedule", { id: "job-1", every_minutes: 60 }, false)).toHaveProperty(
      "card",
    );
    expect(jobVerdict("job_schedule", { id: "job-1", every_minutes: 0 }, false)).toHaveProperty(
      "card",
    );
    // Agreeing after reading something is never the model's own idea: his yes on a card.
    expect(jobVerdict("job_agree", { id: "job-1" }, true)).toHaveProperty("card");
    expect(jobVerdict("home_do", {}, true)).toBe("allow");
    // A new project and deleting a schedule wait for his phone; a run-now and a cloud request (its own card) do not.
    expect(jobVerdict("project_add", { repository: "acme/app" }, false)).toHaveProperty("card");
    expect(jobVerdict("schedule_delete", { id: "t1" }, false)).toHaveProperty("card");
    expect(jobVerdict("schedule_run_now", { id: "t1" }, false)).toBe("allow");
    // Pausing stops spending, so his voice is enough; resuming starts unattended runs again, so it waits.
    expect(jobVerdict("schedule_pause", { id: "t1", on: false }, false)).toBe("allow");
    expect(jobVerdict("schedule_pause", { id: "t1", on: true }, false)).toHaveProperty("card");
    expect(jobVerdict("cloud_dispatch", { repo: "acme/app" }, false)).toBe("allow");
    // Upkeep and access (16 Nov parity): reads go ahead; deleting, signing out, a restart and any access change wait.
    expect(jobVerdict("environment_maintain", { op: "refresh_providers" }, false)).toBe("allow");
    for (const op of ["clean_storage", "reclaim_space", "sign_out"])
      expect(jobVerdict("environment_maintain", { op }, false)).toHaveProperty("card");
    expect(jobVerdict("access_manage", { op: "links" }, false)).toBe("allow");
    for (const op of ["link", "unlink", "share_thread", "answer_link_request"])
      expect(jobVerdict("access_manage", { op }, false)).toHaveProperty("card");
    // Neither has a reach of its own, so only his verified voice may use them at all.
    expect(stepUpNeeds("access_manage", 1)).toBe(2);
    expect(stepUpNeeds("environment_maintain", 1)).toBe(2);
    // The intercom and memory sync share across devices and servers: on waits for his yes, off and a read do not.
    for (const name of ["intercom_switch", "memory_sync_switch"]) {
      expect(jobVerdict(name, { on: true }, false)).toHaveProperty("card");
      expect(jobVerdict(name, { on: false }, false)).toBe("allow");
      expect(jobVerdict(name, {}, false)).toBe("allow");
      expect(stepUpNeeds(name, 1)).toBe(2);
    }
    // The prompt lab: trying variants is free to ask for; making one live, or rolling back, waits for his yes.
    expect(jobVerdict("tessaya_prompt_lab", { action: "run" }, false)).toBe("allow");
    expect(jobVerdict("tessaya_prompt_lab", { action: "promote" }, false)).toHaveProperty("card");
    expect(jobVerdict("tessaya_prompt_lab", { action: "rollback" }, false)).toHaveProperty("card");
    // The turn's persona narrows it, as on the desktop: only the lead hands out work, and only from its own tools.
    const freya = { name: "Freya", lead: false, tools: ["job_list", "job_stop"] };
    expect(jobVerdict("job_start", { project: "acme", goal: "fix it" }, false, freya)).toEqual({
      refused: "Only the lead hands out work, and Freya is not the lead.",
    });
    expect(jobVerdict("job_agree", { id: "job-1" }, false, freya)).toEqual({
      refused: "job_agree is not one of Freya's tools.",
    });
    expect(jobVerdict("job_stop", { id: "job-1" }, false, freya)).toBe("allow");
    expect(
      jobVerdict("job_start", { project: "acme", goal: "fix it" }, false, {
        ...freya,
        lead: true,
        tools: null,
      }),
    ).toBe("allow");
    // Starting work is the owner's (machine reach, A2): a lower voice is held for a step-up.
    expect(stepUpNeeds("job_start", 1)).toBe(2);
    expect(stepUpNeeds("job_stop", 2)).toBeNull();
  });
});

effectIt.effect(
  "set_device_volume sets the device the turn is heard on, or the one he names by its id",
  () =>
    Effect.gen(function* () {
      const set: Array<readonly [string, unknown]> = [];
      const run = (input: unknown) =>
        setRoomVolume(input, "r1-here").pipe(
          Effect.provideService(HomeAssistantService, {
            device: Effect.succeed({ deviceId: "r1-here" }),
          } as never),
          Effect.provideService(HomeDevices, {
            command: (id: string, command: { readonly to: unknown }) =>
              Effect.sync(() => (set.push([id, command.to]), { line: "Better?" })),
          } as never),
        );
      expect((yield* run({ to: "up" })).text).toBe("Better?");
      yield* run({ to: 40, id: "r1-kitchen" });
      expect(set).toEqual([
        ["r1-here", "up"],
        ["r1-kitchen", 40],
      ]);
      // 18 Nov, 23:07: the brain's turn set Tumble to 40% on its own hub, where she isn't; the server whose hub has her
      // sets it, and only a refusal from every server is said as one.
      const NOT_HERE = "It didn't go through: Tumble isn't linked to this server's hub right now.";
      const asked: unknown[] = [];
      const there = yield* setRoomVolume({ to: 40 }, "r1-3d57b3").pipe(
        Effect.provideService(HomeAssistantService, {
          device: Effect.succeed({ deviceId: "r1-3d57b3" }),
        } as never),
        Effect.provideService(HomeDevices, {
          command: () => Effect.fail(new DeviceRefusedError({ why: NOT_HERE, notLinked: true })),
        } as never),
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(PeerLinks.PeerLinks)({
              enabled: Effect.succeed(true),
              list: Effect.succeed([
                {
                  environmentId: EnvironmentId.make("env-home"),
                  label: "home",
                  status: "reachable",
                },
              ] as never),
            }),
            Layer.mock(PeerMcpClient.PeerMcpClient)({
              call: (input) =>
                Effect.sync(() => {
                  asked.push([input.tool, input.arguments]);
                  return { ok: true, value: { status: "done", line: "Volume 40%." } };
                }) as never,
            }),
          ),
        ),
      );
      expect(there).toMatchObject({ text: "Volume 40%.", isError: false });
      expect(asked).toMatchObject([["set_device_volume", { id: "r1-3d57b3", to: 40 }]]);
    }),
);

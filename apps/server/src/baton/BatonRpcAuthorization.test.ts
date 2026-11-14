import {
  AuthAccessReadScope,
  AuthBatonCloudApproveScope,
  AuthBatonHandsHostScope,
  AuthBatonMemorySyncScope,
  AuthFilesystemReadScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthStandardClientScopes,
  BATON_ACCOUNT_WS_METHODS,
  BATON_CLOUD_WS_METHODS,
  BATON_DESKTOP_SETTINGS_WS_METHODS,
  BATON_JOB_WS_METHODS,
  BATON_LIVE_WS_METHODS,
  BATON_MEMORY_WS_METHODS,
  BATON_PHONE_WS_METHODS,
  BATON_HOME_WS_METHODS,
  BATON_DEVICES_WS_METHODS,
  BATON_LEARN_WS_METHODS,
  BATON_VOICE_WS_METHODS,
  BATON_RECORD_WS_METHODS,
  BATON_SESSIONS_WS_METHODS,
  BATON_PROMPT_LAB_WS_METHODS,
  AuthSettingsWriteScope,
  BatonRecordAppendInput,
  DesktopSettingsSetInput,
  AuthGrantScopes,
  BatonRpcGroup,
  BatonRpcScopeAuthorization,
  tessayaSpelling,
} from "@t3tools/baton-contracts";
import { clientRpcRequiredScopes, type AuthEnvironmentScope } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { it as effectIt } from "@effect/vitest";
import { roleCeiling } from "@t3tools/baton-shared/household";
import { describe, expect, it } from "vite-plus/test";

import { TOKEN_DELEGATED_SUBJECT, type AuthenticatedSession } from "../auth/EnvironmentAuth.ts";
import { MemoryViewer } from "./BatonMemoryService.ts";
import { AskSource } from "./BatonPhoneInbox.ts";
import {
  BATON_RPC_REQUIRED_SCOPES,
  DESK_METHODS,
  askSourceOf,
  householdCallerOf,
  householdRefusal,
  privateRefusal,
  refusedAsDevice,
  layer as batonAuthorization,
  memoryViewerOf,
  missingBatonScope,
} from "./BatonRpcAuthorization.ts";

describe("who may use the prompt lab", () => {
  it("needs settings:write on the server and in the client, which only the owner (or a machine grant) holds", () => {
    const door = BATON_PROMPT_LAB_WS_METHODS.call;
    expect(BATON_RPC_REQUIRED_SCOPES[door]).toBe(AuthSettingsWriteScope);
    expect(clientRpcRequiredScopes(door, { op: "list" })).toEqual([AuthSettingsWriteScope]);
    expect(roleCeiling("owner", false)).toContain(AuthSettingsWriteScope);
    for (const role of ["admin", "member", "child", "guest"] as const)
      expect(roleCeiling(role, false)).not.toContain(AuthSettingsWriteScope);
  });
});

describe("who may use cloud tasks on a hub", () => {
  it("lets any reader look, any operator ask, and only a holder of the approval scope approve or deny", () => {
    expect(BATON_RPC_REQUIRED_SCOPES[BATON_CLOUD_WS_METHODS.read]).toBe(AuthOrchestrationReadScope);
    expect(BATON_RPC_REQUIRED_SCOPES[BATON_CLOUD_WS_METHODS.act]).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(BATON_RPC_REQUIRED_SCOPES[BATON_CLOUD_WS_METHODS.approve]).toBe(
      AuthBatonCloudApproveScope,
    );
  });

  it("does not give the approval scope to the scopes a paired client gets by default", () => {
    expect(AuthStandardClientScopes).not.toContain(AuthBatonCloudApproveScope);
    // Every default scope can reach the other cloud doors, none can reach approve.
    const reach = (door: string) =>
      AuthStandardClientScopes.includes(
        BATON_RPC_REQUIRED_SCOPES[door as keyof typeof BATON_RPC_REQUIRED_SCOPES] as never,
      );
    expect(reach(BATON_CLOUD_WS_METHODS.read)).toBe(true);
    expect(reach(BATON_CLOUD_WS_METHODS.act)).toBe(true);
    expect(reach(BATON_CLOUD_WS_METHODS.approve)).toBe(false);
  });
});

describe("who may import memory from a folder", () => {
  it("needs the desktop app's own session, operate and filesystem read, since it reads any folder on the machine", () => {
    const narrowed = [AuthOrchestrationReadScope, AuthOrchestrationOperateScope] as const;
    expect(missingBatonScope(BATON_MEMORY_WS_METHODS.import, narrowed)).toBe(
      AuthFilesystemReadScope,
    );
    expect(missingBatonScope(BATON_MEMORY_WS_METHODS.import, [AuthFilesystemReadScope])).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(missingBatonScope(BATON_MEMORY_WS_METHODS.import, AuthStandardClientScopes)).toBe(
      AuthBatonHandsHostScope,
    );
    expect(
      missingBatonScope(BATON_MEMORY_WS_METHODS.import, [
        ...AuthStandardClientScopes,
        AuthBatonHandsHostScope,
      ]),
    ).toBeNull();
    expect(missingBatonScope(BATON_MEMORY_WS_METHODS.list, narrowed)).toBeNull();
  });

  it("lets only the desktop app's own session work the phone inbox; a client may only ask", () => {
    const call = BATON_PHONE_WS_METHODS.call;
    const desktop = [...AuthStandardClientScopes, AuthBatonHandsHostScope];
    for (const op of ["take", "answer", "fail", "prompt", "promptPoll", "promptClose"]) {
      expect(missingBatonScope(call, AuthStandardClientScopes, { op, args: {} })).toBe(
        AuthBatonHandsHostScope,
      );
      expect(missingBatonScope(call, desktop, { op, args: {} })).toBeNull();
    }
    expect(missingBatonScope(call, AuthStandardClientScopes, { op: "ask", args: {} })).toBeNull();
  });

  it("takes a home act as already approved only from the desktop app's own session", () => {
    const call = BATON_HOME_WS_METHODS.call;
    const desktop = [...AuthStandardClientScopes, AuthBatonHandsHostScope];
    const approved = { kind: "act", op: "do", args: { approved: true } };
    expect(missingBatonScope(call, AuthStandardClientScopes, approved)).toBe(
      AuthBatonHandsHostScope,
    );
    expect(missingBatonScope(call, desktop, approved)).toBeNull();
    expect(
      missingBatonScope(call, AuthStandardClientScopes, { kind: "act", op: "do", args: {} }),
    ).toBeNull();
  });

  it("scopes a home call by its kind: read looks, act operates, answer needs the approval scope", () => {
    const call = BATON_HOME_WS_METHODS.call;
    const read = { kind: "read", op: "find", args: {} };
    expect(missingBatonScope(call, [AuthOrchestrationReadScope], read)).toBeNull();
    expect(missingBatonScope(call, [AuthOrchestrationReadScope], { ...read, kind: "act" })).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(missingBatonScope(call, AuthStandardClientScopes, { ...read, kind: "answer" })).toBe(
      AuthBatonCloudApproveScope,
    );
    expect(missingBatonScope(call, [AuthOrchestrationReadScope], { ...read, kind: "other" })).toBe(
      AuthOrchestrationOperateScope,
    );
    // The voice library the same way: a preview is a read, a persona's voice or the Google key is operate.
    const voice = BATON_VOICE_WS_METHODS.call;
    const preview = { kind: "read", op: "preview", args: {} };
    expect(missingBatonScope(voice, [AuthOrchestrationReadScope], preview)).toBeNull();
    expect(
      missingBatonScope(voice, [AuthOrchestrationReadScope], { ...preview, kind: "act" }),
    ).toBe(AuthOrchestrationOperateScope);
  });

  it("scopes a devices call by its kind: read looks, act operates, owner needs the approval scope", () => {
    const call = BATON_DEVICES_WS_METHODS.call;
    const read = { kind: "read", op: "list", args: {} };
    expect(missingBatonScope(call, [AuthOrchestrationReadScope], read)).toBeNull();
    expect(missingBatonScope(call, [AuthOrchestrationReadScope], { ...read, kind: "act" })).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(missingBatonScope(call, AuthStandardClientScopes, { ...read, kind: "owner" })).toBe(
      AuthBatonCloudApproveScope,
    );
    expect(
      missingBatonScope(call, [...AuthStandardClientScopes, AuthBatonCloudApproveScope], {
        ...read,
        kind: "owner",
      }),
    ).toBeNull();
    expect(missingBatonScope(call, [AuthOrchestrationReadScope], { ...read, kind: "other" })).toBe(
      AuthOrchestrationOperateScope,
    );
    // The clients' guard (permissionAtom) asks for the same scopes, so a control is greyed out exactly when refused.
    for (const kind of ["read", "act", "owner"])
      for (const scopes of [
        [AuthOrchestrationReadScope],
        AuthStandardClientScopes,
        [...AuthStandardClientScopes, AuthBatonCloudApproveScope],
      ] as ReadonlyArray<ReadonlyArray<AuthEnvironmentScope>>)
        expect(
          clientRpcRequiredScopes(call, { ...read, kind }).find((s) => !scopes.includes(s)) ?? null,
          `${kind} with ${scopes.length} scopes`,
        ).toBe(missingBatonScope(call, scopes, { ...read, kind }));
  });

  it("lets only the desktop app's own session search through walls", () => {
    const search = BATON_MEMORY_WS_METHODS.search;
    const admin = { text: "deploy key", admin: true };
    expect(missingBatonScope(search, AuthStandardClientScopes, admin)).toBe(
      AuthBatonHandsHostScope,
    );
    expect(missingBatonScope(search, [AuthOrchestrationReadScope], { text: "deploy key" })).toBe(
      null,
    );
    expect(
      missingBatonScope(search, [...AuthStandardClientScopes, AuthBatonHandsHostScope], admin),
    ).toBeNull();
  });
});

describe("rename R1: every method also answers as tessaya.*", () => {
  it("refuses a token's device the account methods under either name", () => {
    const device = {
      method: "bearer-access-token",
      scopes: AuthStandardClientScopes,
      subject: "x",
    } as const;
    const his = {
      method: "browser-session-cookie",
      scopes: AuthStandardClientScopes,
      subject: "one-time-token",
    } as const;
    // Methods added after the rename have one name only (see BatonRpcGroup in baton-contracts).
    for (const tag of Object.keys(BATON_RPC_REQUIRED_SCOPES).filter(
      (t) =>
        t !== BATON_HOME_WS_METHODS.call &&
        t !== BATON_DEVICES_WS_METHODS.call &&
        t !== BATON_VOICE_WS_METHODS.call &&
        t !== BATON_LEARN_WS_METHODS.call,
    )) {
      const renamed = tessayaSpelling(tag);
      expect(refusedAsDevice(renamed, device), renamed).toBe(refusedAsDevice(tag, device));
      expect(refusedAsDevice(renamed, his), renamed).toBe(false);
    }
    expect(refusedAsDevice("tessaya.account.setOnLimit", device)).toBe(true);
  });

  it("is in the group under both names and needs exactly what the old name needs, payload rules included", () => {
    const callers = [
      [],
      AuthStandardClientScopes,
      [AuthBatonMemorySyncScope],
      [...AuthStandardClientScopes, AuthBatonHandsHostScope],
    ];
    const payloads = [undefined, { text: "deploy key", admin: true }, { action: "run" }];
    // Methods added after the rename have one name only (see BatonRpcGroup in baton-contracts).
    for (const tag of Object.keys(BATON_RPC_REQUIRED_SCOPES).filter(
      (t) =>
        t !== BATON_HOME_WS_METHODS.call &&
        t !== BATON_DEVICES_WS_METHODS.call &&
        t !== BATON_VOICE_WS_METHODS.call &&
        t !== BATON_LEARN_WS_METHODS.call,
    )) {
      const renamed = tessayaSpelling(tag);
      expect(BatonRpcGroup.requests.has(renamed), renamed).toBe(true);
      for (const scopes of callers)
        for (const payload of payloads)
          expect(missingBatonScope(renamed, scopes, payload), renamed).toBe(
            missingBatonScope(tag, scopes, payload),
          );
    }
  });
});

describe("the desktop's direct door while T3's window is closed", () => {
  it("serves only methods with a declared scope, places jobs rather than starting them raw, and lets only the desktop's own session read a folder", () => {
    for (const method of DESK_METHODS)
      expect(Object.hasOwn(BATON_RPC_REQUIRED_SCOPES, method)).toBe(true);
    // A job starts only by placement, which picks the project and worker on this server.
    expect(DESK_METHODS.has(BATON_JOB_WS_METHODS.jobStart)).toBe(false);
    expect(DESK_METHODS.has(BATON_JOB_WS_METHODS.jobPlace)).toBe(true);
    // The session list is a read; typing into a pane here needs the operate scope.
    expect(missingBatonScope(BATON_SESSIONS_WS_METHODS.across, [AuthOrchestrationReadScope])).toBe(
      AuthAccessReadScope,
    );
    expect(missingBatonScope(BATON_SESSIONS_WS_METHODS.across, AuthStandardClientScopes)).toBe(
      null,
    );
    expect(missingBatonScope(BATON_LIVE_WS_METHODS.herdrSend, [AuthOrchestrationReadScope])).toBe(
      AuthOrchestrationOperateScope,
    );
    expect(DESK_METHODS.has(BATON_LIVE_WS_METHODS.herdrSend)).toBe(true);
    // This machine's catalog actions too; another machine's stay on T3's own session to it.
    expect(DESK_METHODS.has(BATON_SESSIONS_WS_METHODS.autoResume)).toBe(true);
    expect(DESK_METHODS.has(BATON_SESSIONS_WS_METHODS.retireHandoff)).toBe(false);
    // The folder is on this machine, and only the desktop app's own session holds the scope to read it.
    expect(DESK_METHODS.has(BATON_MEMORY_WS_METHODS.import)).toBe(true);
    expect(missingBatonScope(BATON_MEMORY_WS_METHODS.import, AuthStandardClientScopes)).toBe(
      AuthBatonHandsHostScope,
    );
    // This server's own sync, with the credentials it keeps, is the desktop app's alone too.
    expect(missingBatonScope(BATON_MEMORY_WS_METHODS.syncAddPeer, AuthStandardClientScopes)).toBe(
      AuthBatonHandsHostScope,
    );
    expect(missingBatonScope(BATON_JOB_WS_METHODS.jobAgree, [AuthOrchestrationReadScope])).toBe(
      AuthOrchestrationOperateScope,
    );
  });
});

const decodeAppend = Schema.decodeUnknownOption(BatonRecordAppendInput);

describe("who may write the Record", () => {
  it("is only the desktop app's own session, and each kind carries only its own outcomes", () => {
    const append = BATON_RECORD_WS_METHODS.append;
    expect(missingBatonScope(append, AuthStandardClientScopes)).toBe(AuthBatonHandsHostScope);
    expect(missingBatonScope(append, [...AuthStandardClientScopes, AuthBatonHandsHostScope])).toBe(
      null,
    );
    const decodes = (row: Record<string, unknown>) =>
      decodeAppend({
        actor: "Tessaya",
        subject: "s",
        detail: "",
        ...row,
      })._tag === "Some";
    expect(decodes({ kind: "assistant_turn", outcome: "answered" })).toBe(true);
    expect(decodes({ kind: "approval", outcome: "declined" })).toBe(true);
    expect(decodes({ kind: "standing_job", outcome: "held" })).toBe(true);
    expect(decodes({ kind: "assistant_turn", outcome: "approved" })).toBe(false);
    expect(decodes({ kind: "approval", outcome: "ran" })).toBe(false);
  });
});

const decodeSettingsSet = Schema.decodeUnknownOption(DesktopSettingsSetInput);

describe("who may change the desktop's dictation settings", () => {
  it("is only the desktop app's own session, and only the whitelisted fields and values", () => {
    const desktop = [...AuthStandardClientScopes, AuthBatonHandsHostScope];
    for (const method of Object.values(BATON_DESKTOP_SETTINGS_WS_METHODS)) {
      // A paired phone or browser holds every standard scope and still may not.
      expect(missingBatonScope(method, AuthStandardClientScopes)).toBe(AuthBatonHandsHostScope);
      expect(missingBatonScope(tessayaSpelling(method), AuthStandardClientScopes)).toBe(
        AuthBatonHandsHostScope,
      );
      expect(missingBatonScope(method, desktop)).toBe(null);
    }
    const patch = (value: Record<string, unknown>) =>
      Option.getOrNull(decodeSettingsSet({ patch: value }))?.patch ?? null;
    expect(patch({ dictationCleanup: "claude", pillStyle: "field", holdKey: "F9" })).toEqual({
      dictationCleanup: "claude",
      pillStyle: "field",
      holdKey: "F9",
    });
    expect(patch({ pillDesign: "lively", pillWaveform: "bars" })).toEqual({
      pillDesign: "lively",
      pillWaveform: "bars",
    });
    expect(patch({ pillDesign: "neon" })).toBe(null);
    expect(patch({ pillWaveform: "spiral" })).toBe(null);
    expect(patch({ dictationCleanup: "gpt" })).toBe(null);
    expect(patch({ holdKey: "Alt+F4" })).toBe(null);
    expect(patch({ frosted: "yes" })).toBe(null);
    // Fields outside the list never reach the desktop: its binary path, keys, audio keeping.
    expect(patch({ claudeBinary: "/tmp/x", keepVoice: true, frosted: true })).toEqual({
      frosted: true,
    });
  });
});

describe("who may change which account runs his work", () => {
  it("is his desktop or a browser he paired, never a token's device", () => {
    const standard = AuthStandardClientScopes;
    const device = { method: "bearer-access-token", scopes: standard, subject: "x" } as const;
    const his = {
      method: "browser-session-cookie",
      scopes: standard,
      subject: "one-time-token",
    } as const;
    for (const method of [
      BATON_ACCOUNT_WS_METHODS.setOnLimit,
      BATON_ACCOUNT_WS_METHODS.threadKeep,
    ]) {
      expect(refusedAsDevice(method, device)).toBe(true);
      expect(refusedAsDevice(method, his)).toBe(false);
    }
    expect(refusedAsDevice(BATON_ACCOUNT_WS_METHODS.onLimit, device)).toBe(false);
  });

  it("keeps private memories from a token's device, which may be an agent, and gives each op its scope", () => {
    const desktop = [...AuthStandardClientScopes, AuthBatonHandsHostScope];
    const agent = {
      method: "bearer-access-token",
      scopes: AuthStandardClientScopes,
      subject: "x",
    } as const;
    const phone = {
      method: "browser-session-cookie",
      scopes: AuthStandardClientScopes,
      subject: "one-time-token",
    } as const;
    const desk = { method: "bearer-access-token", scopes: desktop, subject: "desktop" } as const;
    for (const op of ["people", "list", "unlock", "recall"])
      expect(privateRefusal(agent, op)).toBe(
        "Private memories open only from his own desktop or a browser he paired.",
      );
    expect(privateRefusal(phone, "list")).toBe(null);
    expect(privateRefusal(phone, "unlock")).toBe(null);
    expect(privateRefusal({ ...phone, scopes: [AuthOrchestrationReadScope] }, "list")).toBe(null);
    expect(privateRefusal({ ...phone, scopes: [AuthOrchestrationReadScope] }, "unlock")).toBe(
      `Needs ${AuthOrchestrationOperateScope}.`,
    );
    // What feeds or reads the assistant, imports, deletes by voice ID or backs up is the desktop's own session only.
    for (const op of ["recall", "remember", "deposit", "personDeleted", "backup", "restore"]) {
      expect(privateRefusal(phone, op)).toBe(`Needs ${AuthBatonHandsHostScope}.`);
      expect(privateRefusal(desk, op)).toBe(null);
    }
  });
});

describe("whose words an ask carries", () => {
  it("is his from a paired browser or the desktop app's own session, and a device's from any other token", () => {
    const standard = AuthStandardClientScopes;
    expect(
      askSourceOf({
        method: "browser-session-cookie",
        scopes: standard,
        subject: "one-time-token",
      }),
    ).toBe("phone");
    // A cookie a token bought through a pairing of its own is still the token's.
    expect(
      askSourceOf({
        method: "browser-session-cookie",
        scopes: standard,
        subject: TOKEN_DELEGATED_SUBJECT,
      }),
    ).toBe("device");
    // A cookie from a pairing path nobody listed as his is not his either.
    expect(
      askSourceOf({ method: "browser-session-cookie", scopes: standard, subject: "new-path" }),
    ).toBe("device");
    expect(
      askSourceOf({
        method: "bearer-access-token",
        scopes: [...standard, AuthBatonHandsHostScope],
        subject: "desktop-bootstrap",
      }),
    ).toBe("phone");
    expect(askSourceOf({ method: "bearer-access-token", scopes: standard, subject: "x" })).toBe(
      "device",
    );
    expect(askSourceOf({ method: "dpop-access-token", scopes: standard, subject: "x" })).toBe(
      "device",
    );
  });

  it("lets only the desktop app's own session read memory as itself; every other token is a client", () => {
    expect(memoryViewerOf({ scopes: [...AuthStandardClientScopes, AuthBatonHandsHostScope] })).toBe(
      "desktop",
    );
    expect(memoryViewerOf({ scopes: AuthStandardClientScopes })).toBe("client");
  });
});

describe("what Baton's middleware tells the handlers", () => {
  effectIt.effect("who reads memory and whose words an ask carries, from the session alone", () =>
    Effect.gen(function* () {
      const told = (session: Parameters<typeof batonAuthorization>[0]) =>
        Effect.gen(function* () {
          const middleware = (yield* BatonRpcScopeAuthorization) as unknown as (
            effect: Effect.Effect<ReadonlyArray<string>>,
            options: unknown,
          ) => Effect.Effect<ReadonlyArray<string>>;
          const read = Effect.gen(function* () {
            return [yield* MemoryViewer, yield* AskSource];
          });
          return yield* middleware(read, {
            rpc: { _tag: BATON_MEMORY_WS_METHODS.list },
            payload: { admin: true, agent: "executive" },
          });
        }).pipe(Effect.provide(batonAuthorization(session)));
      expect(
        yield* told({
          method: "bearer-access-token",
          subject: "x",
          sessionId: "s1" as never,
          scopes: AuthStandardClientScopes,
        }),
      ).toEqual(["client", "device"]);
      expect(
        yield* told({
          method: "bearer-access-token",
          subject: "desktop-bootstrap",
          sessionId: "s2" as never,
          scopes: [...AuthStandardClientScopes, AuthBatonHandsHostScope],
        }),
      ).toEqual(["desktop", "phone"]);
    }),
  );
});

const decodeGrantScopes = Schema.decodeUnknownOption(AuthGrantScopes);

describe("a memory-sync credential", () => {
  const sync = [
    BATON_MEMORY_WS_METHODS.syncHello,
    BATON_MEMORY_WS_METHODS.syncPull,
    BATON_MEMORY_WS_METHODS.syncPush,
    BATON_MEMORY_WS_METHODS.historySearch,
  ];

  it("syncs, and only it or the desktop app may; it can call nothing else", () => {
    for (const tag of sync) {
      expect(missingBatonScope(tag, AuthStandardClientScopes)).toBe(AuthBatonMemorySyncScope);
      expect(missingBatonScope(tag, [AuthBatonMemorySyncScope])).toBeNull();
      expect(missingBatonScope(tag, [AuthBatonHandsHostScope])).toBeNull();
    }
    for (const tag of Object.keys(BATON_RPC_REQUIRED_SCOPES)) {
      if (sync.includes(tag as never)) continue;
      expect(missingBatonScope(tag, [AuthBatonMemorySyncScope]), tag).not.toBeNull();
    }
    expect(memoryViewerOf({ scopes: [AuthBatonMemorySyncScope] })).toBe("server");
    // Through walls, or running the pull now: the desktop app's own session only.
    const search = BATON_MEMORY_WS_METHODS.historySearch;
    expect(missingBatonScope(search, [AuthBatonMemorySyncScope], { admin: true })).toBe(
      AuthBatonHandsHostScope,
    );
    expect(missingBatonScope(search, [AuthBatonHandsHostScope], { admin: true })).toBeNull();
    const pull = BATON_MEMORY_WS_METHODS.pull;
    expect(missingBatonScope(pull, AuthStandardClientScopes, { action: "run" })).toBe(
      AuthBatonHandsHostScope,
    );
    expect(missingBatonScope(pull, AuthStandardClientScopes, { action: "status" })).toBeNull();
  });

  it("is issued alone: a grant that mixes it with anything else is refused", () => {
    expect(decodeGrantScopes([AuthBatonMemorySyncScope])._tag).toBe("Some");
    expect(decodeGrantScopes([AuthBatonMemorySyncScope, AuthOrchestrationReadScope])._tag).toBe(
      "None",
    );
    expect(decodeGrantScopes(AuthStandardClientScopes)._tag).toBe("Some");
  });
});

describe("who a household request is from", () => {
  it("is the member a session names, a token's device acting for the owner is a service, and only an approving device is A3 by itself", () => {
    const of = (
      subject: string,
      method: AuthenticatedSession["method"],
      scopes: ReadonlyArray<AuthEnvironmentScope>,
    ) => householdCallerOf({ subject, method, scopes, sessionId: "s-1" as never });
    expect(of("member:sara", "bearer-access-token", ["tessaya:member"])).toMatchObject({
      member: "sara",
      service: false,
      assurance: 2,
    });
    expect(of("token-delegated", "bearer-access-token", ["orchestration:read"])).toMatchObject({
      member: "owner",
      service: true,
    });
    expect(
      of("desktop-bootstrap", "bearer-access-token", ["orchestration:read", "baton:hands-host"]),
    ).toMatchObject({
      member: "owner",
      service: false,
      // The desktop is a signed-in device like any other: A3 comes from a step-up (PIN, Windows Hello).
      assurance: 2,
      desktop: true,
      session: "s-1",
    });
    expect(of("member:sara", "bearer-access-token", ["baton:cloud-approve"]).assurance).toBe(3);
    expect(of("member:", "browser-session-cookie", ["tessaya:member"]).member).toBeNull();
    expect(householdRefusal({ scopes: ["tessaya:guest"] })).toBeNull();
    expect(householdRefusal({ scopes: ["baton:memory-sync"] })).not.toBeNull();
  });
});

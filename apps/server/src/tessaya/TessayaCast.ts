// @effect-diagnostics nodeBuiltinImport:off globalJsonInEffect:off
/**
 * Who wears which body (B-002, MA-015). A Tessel's or phone's rule is the `tessayaCast` setting; the desktop's is its
 * own companion settings, set through TessayaDesktopSettings. Calls are visits that lapse with the conversation unless
 * "stay". Mood is not here: a body asks TessayaMood with the persona it wears.
 */
import type { CastBody, CastCallInput, CastView } from "@t3tools/tessaya-contracts";
import {
  type BodyCast,
  mayRecast,
  onBody,
  personaIn,
  type Visit,
  visitLive,
  wearing,
} from "@t3tools/tessaya-shared/cast";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { DeviceRegistry } from "../home/DeviceRegistry.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { CurrentPersona } from "./CurrentPersona.ts";
import { personasList } from "./OperatingSystemPack.ts";
import { TessayaDesktopSettings } from "./TessayaDesktopSettings.ts";
import { makeBrainLink } from "./BrainHost.ts";
import { emitAction } from "../provenance/ActionLog.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

/** The desktop sandbox: the worn one and up to three more (the desktop's CREW_MAX). */
const DESKTOP_HOLDS = 4;

/** `follows` null: no rule set here, so the room loop keeps its own default (R1_PERSONA_FOLLOWS). */
type Listener = (
  body: string,
  persona: string | null,
  follows: boolean | null,
) => Effect.Effect<void>;

export class TessayaCast extends Context.Service<
  TessayaCast,
  {
    readonly view: Effect.Effect<CastView>;
    /** The persona a body wears now, for its face, its mood and its next session. */
    readonly wearing: (body: string) => Effect.Effect<string | null>;
    /**
     * His change; refused unless `mayRecast` (only his verified ask, never a wake word). A visit for this conversation
     * only needs `visitOk`: it is as harmless as the wake word that does the same (18 Nov).
     */
    readonly call: (
      input: CastCallInput,
      verified: boolean,
      visitOk?: boolean,
    ) => Effect.Effect<CastView, string>;
    /** A turn on this body: a visit there lasts while the conversation does. */
    readonly touch: (body: string) => Effect.Effect<void>;
    readonly told: (body: string) => Effect.Effect<{
      readonly persona: string | null;
      readonly follows: boolean | null;
    } | null>;
    /** A Tessel's loop hears what it wears and whether it follows, on every change. */
    readonly listen: (listener: Listener) => Effect.Effect<void>;
    /** On her brain: another server's desk bodies as its desktop reported them now (`desks` brain op). */
    readonly desksFrom: (server: string, desks: ReadonlyArray<CastBody>) => Effect.Effect<void>;
  }
>()("t3/tessaya/TessayaCast") {}

interface DesktopRule {
  readonly home: string | null;
  readonly follows: boolean;
  readonly crew: ReadonlyArray<string>;
}

/** The desktop's own companion controls, as the Cast reads them ("all" is every other persona). */
export const desktopRule = (
  controls: ReadonlyArray<{ readonly id: string; readonly value: string | boolean }>,
  roster: ReadonlyArray<{ readonly id: string; readonly name: string }>,
): DesktopRule => {
  const value = (id: string) => controls.find((c) => c.id === id)?.value;
  const home = personaIn(roster, String(value("v.mascotPersona") ?? ""));
  const crew = String(value("v.mascotCrew") ?? "none");
  return {
    home,
    follows: value("v.mascotFollows") === true,
    crew:
      crew === "all"
        ? roster.filter((p) => p.id !== home).map((p) => p.id)
        : crew === "none"
          ? []
          : crew.split(",").flatMap((c) => personaIn(roster, c) ?? []),
  };
};

/** The desktop's Others-with-her value for a crew list. */
export const crewValue = (crew: ReadonlyArray<string>) =>
  crew.length === 0 ? "none" : crew.join(",");

interface CastToolInput {
  readonly action: "who" | "call" | "home" | "follows" | "crew" | "sendHome";
  readonly persona?: string | null | undefined;
  readonly stay?: boolean | undefined;
  readonly on?: boolean | undefined;
  readonly personas?: ReadonlyArray<string> | undefined;
}

/** The voice tool's words as one Cast call; `body` is already "here" resolved to the vessel he speaks through. */
export const castOp = (input: CastToolInput, body: string | undefined): CastCallInput => {
  const b = body ?? "";
  switch (input.action) {
    case "who":
      return { op: "view" };
    case "call":
      return { op: "call", body: b, persona: input.persona ?? "", stay: input.stay === true };
    case "home":
      return { op: "home", body: b, persona: input.persona ?? null };
    case "follows":
      return { op: "follows", body: b, on: input.on !== false };
    case "crew":
      return { op: "crew", body: b, personas: input.personas ?? [] };
    case "sendHome":
      return body === undefined ? { op: "sendHome" } : { op: "sendHome", body };
  }
};

/** One plain line for what a Cast call did, for her to say. */
export const castLine = (op: CastCallInput, v: CastView): string => {
  const name = (id: string | null) => v.personas.find((p) => p.id === id)?.name ?? "the default";
  const body =
    "body" in op ? v.bodies.find((b) => b.id === op.body || b.name === op.body) : undefined;
  const where = body?.name ?? "it";
  switch (op.op) {
    case "view":
      return v.bodies
        .map((b) => `${b.name}: ${b.on.map((p) => name(p)).join(", ") || "nobody"}`)
        .join("; ");
    case "call":
      return op.stay
        ? `${where} keeps ${op.persona} until you send them home.`
        : `${op.persona} is on ${where} for this conversation.`;
    case "home":
      return `${where} now always goes back to ${name(body?.home ?? null)}.`;
    case "follows":
      return op.on
        ? `${where} now follows whoever you last talked to.`
        : `${where} stays with its own persona.`;
    case "crew":
      return `On ${where}: ${body?.on.map((p) => name(p)).join(", ") ?? "nobody"}.`;
    case "sendHome":
      return body === undefined
        ? "Everyone is back home."
        : `${where} is back to ${name(body.wearing)}.`;
  }
};

/** A desk body another server reported is offline when it has not been heard of for this long (two heartbeats). */
const REMOTE_FRESH_MS = 150_000;

const make = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const registry = yield* DeviceRegistry;
  const desktop = yield* Effect.serviceOption(TessayaDesktopSettings);
  const current = yield* Effect.serviceOption(CurrentPersona);
  // Kept where the turns run, on her brain; a desktop's visit stays with its own crew here.
  const visits = new Map<string, Visit & { readonly crewBefore?: ReadonlyArray<string> }>();
  const remoteDesks = new Map<
    string,
    { readonly body: CastBody; readonly at: number; readonly from: string }
  >();
  const listeners = new Set<Listener>();
  const roster = Effect.map(personasList, (l) =>
    l.personas.map((p) => ({ id: p.id, name: p.name })),
  );
  const desktopControls = Option.isNone(desktop)
    ? Effect.succeed([])
    : Effect.map(desktop.value.get, (v) => v.controls ?? []);

  const bodies = Effect.gen(function* () {
    const personas = yield* roster;
    const all = yield* registry.list;
    const s = yield* Effect.orElseSucceed(settings.getSettings, () => null);
    const controls = yield* desktopControls;
    const now = yield* Clock.currentTimeMillis;
    const out: Array<CastBody> = [];
    for (const d of all) {
      if (d.stale === true) continue;
      const isDesktop = d.kind === "desktop";
      // shortcut: one desktop's settings per server (TessayaDesktopSettings holds one); two desktops share them.
      const rule: BodyCast = isDesktop
        ? (({ home, follows, crew }) => ({ ...(home === null ? {} : { home }), follows, crew }))(
            desktopRule(controls, personas),
          )
        : (s?.tessayaCast[d.deviceId] ?? {});
      const owner = s?.tessayaMood.devices[d.deviceId]?.owner ?? d.member ?? null;
      const followed =
        rule.follows === true && owner !== null && Option.isSome(current)
          ? yield* current.value.of(`person:${owner}`)
          : null;
      const visit = visits.get(d.deviceId);
      const worn = wearing(rule, {
        roster: personas,
        ...(isDesktop ? {} : { visit }),
        followed,
        now,
      });
      const holds = isDesktop ? DESKTOP_HOLDS : 1;
      // what the desktop last said of its body: on screen or hidden, and where (desktopDevice.ts)
      const shown = isDesktop ? yield* registry.value(d.deviceId, "companion.shown") : undefined;
      const screen = isDesktop ? yield* registry.value(d.deviceId, "companion.screen") : undefined;
      out.push({
        id: d.deviceId,
        name: d.name,
        kind: d.kind,
        online: d.online,
        holds,
        home: personaIn(personas, rule.home),
        follows: rule.follows === true,
        crew: (rule.crew ?? []).flatMap((c) => personaIn(personas, c) ?? []),
        wearing: worn?.persona ?? null,
        // A desktop visit stands beside her in the sandbox, so the worn one keeps its own reason.
        why:
          !isDesktop || !visitLive(visit, now)
            ? (worn?.why ?? "lead")
            : visit.stay
              ? "stay"
              : "visit",
        on: onBody(rule, worn, personas, holds),
        facing: owner,
        ...(typeof shown === "boolean" ? { shown } : {}),
        ...(typeof screen === "string" && screen !== "" ? { screen } : {}),
      });
    }
    // Desk bodies other servers report (each desktop talks to its own server): the brain lists every body she has.
    for (const [id, r] of remoteDesks)
      if (!out.some((b) => b.id === id))
        out.push({
          ...r.body,
          online: r.body.online !== false && now - r.at < REMOTE_FRESH_MS,
          seenAt: r.at,
        });
    return { personas, bodies: out };
  });

  /** What a Tessel's loop is told: the persona it wears and its follow rule; null for the desktop or no such body. */
  const told = Effect.fn("TessayaCast.told")(function* (body: string) {
    const b = (yield* bodies).bodies.find((x) => x.id === body);
    if (b === undefined || b.kind === "desktop") return null;
    const s = yield* Effect.orElseSucceed(settings.getSettings, () => null);
    return { persona: b.wearing, follows: s?.tessayaCast[body]?.follows ?? null };
  });
  const tell = Effect.fn("TessayaCast.tell")(function* (body: string) {
    const t = yield* told(body);
    if (t !== null) for (const l of listeners) yield* l(body, t.persona, t.follows);
  });

  const setDesktop = (controls: ReadonlyArray<{ id: string; value: string | boolean }>) =>
    Option.isNone(desktop) ? Effect.void : Effect.asVoid(desktop.value.setControls(controls));

  const setRule = Effect.fn("TessayaCast.setRule")(function* (body: string, patch: BodyCast) {
    const s = yield* Effect.orElseSucceed(settings.getSettings, () => null);
    const was = s?.tessayaCast ?? {};
    const next = { ...was[body], ...patch };
    const clean = Object.fromEntries(
      Object.entries(next).filter(([, v]) => v !== undefined && v !== null),
    );
    const rest = Object.fromEntries(Object.entries(was).filter(([k]) => k !== body));
    yield* Effect.ignore(
      settings.updateSettings({
        tessayaCast: Object.keys(clean).length === 0 ? rest : { ...rest, [body]: clean },
      }),
    );
  });

  /** A visit leaves: the desktop's crew goes back to what it was, and a Tessel hears its home again. */
  const leave = Effect.fn("TessayaCast.leave")(function* (body: string) {
    const v = visits.get(body);
    if (v === undefined) return;
    visits.delete(body);
    if (v.crewBefore !== undefined)
      yield* setDesktop([{ id: "v.mascotCrew", value: crewValue(v.crewBefore) }]);
    yield* tell(body);
  });

  const call = Effect.fn("TessayaCast.call")(function* (
    input: CastCallInput,
    verified: boolean,
    visitOk = verified,
  ) {
    if (input.op === "view") return yield* bodies;
    if (input.op === "call" && !input.stay ? !visitOk : !mayRecast("ask", verified))
      return yield* Effect.fail(
        "Only a voice she knows, or his signed-in app, can move a persona.",
      );
    const before = yield* bodies;
    const body =
      "body" in input && input.body !== undefined
        ? before.bodies.find(
            (b) => b.id === input.body || b.name.toLowerCase() === input.body?.toLowerCase(),
          )
        : undefined;
    if ("body" in input && input.body !== undefined && body === undefined)
      return yield* Effect.fail(`There is no body called ${input.body}.`);
    const persona =
      "persona" in input && input.persona !== null
        ? personaIn(before.personas, input.persona)
        : null;
    if ("persona" in input && input.persona !== null && persona === null)
      return yield* Effect.fail(`There is no persona called ${input.persona}.`);
    const now = yield* Clock.currentTimeMillis;
    switch (input.op) {
      case "home":
        if (body!.kind === "desktop")
          yield* setDesktop([{ id: "v.mascotPersona", value: persona ?? before.personas[0]!.id }]);
        else yield* setRule(body!.id, { home: persona ?? undefined });
        break;
      case "follows":
        if (body!.kind === "desktop")
          yield* setDesktop([{ id: "v.mascotFollows", value: input.on }]);
        else yield* setRule(body!.id, { follows: input.on });
        break;
      case "crew": {
        const crew = input.personas.flatMap((p) => personaIn(before.personas, p) ?? []);
        if (body!.kind === "desktop")
          yield* setDesktop([
            { id: "v.mascotCrew", value: crewValue(crew.slice(0, DESKTOP_HOLDS - 1)) },
          ]);
        else yield* setRule(body!.id, { crew: crew.length === 0 ? undefined : crew });
        break;
      }
      case "call": {
        yield* leave(body!.id);
        if (body!.kind === "desktop") {
          // Several at once: the one called stands beside her until the conversation ends.
          if (!body!.on.includes(persona!)) {
            visits.set(body!.id, {
              persona: persona!,
              at: now,
              stay: input.stay,
              crewBefore: body!.crew,
            });
            yield* setDesktop([
              {
                id: "v.mascotCrew",
                value: crewValue([...body!.crew, persona!].slice(-(DESKTOP_HOLDS - 1))),
              },
            ]);
          }
        } else if (persona !== body!.wearing || input.stay) {
          visits.set(body!.id, { persona: persona!, at: now, stay: input.stay });
        }
        break;
      }
      case "sendHome":
        for (const id of body === undefined ? [...visits.keys()] : [body.id]) yield* leave(id);
        break;
    }
    if (body !== undefined && body.kind !== "desktop") yield* tell(body.id);
    return yield* bodies;
  });

  // Temporary calls return home once the conversation lapses.
  yield* Effect.forkScoped(
    Effect.repeat(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        for (const [id, v] of visits) if (!visitLive(v, now)) yield* leave(id);
      }),
      Schedule.spaced("30 seconds"),
    ),
  );
  // A follows body moves with the persona its person last talked to.
  if (Option.isSome(current))
    yield* current.value.listen((conversation) =>
      Effect.gen(function* () {
        const member = conversation.startsWith("person:") ? conversation.slice(7) : null;
        if (member === null) return;
        for (const b of (yield* bodies).bodies)
          if (b.follows && b.facing === member && b.kind !== "desktop") yield* tell(b.id);
      }).pipe(Effect.ignore),
    );

  /**
   * One Cast, on her brain: a server that isn't her brain asks it, and keeps only its own desktop (whose rule is the
   * desktop app's own file, synced here). When the brain can't be reached it answers from what it can see and changes
   * nothing, so there is never a second truth of who wears what.
   */
  const brain = yield* makeBrainLink;
  const desks = (v: CastView) => v.bodies.filter((b) => b.kind === "desktop");
  /**
   * The rules this server kept before the brain held them go up once, additively (the brain's own win), with a copy
   * kept beside its state; only then are they cleared here, so no body has two rules. Each step is a Record action.
   */
  const uploadOwn = Effect.fn("TessayaCast.uploadOwn")(function* () {
    const own = (yield* Effect.orElseSucceed(settings.getSettings, () => null))?.tessayaCast ?? {};
    const count = Object.keys(own).length;
    if (count === 0) return;
    yield* emitAction({
      kind: "cast.move",
      actor: { kind: "rule", id: "oneBrain", certainty: 1 },
      outcome: "dryRun",
      data: { bodies: count },
    });
    const answer = yield* brain.send("cast", { a: "merge", rules: own });
    if (Option.isNone(answer)) return;
    const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
    if (Option.isSome(config)) {
      const kept = NodePath.join(config.value.stateDir, "cast.before-brain.json");
      yield* Effect.sync(() => {
        if (!NodeFS.existsSync(kept))
          NodeFS.writeFileSync(kept, `${JSON.stringify(own, null, 2)}\n`);
      });
    }
    yield* Effect.ignore(settings.updateSettings({ tessayaCast: {} }));
    yield* emitAction({
      kind: "cast.move",
      actor: { kind: "rule", id: "oneBrain", certainty: 1 },
      outcome: "moved",
      data: answer.value as Record<string, unknown>,
    });
  });
  const fromBrain = Effect.fn("TessayaCast.fromBrain")(function* (act: unknown) {
    if (yield* brain.isBrain) return Option.none<unknown>();
    yield* uploadOwn();
    return yield* brain.send("cast", act);
  });
  const view = Effect.gen(function* () {
    const theirs = yield* fromBrain({ a: "view" });
    const here = yield* bodies;
    if (Option.isNone(theirs) || typeof theirs.value !== "object" || theirs.value === null)
      return here;
    const v = theirs.value as CastView;
    // the desktop's own body is answered here, where its settings sync; every other body as the brain holds it
    const mine = desks(here);
    return {
      personas: v.personas,
      bodies: [...v.bodies.filter((b) => !mine.some((d) => d.id === b.id)), ...mine],
    };
  });
  const isDesk = (body: string) =>
    Effect.map(bodies, (v) =>
      desks(v).some((d) => d.id === body || d.name.toLowerCase() === body.toLowerCase()),
    );

  return TessayaCast.of({
    view,
    wearing: Effect.fn("TessayaCast.wearing")(function* (body: string) {
      return (yield* view).bodies.find((b) => b.id === body)?.wearing ?? null;
    }),
    call: Effect.fn("TessayaCast.oneCall")(function* (
      input: CastCallInput,
      verified: boolean,
      visitOk: boolean = verified,
    ) {
      if (yield* brain.isBrain) return yield* call(input, verified, visitOk);
      if (input.op === "view") return yield* view;
      yield* uploadOwn();
      if ("body" in input && input.body !== undefined && (yield* isDesk(input.body)))
        return yield* call(input, verified, visitOk);
      const answer = yield* brain.send("cast", { a: "call", input, verified, visitOk });
      if (Option.isNone(answer))
        return yield* Effect.fail("Her brain can't be reached just now, so nobody moved.");
      const got = answer.value as CastView | { readonly refused: string };
      if ("refused" in got) return yield* Effect.fail(got.refused);
      return got;
    }),
    told: Effect.fn("TessayaCast.told")(function* (body: string) {
      const theirs = yield* fromBrain({ a: "told", body });
      return Option.isSome(theirs)
        ? (theirs.value as {
            readonly persona: string | null;
            readonly follows: boolean | null;
          } | null)
        : yield* told(body);
    }),
    touch: Effect.fn("TessayaCast.touch")(function* (body: string) {
      if (!(yield* brain.isBrain) && !(yield* isDesk(body))) {
        yield* brain.send("cast", { a: "touch", body });
        return;
      }
      const v = visits.get(body);
      if (v === undefined) return;
      visits.set(body, { ...v, at: yield* Clock.currentTimeMillis });
    }),
    listen: Effect.fn("TessayaCast.listen")((listener: Listener) =>
      Effect.sync(() => void listeners.add(listener)),
    ),
    desksFrom: Effect.fn("TessayaCast.desksFrom")(function* (server, desks) {
      const at = yield* Clock.currentTimeMillis;
      for (const [id, r] of remoteDesks) if (r.from === server) remoteDesks.delete(id);
      for (const d of desks.slice(0, 8)) remoteDesks.set(d.id, { body: d, at, from: server });
    }),
  });
});

/**
 * A server that isn't her brain tells it its desk bodies: at once when one shows, hides or moves screen (the registry's
 * change), and every minute so the brain knows it is still there. Never queued: an old body state is no state.
 */
export const reportDesksLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const cast = yield* TessayaCast;
    const registry = yield* DeviceRegistry;
    const brain = yield* makeBrainLink;
    const env = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironment);
    const server = Option.isNone(env) ? "worker" : String(yield* env.value.getEnvironmentId);
    const send = Effect.gen(function* () {
      if (yield* brain.isBrain) return;
      const desks = (yield* cast.view).bodies.filter(
        (b) => b.kind === "desktop" && b.seenAt === undefined,
      );
      if (desks.length > 0) yield* brain.send("cast", { a: "desks", server, desks });
    }).pipe(Effect.ignoreCause({ log: true }));
    yield* Stream.fromSubscription(yield* registry.changes).pipe(
      Stream.filter((c) => c.kind === "desktop" && c.itemId.startsWith("companion.")),
      Stream.runForEach(() => send),
      Effect.forkScoped,
    );
    yield* send.pipe(Effect.repeat(Schedule.spaced("1 minute")), Effect.forkScoped);
  }),
);

export const layer = Layer.effect(TessayaCast, make);

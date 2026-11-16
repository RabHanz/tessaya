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

import { DeviceRegistry } from "../home/DeviceRegistry.ts";
import { DeviceSync } from "../home/DeviceSync.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { CurrentPersona } from "./CurrentPersona.ts";
import { personasList } from "./OperatingSystemPack.ts";
import { TessayaDesktopSettings } from "./TessayaDesktopSettings.ts";

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
    /** His change; refused unless `mayRecast` (only his verified ask, never a wake word). */
    readonly call: (input: CastCallInput, verified: boolean) => Effect.Effect<CastView, string>;
    /** A turn on this body: a visit there lasts while the conversation does. */
    readonly touch: (body: string) => Effect.Effect<void>;
    readonly told: (body: string) => Effect.Effect<{
      readonly persona: string | null;
      readonly follows: boolean | null;
    } | null>;
    /** A Tessel's loop hears what it wears and whether it follows, on every change. */
    readonly listen: (listener: Listener) => Effect.Effect<void>;
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

const make = Effect.gen(function* () {
  const settings = yield* ServerSettingsService;
  const registry = yield* DeviceRegistry;
  const desktop = yield* Effect.serviceOption(TessayaDesktopSettings);
  const current = yield* Effect.serviceOption(CurrentPersona);
  const sync = yield* Effect.serviceOption(DeviceSync);
  // A Tessel's visit is shared with his other servers (DeviceSync "@cast"); a desktop's stays with its own crew here.
  const visits = new Map<string, Visit & { readonly crewBefore?: ReadonlyArray<string> }>();
  const share = (body: string, visit: Visit | null) =>
    Option.isNone(sync)
      ? Effect.void
      : sync.value.put(
          "@cast",
          `body:${body}`,
          visit === null ? null : { persona: visit.persona, stay: visit.stay, at: visit.at },
          "changed",
          visit?.at,
        );
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
      });
    }
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
    else yield* share(body, null);
    yield* tell(body);
  });

  const call = Effect.fn("TessayaCast.call")(function* (input: CastCallInput, verified: boolean) {
    if (input.op === "view") return yield* bodies;
    if (!mayRecast("ask", verified))
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
          yield* share(body!.id, visits.get(body!.id)!);
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
  // A visit started or ended on another of his servers: the newer one wins, and its Tessel hears it.
  if (Option.isSome(sync))
    yield* sync.value.onRecord("@cast", (field, v, at) =>
      Effect.gen(function* () {
        if (!field.startsWith("body:")) return;
        const body = field.slice("body:".length);
        const held = visits.get(body);
        if (held !== undefined && held.at > at) return;
        const visit = v as {
          readonly persona?: unknown;
          readonly stay?: unknown;
          readonly at?: unknown;
        } | null;
        if (visit === null || typeof visit.persona !== "string") visits.delete(body);
        else
          visits.set(body, {
            persona: visit.persona,
            at: typeof visit.at === "number" ? visit.at : at,
            stay: visit.stay === true,
          });
        yield* tell(body);
      }).pipe(Effect.ignore),
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

  return TessayaCast.of({
    view: bodies,
    wearing: (body) =>
      Effect.map(bodies, (v) => v.bodies.find((b) => b.id === body)?.wearing ?? null),
    call,
    told,
    touch: Effect.fn("TessayaCast.touch")(function* (body: string) {
      const v = visits.get(body);
      if (v === undefined) return;
      const next = { ...v, at: yield* Clock.currentTimeMillis };
      visits.set(body, next);
      if (v.crewBefore === undefined) yield* share(body, next);
    }),
    listen: (listener) => Effect.sync(() => void listeners.add(listener)),
  });
});

export const layer = Layer.effect(TessayaCast, make);

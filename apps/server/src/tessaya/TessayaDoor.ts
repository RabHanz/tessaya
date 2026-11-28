// @effect-diagnostics preferSchemaOverJson:off globalJsonInEffect:off
/**
 * The household's one front door: the brain whose `TESSAYA_PUBLIC_HOST` is an internet name also answers, under the
 * name given in Sharing & access, for each machine it holds a peer link with. The link is only the address book.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ServerSecretStore } from "../auth/ServerSecretStore.ts";
import {
  DirectEndpoints,
  PublicDomainHost,
  publicDomainHost,
} from "../environment/DirectEndpoints.ts";
import { PeerLinks } from "../peer/PeerLinks.ts";
import { DeviceSync } from "../home/DeviceSync.ts";
import { type DoorTarget, hostOf, setDoorHandler } from "./doorFront.ts";

const NAMES_SECRET = "tessaya-door-names";
/** The record his servers share: each machine's public name, so the machine itself can advertise it. */
export const DOOR_RECORD = "@door";
/** An address that answered as the machine is used this long before it is checked again. */
const VERIFIED_MS = 30_000;

export type DoorNames = Readonly<Record<string, string>>;

const decodeNames = (bytes: Uint8Array | null): DoorNames => {
  if (bytes === null) return {};
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  } catch {
    return {};
  }
};

/** Which way a host goes, given the door's own name and the names he gave (label to environment id). Pure. */
export const doorTarget = (
  host: string,
  door: { readonly own: string; readonly domain: string } | null,
  names: DoorNames,
): DoorTarget => {
  if (door === null || host === door.own || !host.endsWith(`.${door.domain}`))
    return { _tag: "pass" };
  const label = host.slice(0, -(door.domain.length + 1));
  if (label.includes(".")) return { _tag: "pass" };
  const environmentId = names[label];
  return environmentId === undefined ? { _tag: "none" } : { _tag: "machine", environmentId };
};

/** Whether an address would loop back through a door, so it is never a forwarding target. Pure. */
export const throughDoor = (url: string, domain: string) => {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === domain || host.endsWith(`.${domain}`);
  } catch {
    return true;
  }
};

export type DoorNameError = "not-a-door" | "invalid-name" | "taken" | "not-linked";

export class TessayaDoor extends Context.Service<
  TessayaDoor,
  {
    /** Each linked machine's public name here, by environment id; empty when this brain is not a door. */
    readonly names: Effect.Effect<{
      readonly domain: string | null;
      readonly names: Readonly<Record<string, string>>;
    }>;
    /** Names a linked machine (null clears it); the machine learns its name through his servers' shared records. */
    readonly setName: (
      environmentId: string,
      label: string | null,
    ) => Effect.Effect<DoorNameError | null>;
  }
>()("t3/tessaya/TessayaDoor") {}

export const layer = Layer.effect(
  TessayaDoor,
  Effect.gen(function* () {
    const secrets = yield* ServerSecretStore;
    const links = yield* Effect.serviceOption(PeerLinks);
    const sync = yield* Effect.serviceOption(DeviceSync);
    const direct = yield* Effect.serviceOption(DirectEndpoints);
    const own = yield* PublicDomainHost.pipe(Effect.orElseSucceed(() => null));
    const parent = own === null ? null : own.slice(own.indexOf(".") + 1);
    const domain = parent !== null && parent.split(".").length >= 2 ? parent : null;
    const door = own === null || domain === null ? null : { own, domain };
    const run = Effect.runPromiseWith(yield* Effect.context<never>());

    let names: DoorNames = decodeNames(
      Option.getOrNull(yield* secrets.get(NAMES_SECRET).pipe(Effect.orElseSucceed(Option.none))),
    );
    const verified = new Map<string, { readonly url: string; readonly until: number }>();

    // A machine behind some door learns its name from his servers' shared record and advertises it to its clients.
    if (Option.isSome(sync) && Option.isSome(direct)) {
      const self = sync.value.self;
      const learn = (v: unknown) =>
        direct.value.setDoorHost(
          typeof v === "string" && hostOf(v) === v && v.includes(".") ? v : null,
        );
      const kept = (yield* sync.value.get(DOOR_RECORD))[self];
      if (kept !== undefined) yield* learn(kept.v);
      yield* sync.value.onMerged(self, (record, v) =>
        record === DOOR_RECORD ? learn(v) : Effect.void,
      );
    }

    const resolve = (environmentId: string): Promise<string | null> => {
      const cached = verified.get(environmentId);
      if (cached !== undefined && cached.until > Date.now()) return Promise.resolve(cached.url);
      if (Option.isNone(links) || door === null) return Promise.resolve(null);
      return run(
        links.value.resolve(environmentId as never).pipe(
          Effect.map((resolved) => (throughDoor(resolved.url, door.domain) ? null : resolved.url)),
          Effect.orElseSucceed(() => null),
        ),
      ).then((url) => {
        if (url === null) verified.delete(environmentId);
        else verified.set(environmentId, { url, until: Date.now() + VERIFIED_MS });
        return url;
      });
    };

    if (door !== null) {
      yield* Effect.acquireRelease(
        Effect.sync(() =>
          setDoorHandler({ target: (host) => doorTarget(host, door, names), resolve }),
        ),
        () => Effect.sync(() => setDoorHandler(null)),
      );
    }

    return TessayaDoor.of({
      names: Effect.sync(() => ({
        domain: door?.domain ?? null,
        names: Object.fromEntries(Object.entries(names).map(([label, id]) => [id, label])),
      })),
      setName: Effect.fn("TessayaDoor.setName")(function* (environmentId, label) {
        if (door === null) return "not-a-door" as const;
        const name = label?.trim().toLowerCase() ?? null;
        if (name !== null) {
          const host = publicDomainHost(door.domain, name);
          if (host === null || host === door.own) return "invalid-name" as const;
          const holder = names[name];
          if (holder !== undefined && holder !== environmentId) return "taken" as const;
          if (Option.isNone(links)) return "not-linked" as const;
          const link = yield* links.value
            .get(environmentId as never)
            .pipe(Effect.orElseSucceed(() => Option.none()));
          if (Option.isNone(link)) return "not-linked" as const;
        }
        const next = Object.fromEntries(
          Object.entries(names).filter(([, id]) => id !== environmentId),
        );
        if (name !== null) next[name] = environmentId;
        yield* secrets
          .set(NAMES_SECRET, new TextEncoder().encode(JSON.stringify(next)))
          .pipe(Effect.orDie);
        names = next;
        verified.delete(environmentId);
        if (Option.isSome(sync))
          yield* sync.value.put(
            DOOR_RECORD,
            environmentId,
            name === null ? null : `${name}.${door.domain}`,
            "changed",
          );
        return null;
      }),
    });
  }),
);

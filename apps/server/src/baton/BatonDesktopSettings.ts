/**
 * The desktop's dictation settings, changed from outside: a change waits here until the desktop's next sync takes it,
 * and the desktop reports what it then runs with. In memory only; the desktop's own file stays the truth.
 */
import type {
  DesktopSettingsView,
  DesktopVoiceSettings,
  DesktopVoiceSettingsPatch,
} from "@t3tools/baton-contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

/** The desktop syncs every few seconds; quieter than this, it is gone. */
const CONNECTED_MS = 60_000;
/** How long a set waits for the desktop to apply it before answering with it still pending. */
export const APPLY_WAIT = Duration.seconds(15);

export class BatonDesktopSettings extends Context.Service<
  BatonDesktopSettings,
  {
    readonly get: Effect.Effect<DesktopSettingsView>;
    /** Merges into any change still waiting, then waits for the desktop to apply it. */
    readonly set: (patch: DesktopVoiceSettingsPatch) => Effect.Effect<DesktopSettingsView>;
    /** The desktop's report: its values and the last change it applied; answers with the change it should apply. */
    readonly sync: (input: {
      readonly effective: DesktopVoiceSettings;
      readonly applied: number;
    }) => Effect.Effect<{
      readonly change: {
        readonly version: number;
        readonly patch: DesktopVoiceSettingsPatch;
      } | null;
    }>;
  }
>()("t3/baton/BatonDesktopSettings") {}

const make = Effect.gen(function* () {
  let reported: { readonly at: number; readonly effective: DesktopVoiceSettings } | null = null;
  let pending: { readonly version: number; readonly patch: DesktopVoiceSettingsPatch } | null =
    null;
  // From the clock, so a desktop still holding a version from before this server restarted is always behind.
  let version = yield* Clock.currentTimeMillis;
  const waiters: Array<{
    readonly version: number;
    readonly done: Deferred.Deferred<void>;
  }> = [];

  const view = Effect.map(Clock.currentTimeMillis, (now): DesktopSettingsView => ({
    connected: reported !== null && now - reported.at < CONNECTED_MS,
    at: reported === null ? null : DateTime.formatIso(DateTime.makeUnsafe(reported.at)),
    effective: reported?.effective ?? null,
    pending: pending?.patch ?? null,
  }));

  const set = Effect.fn("BatonDesktopSettings.set")(function* (patch: DesktopVoiceSettingsPatch) {
    version += 1;
    pending = { version, patch: { ...pending?.patch, ...patch } };
    const done = yield* Deferred.make<void>();
    const waiter = { version, done };
    waiters.push(waiter);
    const applied = yield* Deferred.await(done).pipe(
      Effect.timeoutOption(APPLY_WAIT),
      Effect.ensuring(
        Effect.sync(() => {
          const at = waiters.indexOf(waiter);
          if (at >= 0) waiters.splice(at, 1);
        }),
      ),
    );
    return { ...(yield* view), applied: Option.isSome(applied) };
  });

  const sync = Effect.fn("BatonDesktopSettings.sync")(function* (input: {
    readonly effective: DesktopVoiceSettings;
    readonly applied: number;
  }) {
    reported = { at: yield* Clock.currentTimeMillis, effective: input.effective };
    if (pending !== null && input.applied >= pending.version) pending = null;
    for (const waiter of waiters.filter((w) => input.applied >= w.version)) {
      yield* Deferred.succeed(waiter.done, undefined);
    }
    return { change: pending };
  });

  return BatonDesktopSettings.of({ get: view, set, sync });
});

export const layer = Layer.effect(BatonDesktopSettings, make);

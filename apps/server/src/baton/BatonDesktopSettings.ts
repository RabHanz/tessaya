/**
 * The desktop's dictation settings, changed from outside: a change waits here until the desktop's next sync takes it,
 * and the desktop reports what it then runs with. In memory only; the desktop's file stays the truth, except the cleanup
 * level, which follows and sets the one `dictationCleanup` server setting. Each set is a Record row: who, the change,
 * and the values before and after.
 */
import { chooseDictationCleanup } from "@t3tools/contracts";
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

import { ServerSettingsService } from "../serverSettings.ts";
import { BatonRecordService } from "./BatonRecordService.ts";

type Level = DesktopVoiceSettings["dictationCleanup"];
/** On is Tessaya's model cleanup; off keeps the desktop's own code-only or raw choice. */
export const levelFollowing = (enabled: boolean, level: Level): Level =>
  enabled ? "claude" : level === "claude" ? "local" : level;

/** A sync with nothing to take waits this long for a change, so an idle desktop asks about twice a minute. */
export const SYNC_HOLD = Duration.seconds(25);
/** Quieter than a held sync and its gap, the desktop is gone. */
const CONNECTED_MS = 60_000;
/** How long a set waits for the desktop to apply it; a change not taken by then is dropped, never applied late. */
export const APPLY_WAIT = Duration.seconds(15);
/** No change older than this is handed out, whatever kept it, so a woken laptop never undoes his own edits. */
const STALE_MS = 2 * 60_000;

/** Who asked for a change, for the Record: the RPC needs hands-host, so unset is the desktop app's own session. */
export const DesktopSettingsCaller = Context.Reference<{
  readonly actor: string;
  readonly scope: string;
}>("t3/baton/BatonDesktopSettings/Caller", {
  defaultValue: () => ({ actor: "desktop app", scope: "hands-host" }),
});

export class BatonDesktopSettings extends Context.Service<
  BatonDesktopSettings,
  {
    readonly get: Effect.Effect<DesktopSettingsView>;
    /** Merges into any change still waiting, then waits for the desktop to apply it. */
    readonly set: (patch: DesktopVoiceSettingsPatch) => Effect.Effect<DesktopSettingsView>;
    /**
     * The desktop's report: its values and the last change it applied; answers with the change it should apply, held
     * open up to SYNC_HOLD while there is none.
     */
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
  const record = yield* Effect.serviceOption(BatonRecordService);
  const serverSettings = yield* ServerSettingsService;
  /** The last level handed to the desktop, so its report of taking it is not read as his own change. */
  let handed: Level | null = null;
  let reported: { readonly at: number; readonly effective: DesktopVoiceSettings } | null = null;
  let pending: {
    readonly version: number;
    readonly at: number;
    readonly patch: DesktopVoiceSettingsPatch;
  } | null = null;
  // From the clock, so a desktop still holding a version from before this server restarted is always behind.
  let version = yield* Clock.currentTimeMillis;
  const waiters: Array<{
    readonly version: number;
    readonly done: Deferred.Deferred<void>;
  }> = [];
  /** Opened by the next set, for the syncs held waiting on one. */
  let wake = yield* Deferred.make<void>();

  const fresh = Effect.map(Clock.currentTimeMillis, (now) => {
    if (pending !== null && now - pending.at > STALE_MS) pending = null;
    return now;
  });

  const view = Effect.map(fresh, (now): DesktopSettingsView => ({
    connected: reported !== null && now - reported.at < CONNECTED_MS,
    at: reported === null ? null : DateTime.formatIso(DateTime.makeUnsafe(reported.at)),
    effective: reported?.effective ?? null,
    pending: pending?.patch ?? null,
  }));

  const choose = Effect.fn("BatonDesktopSettings.choose")(
    function* (level: Level) {
      const current = (yield* serverSettings.getSettings).dictationCleanup;
      if (levelFollowing(current.enabled, level) === level) return;
      const now = yield* Clock.currentTimeMillis;
      yield* serverSettings.updateSettings({
        dictationCleanup: chooseDictationCleanup(current, { enabled: level === "claude" }, now),
      });
    },
    Effect.catchCause((cause) => Effect.logWarning("dictation cleanup choice not saved", cause)),
  );

  /** Hands the desktop the level the one setting asks for, unless the difference is his own new choice there. */
  const follow = Effect.fn("BatonDesktopSettings.follow")(
    function* (level: Level, previous: Level | null) {
      const universal = (yield* serverSettings.getSettings).dictationCleanup;
      const wanted = levelFollowing(universal.enabled, level);
      if (wanted === level) return;
      // A first report before anyone chose carries his choice from before the one setting existed.
      const his =
        previous === null ? universal.updatedAt === 0 : previous !== level && level !== handed;
      if (his) return yield* choose(level);
      version += 1;
      handed = wanted;
      pending = { version, at: yield* fresh, patch: { dictationCleanup: wanted } };
    },
    Effect.catchCause((cause) => Effect.logWarning("dictation cleanup not followed", cause)),
  );

  const set = Effect.fn("BatonDesktopSettings.set")(function* (patch: DesktopVoiceSettingsPatch) {
    const by = yield* DesktopSettingsCaller;
    const before = reported?.effective ?? null;
    if (patch.dictationCleanup !== undefined) {
      yield* choose(patch.dictationCleanup);
      handed = patch.dictationCleanup;
    }
    version += 1;
    const mine = version;
    pending = { version: mine, at: yield* fresh, patch: { ...pending?.patch, ...patch } };
    const done = yield* Deferred.make<void>();
    const waiter = { version: mine, done };
    waiters.push(waiter);
    yield* Deferred.succeed(wake, undefined);
    wake = yield* Deferred.make<void>();
    const applied = Option.isSome(
      yield* Deferred.await(done).pipe(
        Effect.timeoutOption(APPLY_WAIT),
        Effect.ensuring(
          Effect.sync(() => {
            const at = waiters.indexOf(waiter);
            if (at >= 0) waiters.splice(at, 1);
            // Not taken in time (or the caller left): dropped, unless a later set has replaced it.
            if (pending?.version === mine) pending = null;
          }),
        ),
      ),
    );
    const answer = { ...(yield* view), applied };
    if (record._tag === "Some") {
      yield* record.value
        .append({
          kind: "desktop_settings",
          actor: by.actor,
          subject: `Dictation settings: ${toJson(patch)}`,
          outcome: applied ? "applied" : "not applied",
          detail: toJson({ scope: by.scope, before, after: answer.effective }),
        })
        .pipe(Effect.ignoreCause);
    }
    return answer;
  });

  const sync = Effect.fn("BatonDesktopSettings.sync")(function* (input: {
    readonly effective: DesktopVoiceSettings;
    readonly applied: number;
  }) {
    const previous = reported?.effective.dictationCleanup ?? null;
    reported = { at: yield* fresh, effective: input.effective };
    if (pending !== null && input.applied >= pending.version) pending = null;
    for (const waiter of waiters.filter((w) => input.applied >= w.version)) {
      yield* Deferred.succeed(waiter.done, undefined);
    }
    if (pending === null) yield* follow(input.effective.dictationCleanup, previous);
    if (pending === null) {
      yield* Deferred.await(wake).pipe(Effect.timeoutOption(SYNC_HOLD));
      yield* fresh;
    }
    return { change: pending };
  });

  return BatonDesktopSettings.of({ get: view, set, sync });
});

// Plain settings values only, which always serialise.
const toJson = (value: unknown): string => JSON.stringify(value);

export const layer = Layer.effect(BatonDesktopSettings, make);

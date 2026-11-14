/**
 * What the desktop app tells its server about itself, for `tessaya_state` on /mcp. Every field is named here and
 * capped: no key, no vault entry, no account, no file path and no transcript text has a place to go, and the server
 * drops anything else it is sent.
 */
import * as Schema from "effect/Schema";

export const DESKTOP_STATE_SECTIONS = [
  "settings",
  "voice",
  "personas",
  "skills",
  "diagnostics",
] as const;
export type DesktopStateSection = (typeof DESKTOP_STATE_SECTIONS)[number];

const Short = Schema.String.check(Schema.isMaxLength(80));
const Line = Schema.String.check(Schema.isMaxLength(200));
const few = <S extends Schema.Top>(item: S, max: number) =>
  Schema.Array(item).check(Schema.isMaxLength(max));

export const BatonDesktopState = Schema.Struct({
  settings: Schema.Struct({
    output: Short,
    captureApproval: Short,
    actWithoutAsking: Schema.Boolean,
    socialOn: Schema.Boolean,
    browserChrome: Schema.Boolean,
    remoteHands: Schema.Boolean,
    assistantModel: Short,
    assistantEffort: Short,
  }),
  voice: Schema.Struct({
    enabled: Schema.Boolean,
    voice: Short,
    recognition: Schema.Literals(["local", "cloud"]),
    cloudProvider: Short,
    cloudModel: Schema.NullOr(Short),
    languages: few(Short, 20),
    wakeWords: few(Short, 20),
    dictationCleanup: Short,
  }),
  personas: few(Schema.Struct({ id: Short, name: Short, role: Line, lead: Schema.Boolean }), 30),
  skills: few(Schema.Struct({ name: Short, status: Short }), 100),
  diagnostics: Schema.Struct({
    appVersion: Short,
    brain: Short,
    voiceEngine: Short,
    recognition: Schema.Literals(["local", "cloud"]),
    environments: few(Schema.Struct({ label: Short, state: Short }), 20),
    /** Codes and when, never the message: `claude_missing`, `timeout`, `claude_stopped` or `other`. */
    errors: few(Schema.Struct({ code: Short, at: Short }), 20),
  }),
});
export type BatonDesktopState = typeof BatonDesktopState.Type;

/**
 * The desktop's account of itself for `tessaya_state` (BatonDesktopState). Each field is copied by name and cut to
 * its cap, so whatever else his settings hold (keys, binary paths, his account, prompts) never leaves this file.
 */
import type { BatonDesktopState } from "@t3tools/tessaya-contracts";

const cut = (value: unknown, max = 80): string => String(value ?? "").slice(0, max);
const some = <A>(items: ReadonlyArray<A> | undefined, max: number): ReadonlyArray<A> =>
  (items ?? []).slice(0, max);

export interface DesktopStateInput {
  readonly screen: {
    readonly output: string;
    readonly captureApproval: string;
    readonly actWithoutAsking: boolean;
    readonly socialOn: boolean;
    readonly browserChrome: boolean;
    readonly remoteHands: boolean;
    readonly assistantModel: string;
    readonly assistantEffort: string;
    readonly voice: string;
  };
  readonly voice: {
    readonly enabled: boolean;
    readonly recognition: "local" | "cloud";
    readonly cloudProvider: string;
    readonly cloudModel: string | null;
    readonly languages: ReadonlyArray<string>;
    readonly wakeWords: ReadonlyArray<{ readonly word: string; readonly enabled: boolean }>;
    readonly dictationCleanup: string;
  };
  readonly personas: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly role: string;
    readonly lead: boolean;
  }>;
  readonly skills: ReadonlyArray<{ readonly slug: string; readonly verified: boolean }>;
  readonly appVersion: string;
  readonly brain: string;
  readonly voiceEngine: string;
  readonly environments: ReadonlyArray<{ readonly label: string; readonly state: string }>;
  readonly errors: ReadonlyArray<{ readonly code: string; readonly at: string }>;
}

export const desktopState = (input: DesktopStateInput): BatonDesktopState => ({
  settings: {
    output: cut(input.screen.output),
    captureApproval: cut(input.screen.captureApproval),
    actWithoutAsking: input.screen.actWithoutAsking === true,
    socialOn: input.screen.socialOn === true,
    browserChrome: input.screen.browserChrome === true,
    remoteHands: input.screen.remoteHands === true,
    assistantModel: cut(input.screen.assistantModel),
    assistantEffort: cut(input.screen.assistantEffort),
  },
  voice: {
    enabled: input.voice.enabled === true,
    voice: cut(input.screen.voice),
    recognition: input.voice.recognition === "cloud" ? "cloud" : "local",
    cloudProvider: cut(input.voice.cloudProvider),
    cloudModel: input.voice.cloudModel === null ? null : cut(input.voice.cloudModel),
    languages: some(input.voice.languages, 20).map((l) => cut(l)),
    wakeWords: some(
      input.voice.wakeWords.filter((w) => w.enabled),
      20,
    ).map((w) => cut(w.word)),
    dictationCleanup: cut(input.voice.dictationCleanup),
  },
  personas: some(input.personas, 30).map((p) => ({
    id: cut(p.id),
    name: cut(p.name),
    role: cut(p.role, 200),
    lead: p.lead === true,
  })),
  skills: some(input.skills, 100).map((s) => ({
    name: cut(s.slug),
    status: s.verified ? "verified" : "not verified",
  })),
  diagnostics: {
    appVersion: cut(input.appVersion),
    brain: cut(input.brain),
    voiceEngine: cut(input.voiceEngine),
    recognition: input.voice.recognition === "cloud" ? "cloud" : "local",
    environments: some(input.environments, 20).map((e) => ({
      label: cut(e.label),
      state: cut(e.state),
    })),
    errors: some(input.errors, 20).map((e) => ({ code: cut(e.code), at: cut(e.at) })),
  },
});

/**
 * The phone's pill design and waveform (Settings → Appearance → Dictation). Where a thread's environment has a
 * desktop that reports its own (Tessaya's Appearance → Pill design), that one wins, so the two stay one setting.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  parsePillDesign,
  parsePillWave,
  pillTokens,
  waveFor,
  type PillDesign,
  type PillWave,
} from "@t3tools/tessaya-shared/composerDictation";
import type { DesktopSettingsView } from "@t3tools/tessaya-contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { Atom, AsyncResult } from "effect/reactivity";
import { File, Paths } from "expo-file-system";
import { useSyncExternalStore } from "react";
import { useResolveClassNames } from "uniwind";

import { batonWorkSessions } from "../../state/batonWorkSessions";

export interface PillChoice {
  readonly design: PillDesign;
  readonly wave: PillWave;
}

const file = () => new File(Paths.document, "tessaya-pill-look.json");
const read = (): PillChoice => {
  try {
    const saved = JSON.parse(file().textSync()) as Record<string, unknown>;
    return { design: parsePillDesign(saved["design"]), wave: parsePillWave(saved["wave"]) };
  } catch {
    return { design: "tessaya", wave: "match" };
  }
};

let local: PillChoice | null = null;
const listeners = new Set<() => void>();
const localChoice = () => (local ??= read());
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

export const saveLocalPillChoice = (choice: PillChoice) => {
  local = choice;
  try {
    file().writeSync(JSON.stringify(choice));
  } catch {}
  for (const listener of listeners) listener();
};

/** What an environment's desktop says, pending change first; null when no desktop reports there. */
export const sharedChoice = (view: DesktopSettingsView | null): PillChoice | null => {
  const effective = view?.effective ?? null;
  if (effective === null) return null;
  return {
    design: parsePillDesign(view?.pending?.pillDesign ?? effective.pillDesign),
    wave: parsePillWave(view?.pending?.pillWaveform ?? effective.pillWaveform),
  };
};

const NOTHING = Atom.make(AsyncResult.initial<never, never>(false));
const viewOf = (result: AsyncResult.AsyncResult<DesktopSettingsView, unknown>) =>
  Option.getOrNull(AsyncResult.value(result));

/** The environments here whose desktop shares its pill settings, keyed by the comma-joined ids. */
export const sharedEnvironmentsAtom = Atom.family((key: string) =>
  Atom.make((get) =>
    key
      .split(",")
      .filter((id) => id.length > 0)
      .flatMap((id) => {
        const environmentId = id as EnvironmentId;
        const choice = sharedChoice(
          viewOf(get(batonWorkSessions.desktopSettingsQuery({ environmentId, input: {} }))),
        );
        return choice === null ? [] : [{ environmentId, choice }];
      }),
  ),
);

const colourOf = (style: object, key: "backgroundColor" | "color") => {
  const value = (style as Record<string, unknown>)[key];
  return typeof value === "string" ? value : "transparent";
};

export function useLocalPillChoice(): PillChoice {
  return useSyncExternalStore(subscribe, localChoice, localChoice);
}

/** The look for a composer on `environmentId`: its desktop's choice, else the phone's; colours from the theme. */
export function usePillLook(environmentId: EnvironmentId | null) {
  const mine = useLocalPillChoice();
  const view = useAtomValue(
    environmentId === null
      ? NOTHING
      : batonWorkSessions.desktopSettingsQuery({ environmentId, input: {} }),
  );
  const choice = sharedChoice(viewOf(view)) ?? mine;
  // The theme's roles as plain colours: the waveform and the pill are drawn with them, not with classes.
  const bg = (style: object) => colourOf(style, "backgroundColor");
  const fg = (style: object) => colourOf(style, "color");
  const screen = useResolveClassNames("bg-screen");
  const card = useResolveClassNames("bg-card");
  const text = useResolveClassNames("text-foreground");
  const muted = useResolveClassNames("text-foreground-muted");
  const primary = useResolveClassNames("bg-primary");
  const onPrimary = useResolveClassNames("text-primary-foreground");
  const warning = useResolveClassNames("text-warning-foreground");
  const tokens = pillTokens(choice.design, {
    canvas: bg(screen),
    surfaceOverlay: bg(card),
    text: fg(text),
    textMuted: fg(muted),
    accent: bg(primary),
    accentForeground: fg(onPrimary),
    warning: fg(warning),
  });
  return { design: choice.design, wave: waveFor(choice.design, choice.wave), tokens };
}

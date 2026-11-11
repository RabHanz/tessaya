import { useAtomValue } from "@effect/atom-react";
import { parsePillDesign, parsePillWave, waveFor } from "@t3tools/baton-shared/composerDictation";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/reactivity";

import { batonWorkSessions } from "../state/batonWorkSessions";

/** The pill design and waveform the environment's desktop uses (Settings → Appearance), Tessaya's own otherwise. */
export function useComposerPillLook(environmentId: EnvironmentId) {
  const view = Option.getOrNull(
    AsyncResult.value(
      useAtomValue(batonWorkSessions.desktopSettingsQuery({ environmentId, input: {} })),
    ),
  );
  const shared = view?.effective ?? null;
  const design = parsePillDesign(view?.pending?.pillDesign ?? shared?.pillDesign);
  return {
    design,
    wave: waveFor(design, parsePillWave(view?.pending?.pillWaveform ?? shared?.pillWaveform)),
  };
}

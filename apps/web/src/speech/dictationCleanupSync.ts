/**
 * Tessaya: the one dictation cleanup setting in this client. A choice is written to every connected environment through
 * T3's shared server settings; an environment that was away when it was made gets it from the next client that reaches
 * both. This browser's cleanup switch (voiceConsent's grant) is derived from the setting.
 */
import { useAtomValue } from "@effect/atom-react";
import {
  chooseDictationCleanup,
  DEFAULT_DICTATION_CLEANUP,
  type DictationCleanup,
  dictationCleanupCatchUp,
  followDictationCleanup,
  type EnvironmentId,
  newestDictationCleanup,
} from "@t3tools/contracts";
import { runAtomCommand } from "@t3tools/client-runtime/state/runtime";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "~/connection/catalog";
import { useUpdatePrimarySettings } from "~/hooks/useSettings";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { serverEnvironment } from "~/state/server";
import { chooseTranscriptCleanup, readCleanupGrant } from "./voiceConsent";

const copiesAtom = Atom.make((get) =>
  [...get(environmentCatalog.catalogValueAtom).entries.keys()].flatMap((environmentId) => {
    const connected = Option.match(
      AsyncResult.value(get(environmentCatalog.stateAtom(environmentId))),
      { onNone: () => false, onSome: (connection) => connection.phase === "connected" },
    );
    const settings = get(serverEnvironment.settingsValueAtom(environmentId));
    return connected && settings !== null
      ? [{ environmentId, cleanup: settings.dictationCleanup }]
      : [];
  }),
).pipe(Atom.withLabel("tessaya-dictation-cleanup-copies"));

/** The setting as this client sees it: the newest copy among the environments it reaches; null with none. */
const dictationCleanupAtom = Atom.make((get) =>
  newestDictationCleanup(get(copiesAtom).map((copy) => copy.cleanup)),
).pipe(Atom.withLabel("tessaya-dictation-cleanup"));

/** Changes the one setting on every connected environment. */
export function useChooseDictationCleanup() {
  const update = useUpdatePrimarySettings();
  const current = useAtomValue(dictationCleanupAtom);
  return (change: Partial<Omit<DictationCleanup, "updatedAt">>) =>
    update({
      dictationCleanup: chooseDictationCleanup(
        current ?? DEFAULT_DICTATION_CLEANUP,
        change,
        Date.now(),
      ),
    });
}

/** Carries the newest copy to every environment still behind, and keeps this browser's switch on the setting. */
export function startDictationCleanupSync(): () => void {
  const sent = new Map<EnvironmentId, DictationCleanup>();
  let seen: DictationCleanup | null = null;
  let adopted = false;
  const write = (environmentId: EnvironmentId, dictationCleanup: DictationCleanup) => {
    sent.set(environmentId, dictationCleanup);
    void runAtomCommand(
      appAtomRegistry,
      serverEnvironment.updateSettings,
      { environmentId, input: { patch: { dictationCleanup } } },
      { reportFailure: false },
    );
  };
  const run = () => {
    const copies = appAtomRegistry.get(copiesAtom);
    const { newest, behind } = dictationCleanupCatchUp(copies);
    if (newest === null) return;
    for (const environmentId of behind)
      if (sent.get(environmentId) !== newest) write(environmentId, newest);
    const step = followDictationCleanup(newest, seen, readCleanupGrant() !== null);
    if (newest.updatedAt > 0) seen = newest;
    if (step === "adopt" && !adopted) {
      adopted = true;
      const chosen = chooseDictationCleanup(newest, { enabled: true }, Date.now());
      for (const { environmentId } of copies) write(environmentId, chosen);
    } else if (step === "on" || step === "off") chooseTranscriptCleanup(step === "on");
  };
  const unsubscribe = appAtomRegistry.subscribe(copiesAtom, run);
  run();
  return unsubscribe;
}

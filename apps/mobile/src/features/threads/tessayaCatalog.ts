/**
 * The thread settings sheet's providers as web's picker groups them (ACCOUNTS-2): one section per provider, not per
 * login, with Terminal its own group. The other logins of a provider become account rows under its header.
 */
import type { TessayaAccountRecord } from "@t3tools/tessaya-contracts";
import {
  accountPickTarget,
  oneEntryPerProvider,
  pickModelFor,
  sessionLoginKey,
} from "@t3tools/tessaya-shared/accounts";
import { withRealEffort } from "@t3tools/tessaya-shared/liveModel";
import { LIVE_INSTANCE } from "@t3tools/tessaya-shared/liveThread";
import type { ModelCapabilities, ModelSelection } from "@t3tools/contracts";

import type { ModelOption, ProviderGroup } from "../../lib/modelOptions";

const driverOf = (group: ProviderGroup) => group.models[0]?.providerDriver ?? group.providerKey;

/** Terminal is its own provider; so is each ACP agent, though they share one driver. */
const providerOf = (group: ProviderGroup) =>
  group.providerKey === LIVE_INSTANCE || driverOf(group) === "acpRegistry"
    ? group.providerKey
    : driverOf(group);

/**
 * One group per provider: the shown login's (else the default one's) models, under the provider's name. Its key is
 * the provider's first login's, so a filter or a collapsed section holds while another login is picked.
 */
export const tessayaProviderGroups = (
  groups: ReadonlyArray<ProviderGroup>,
  shownInstanceId: string | undefined,
): ReadonlyArray<ProviderGroup> =>
  oneEntryPerProvider(
    groups.map((group) => ({
      instanceId: group.providerKey,
      driverKind: providerOf(group),
      displayName: group.providerLabel,
      isDefault: group.providerKey === driverOf(group),
      group,
    })),
    shownInstanceId ?? "",
  ).map((entry) => ({
    ...entry.group,
    providerKey:
      groups.find((group) => providerOf(group) === entry.driverKind)?.providerKey ??
      entry.group.providerKey,
    providerLabel: entry.displayName,
  }));

/**
 * The sheet's provider filter that shows a thread's accounts first: Terminal for a terminal thread, else the key
 * tessayaProviderGroups gives the thread's provider (its first login's). Null when the sheet does not list it.
 */
export const accountsFilterKey = (
  groups: ReadonlyArray<ProviderGroup>,
  instanceId: string,
): string | null => {
  if (instanceId === LIVE_INSTANCE) return LIVE_INSTANCE;
  const own = groups.find((group) => group.providerKey === instanceId);
  if (own === undefined) return null;
  return groups.find((group) => providerOf(group) === providerOf(own))?.providerKey ?? null;
};

/** The model a tap on an account lands on, or null when the sheet does not list that login. */
export const accountPickOption = (
  account: Pick<TessayaAccountRecord, "driver" | "email" | "instanceIds" | "methods" | "active">,
  groups: ReadonlyArray<ProviderGroup>,
  thread: { readonly driver: string; readonly model: string },
): ModelOption | null => {
  const target = accountPickTarget(account)?.instanceId;
  const group = groups.find((candidate) => candidate.providerKey === target);
  if (group === undefined) return null;
  const slug = pickModelFor(
    {
      driverKind: driverOf(group),
      models: group.models.map((model) => ({
        slug: model.selection.model,
        isDefault: model.isDefault,
      })),
    },
    thread.driver,
    thread.model,
  );
  return group.models.find((model) => model.selection.model === slug) ?? null;
};

/** A terminal thread's options as the sheet shows them: the session's real effort, never "as it is". */
export const liveTraits = (
  capabilities: ModelCapabilities | null | undefined,
  selection: ModelSelection,
  sessionEffort: string | null,
) => {
  const real = withRealEffort(
    [{ capabilities }],
    selection.options,
    selection.instanceId === LIVE_INSTANCE ? sessionEffort : null,
  );
  return { capabilities: real.models[0]?.capabilities, selections: real.options };
};

/** The session catalog's answer for one session: the login it names, or null when it names none. */
export type SessionLogin = { readonly sessionId: string; readonly login: string | null };

/**
 * The cswap key a terminal session runs as, only once the catalog has answered for this very session: before that a
 * pick would route on whatever login cswap has active, which may not be the session's.
 */
export const loadedLoginKey = (
  read: SessionLogin | null,
  sessionId: string | null,
  pool: Parameters<typeof sessionLoginKey>[0],
): string | null =>
  read === null || sessionId === null || read.sessionId !== sessionId
    ? null
    : sessionLoginKey(pool, read.login);

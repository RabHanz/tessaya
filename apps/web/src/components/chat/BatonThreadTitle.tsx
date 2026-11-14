import {
  displayThreadTitle,
  isLiveThreadId,
  knownTitleSuffixes,
} from "@t3tools/tessaya-shared/liveThread";
import type { EnvironmentId } from "@t3tools/contracts";

import { useEnvironments } from "../../state/environments";
import { useBatonAccounts } from "../../state/batonAccounts";

/** A thread's title as shown: a live thread's without the account and machine names it ends with (display only). */
export function useDisplayThreadTitle(
  environmentId: EnvironmentId,
  threadId: string,
  title: string,
): string {
  const accounts = useBatonAccounts(environmentId);
  const { environments } = useEnvironments();
  return displayThreadTitle(
    threadId,
    title,
    knownTitleSuffixes({
      accounts,
      environmentLabels: environments.map((environment) => environment.label),
    }),
  );
}

/** A sidebar row's title: only live threads subscribe to the names their titles may end with. */
export function BatonThreadTitleText(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly title: string;
}) {
  return isLiveThreadId(props.threadId) ? <LiveTitle {...props} /> : props.title;
}

function LiveTitle(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: string;
  readonly title: string;
}) {
  return useDisplayThreadTitle(props.environmentId, props.threadId, props.title);
}

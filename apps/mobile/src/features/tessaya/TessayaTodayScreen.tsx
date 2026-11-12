import { buildPhoneState, type PhoneState } from "@t3tools/baton-shared/phone";
import {
  LEARN_ITEMS,
  pickTip,
  readLearnProgress,
  type LearnItem,
  type LearnOp,
} from "@t3tools/baton-shared/learn";
import type { EnvironmentId } from "@t3tools/contracts";
import { useFocusEffect } from "@react-navigation/native";
import { useCallback, useRef, useState } from "react";

import { AppText as Text } from "../../components/ui/AppText";
import { useEnvironments } from "../../state/environments";
import { batonWorkSessions } from "../../state/batonWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsRow } from "../settings/components/SettingsRow";
import { SettingsScreen } from "../settings/components/SettingsScreen";
import { SettingsSection } from "../settings/components/SettingsSection";

/** The tips whose page the phone has too. */
const PHONE_PAGES: Readonly<Record<string, "SettingsHardware" | "SettingsHome" | undefined>> = {
  hardware: "SettingsHardware",
  homeassistant: "SettingsHome",
};

/** His own computer's server: the first connected one, as the phone's other Tessaya pages use. */
export const useTessayaHome = (): EnvironmentId | null =>
  useEnvironments().environments.find(
    (entry) => entry.connection.phase === "connected" && entry.serverConfig !== null,
  )?.environmentId ?? null;

/** Today in Tessaya's phone app: what needs him and what she is doing, by the phone page's own rules, and one tip. */
export function TessayaTodayScreen() {
  const home = useTessayaHome();
  return (
    <SettingsScreen title="Today" workspaceRoot>
      {home === null ? (
        <Text className="px-4 py-3 text-foreground-muted">
          Connect your computer to see what needs you.
        </Text>
      ) : (
        <TodayBody key={home} environmentId={home} />
      )}
    </SettingsScreen>
  );
}

function TodayBody(props: { readonly environmentId: EnvironmentId }) {
  const environmentId = props.environmentId;
  const jobList = useAtomCommand(batonWorkSessions.jobList, { reportFailure: false });
  const watchGet = useAtomCommand(batonWorkSessions.watchGet, { reportFailure: false });
  const weaveList = useAtomCommand(batonWorkSessions.weaveList, { reportFailure: false });
  const learnCall = useAtomCommand(batonWorkSessions.learnCall, { reportFailure: false });
  const [state, setState] = useState<PhoneState | null>(null);
  const [tip, setTip] = useState<LearnItem | null>(null);
  const tipPicked = useRef(false);
  const learn = (change: LearnOp) =>
    void learnCall({ environmentId, input: { kind: "act", op: change.op, args: { ...change } } });

  useFocusEffect(
    useCallback(() => {
      let live = true;
      void Promise.all([
        jobList({ environmentId, input: {} }),
        watchGet({ environmentId, input: {} }),
        weaveList({ environmentId, input: {} }),
      ]).then(([jobs, watch, weaves]) => {
        if (!live) return;
        setState(
          buildPhoneState({
            jobs: jobs._tag === "Success" ? jobs.value.jobs : [],
            findings: watch._tag === "Success" ? watch.value.findings : [],
            weaves: weaves._tag === "Success" ? weaves.value.items : [],
            now: Date.now(),
          }),
        );
      });
      // One tip per visit to the app, not per focus: picked once, counted on his server.
      if (!tipPicked.current) {
        tipPicked.current = true;
        void learnCall({ environmentId, input: { kind: "read", op: "get" } }).then((result) => {
          if (!live || result._tag !== "Success" || !result.value.ok) return;
          const picked = pickTip(
            LEARN_ITEMS,
            readLearnProgress(result.value.value),
            { page: "today", area: "today" },
            Date.now(),
          );
          setTip(picked);
          if (picked !== null)
            void learnCall({
              environmentId,
              input: { kind: "act", op: "seen", args: { id: picked.id, at: Date.now() } },
            });
        });
      }
      return () => {
        live = false;
      };
    }, [environmentId, jobList, watchGet, weaveList, learnCall]),
  );

  return (
    <>
      {tip === null ? null : (
        <SettingsSection title="Tip">
          <SettingsRow
            icon="info.circle"
            label={tip.title}
            value={tip.body}
            valuePosition="below"
            {...(PHONE_PAGES[tip.place] === undefined
              ? {
                  // Its page is on his computer: tapping here only says he has seen it.
                  onPress: () => {
                    learn({ op: "dismiss", id: tip.id });
                    setTip(null);
                  },
                }
              : { target: PHONE_PAGES[tip.place] })}
          />
        </SettingsSection>
      )}
      <SettingsSection title="Needs you">
        {state === null ? (
          <SettingsRow icon="ellipsis.circle" label="Looking…" />
        ) : state.needs.length === 0 && state.approvals.length === 0 ? (
          <SettingsRow icon="checkmark.circle" label="Nothing needs you" />
        ) : (
          <>
            {state.approvals.map((approval) => (
              <SettingsRow
                key={approval.id}
                icon="exclamationmark.circle"
                label={approval.title}
                value={approval.action}
                valuePosition="below"
              />
            ))}
            {state.needs.map((need) => (
              <SettingsRow
                key={need.id}
                icon="bell.badge"
                label={need.title}
                value={need.why}
                valuePosition="below"
              />
            ))}
          </>
        )}
      </SettingsSection>
      <SettingsSection title="Doing for you">
        {state === null ? null : state.jobs.length === 0 ? (
          <SettingsRow icon="checkmark.circle" label="No jobs" />
        ) : (
          state.jobs.map((job) => (
            <SettingsRow
              key={job.id}
              icon="bolt.circle"
              label={job.title}
              value={job.status}
              valuePosition="below"
            />
          ))
        )}
      </SettingsSection>
    </>
  );
}

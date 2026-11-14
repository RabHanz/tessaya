/**
 * Tessaya › Team: each persona's duties, templates, track record, load and recent hand-offs, and a "Hand to…" on
 * every job it leads. The board is the server's read of jobs and the Record (`baton.job.team`), never a store.
 */
import type { EnvironmentId, TessayaTeamMember } from "@t3tools/tessaya-contracts";
import {
  leadChoices,
  leadMoveLine,
  loadLine,
  templateLine,
  trackLine,
} from "@t3tools/tessaya-shared/teamView";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useState, type ReactNode } from "react";

import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

const QUIET = { reportFailure: false } as const;

export function TeamPanel() {
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {environment?.connection.phase === "connected" ? (
        <TeamSections key={environment.environmentId} environmentId={environment.environmentId} />
      ) : (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          Connect an environment to see the team.
        </p>
      )}
    </SettingsPageContainer>
  );
}

function TeamSections({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const read = useAtomCommand(tessayaWorkSessions.jobTeam, QUIET);
  const lead = useAtomCommand(tessayaWorkSessions.jobLead, QUIET);
  const canLead = useAtomValue(tessayaWorkSessions.jobLead.permissionAtom(environmentId));
  const [members, setMembers] = useState<ReadonlyArray<TessayaTeamMember> | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const refresh = async () => {
    const result = await read({ environmentId, input: {} });
    setFailed(result._tag !== "Success");
    if (result._tag === "Success") setMembers(result.value.members);
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the server's team board once per environment
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect, react/exhaustive-effect-dependencies -- one read per environment; refresh closes over it
    void refresh();
  }, [environmentId]);

  const handTo = async (job: { id: string; title: string }, to: TessayaTeamMember) => {
    setNote("");
    const result = await lead({
      environmentId,
      input: { id: job.id as never, to: to.id, via: "card" },
    });
    setNote(
      result._tag === "Success"
        ? `${to.name} leads ${job.title} now. Its worker carries on.`
        : "That hand-off did not go through. Nothing changed.",
    );
    await refresh();
  };

  const team = members ?? [];
  return (
    <SettingsSection title="The team">
      {failed ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          This server could not read the team.
        </p>
      ) : members === null ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">Reading the team…</p>
      ) : (
        team.map((m) => (
          <SettingsRow
            key={m.id}
            title={m.name}
            description={[m.role, loadLine(m), trackLine(m.track)].filter(Boolean).join(" · ")}
            control={
              m.private ? null : (
                <Button
                  size="xs"
                  variant="ghost-muted"
                  aria-expanded={open === m.id}
                  onClick={() => setOpen(open === m.id ? null : m.id)}
                >
                  {open === m.id ? "Less" : "More"}
                </Button>
              )
            }
          >
            {open === m.id ? (
              <MemberDetail
                member={m}
                team={team}
                canLead={canLead}
                onHandTo={(job, to) => void handTo(job, to)}
              />
            ) : null}
          </SettingsRow>
        ))
      )}
      {note === "" ? null : <p className="px-4 py-3 text-sm text-muted-foreground">{note}</p>}
    </SettingsSection>
  );
}

function MemberDetail(props: {
  readonly member: TessayaTeamMember;
  readonly team: ReadonlyArray<TessayaTeamMember>;
  readonly canLead: boolean;
  readonly onHandTo: (job: { id: string; title: string }, to: TessayaTeamMember) => void;
}) {
  const { member: m, team } = props;
  const others = leadChoices(team, m.id);
  return (
    <div className="mt-3 flex flex-col gap-3 text-sm">
      {m.duties === undefined ? null : <Detail label="Duties">{m.duties}</Detail>}
      {(m.templates ?? []).length === 0 ? null : (
        <Detail label="Templates">{(m.templates ?? []).map(templateLine).join(", ")}</Detail>
      )}
      {m.jobs.length === 0 ? null : (
        <Detail label="Leading">
          <ul className="flex flex-col gap-1">
            {m.jobs.map((job) => (
              <li key={job.id} className="flex items-center justify-between gap-3">
                <span className="min-w-0 truncate">{job.title}</span>
                {props.canLead && others.length > 0 ? (
                  <Select
                    value={null}
                    onValueChange={(id) => {
                      const to = others.find((p) => p.id === id);
                      if (to !== undefined) props.onHandTo(job, to);
                    }}
                  >
                    <SelectTrigger size="sm" aria-label={`Hand ${job.title} to`}>
                      <SelectValue placeholder="Hand to…" />
                    </SelectTrigger>
                    <SelectPopup align="end" alignItemWithTrigger={false}>
                      {others.map((p) => (
                        <SelectItem key={p.id} value={p.id}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                ) : null}
              </li>
            ))}
          </ul>
        </Detail>
      )}
      {(m.moves ?? []).length === 0 ? null : (
        <Detail label="Hand-offs and referrals">
          <ul className="flex flex-col gap-1">
            {(m.moves ?? []).map((move) => (
              <li key={`${move.job}:${move.at}`}>{leadMoveLine(move, team)}</li>
            ))}
          </ul>
        </Detail>
      )}
      {m.recent.length === 0 ? null : (
        <Detail label="Lately">
          <ul className="flex flex-col gap-1">
            {m.recent.slice(0, 3).map((r) => (
              <li key={`${r.at}:${r.subject}`}>
                {r.subject}: {r.outcome}
              </li>
            ))}
          </ul>
        </Detail>
      )}
    </div>
  );
}

function Detail(props: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs font-medium text-muted-foreground">{props.label}</span>
      <div className="text-foreground">{props.children}</div>
    </div>
  );
}

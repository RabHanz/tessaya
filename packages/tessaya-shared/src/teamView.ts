/** The Team record in words, for every surface that draws it: desktop's Now page and job card, web, mobile. */
import type { TessayaTeamMember } from "@t3tools/tessaya-contracts";

/** A lead move as the job card (`terms.leadMoves`) and the Team board (`moves`) both carry it; ids are pack ids. */
export interface LeadMoveLike {
  readonly from: string;
  readonly to: string;
  readonly declined?: string | undefined;
  readonly title?: string;
}

type Named = { readonly id: string; readonly name: string };

/** A pack id to the name he knows; an id no longer in the pack shows as itself. */
export const personaName = (team: ReadonlyArray<Named>, id: string): string =>
  team.find((p) => p.id === id)?.name ?? id;

/** "Onyx handed it to Alfred", or "Alfred was suggested; you kept Onyx" for a suggestion he turned down. */
export const leadMoveLine = (move: LeadMoveLike, team: ReadonlyArray<Named>): string => {
  const name = (id: string) => personaName(team, id);
  const what = move.title === undefined ? "it" : move.title;
  return move.declined === undefined
    ? `${name(move.from)} handed ${what} to ${name(move.to)}`
    : `${name(move.declined)} was suggested for ${what}; you kept ${name(move.from)}`;
};

/** "Led 5: 3 done, 1 failed"; empty before it has led anything. */
export const trackLine = (track: TessayaTeamMember["track"]): string =>
  track === undefined || track.led === 0
    ? ""
    : `Led ${track.led}: ${track.done} done${track.failed > 0 ? `, ${track.failed} failed` : ""}`;

/** "Leading 2 jobs", "Busy" (a private persona) or "Free". */
export const loadLine = (member: TessayaTeamMember): string =>
  member.jobs.length > 0
    ? `Leading ${member.jobs.length} ${member.jobs.length === 1 ? "job" : "jobs"}`
    : member.busy
      ? "Busy"
      : "Free";

/** "Plan a trip (4 jobs, 2 lessons)": the templates it usually leads, with what each playbook has learned. */
export const templateLine = (t: NonNullable<TessayaTeamMember["templates"]>[number]): string =>
  t.jobs === 0 && t.lessons === 0
    ? t.title
    : `${t.title} (${t.jobs} ${t.jobs === 1 ? "job" : "jobs"}, ${t.lessons} ${t.lessons === 1 ? "lesson" : "lessons"})`;

/** Who else may lead a job: the team minus its lead, private personas included (a lead move tells no secrets). */
export const leadChoices = <P extends Named>(team: ReadonlyArray<P>, lead: string | undefined) =>
  team.filter((p) => p.id !== lead);

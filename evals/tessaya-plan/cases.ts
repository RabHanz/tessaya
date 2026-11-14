/**
 * Jobs a worker plans. A browser job's plan names its act set so his yes can lease it (PERSONA-TEAM-DESIGN §6, the
 * 12 Nov session that took four cards to open Google); a code job's plan leases nothing.
 */
export interface PlanCase {
  readonly id: string;
  readonly source: string;
  readonly goal: string;
  readonly tools: ReadonlyArray<"read" | "edit" | "shell" | "web" | "sessions">;
  /** A site the lease must cover, or null when the plan should lease nothing. */
  readonly site: string | null;
}

export const CASES: ReadonlyArray<PlanCase> = [
  {
    id: "browser-hotel",
    source: "computer-use-session-2026-11-12.md: four cards to open Google",
    goal: "Find me three hotels in Lisbon under 150 a night for the second week of December on booking.com and list them.",
    tools: ["web"],
    site: "booking.com",
  },
  {
    id: "browser-github",
    source: "PERSONA-TEAM-DESIGN §6: Onyx on consoles",
    goal: "Open the acme/app repository on github.com and read the open issues labelled bug, then summarise them.",
    tools: ["web", "read"],
    site: "github.com",
  },
  {
    id: "control-code",
    source: "control: ordinary code work needs no browser lease",
    goal: "Rename the helper formatDate to formatIsoDate across the acme/app repository and run the tests.",
    tools: ["read", "edit", "shell"],
    site: null,
  },
];

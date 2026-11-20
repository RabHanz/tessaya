import {
  batonDesktopBridge,
  TESSAYA_PLACES,
  TESSAYA_SETTINGS_GROUPS,
  tessayaLink,
  tessayaPlaceOf,
  type TessayaPlaceId,
} from "@t3tools/tessaya-contracts";
import { Link, useLocation } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";

import {
  useEnvironmentHttpBaseUrl,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "../../state/environments";
import { pickTessayaEnvironment } from "@t3tools/tessaya-shared/householdClient";
import { isTessayaGuest } from "../../tessayaGuestFlag";
import { Button } from "../ui/button";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { PromptLab } from "./PromptLabSettings";
import { AddPhoneSection } from "./AddPhoneSettings";
import { ApisSettingsPanel } from "./ApisSettings";
import { TessayaAccountsSettings } from "./TessayaAccountsSettings";
import { BrainSettingsPanel } from "./BrainSettings";
import { BrainUsagePanel } from "./BrainUsageSettings";
import { HealthSection } from "./HealthSettings";
import { RecentlyForgottenSection } from "./RecentlyForgottenSettings";
import { ActivityPanel } from "./ActivitySettings";
import { HardwareSettingsPanel } from "./HardwareSettings";
import { HomeSettingsPanel } from "./HomeSettings";
import { SettingsScopeProvider, useSettingsScope } from "./SettingsScopeContext";
import { StandingYeses } from "./StandingYeses";
import { TeamPanel } from "./TessayaTeam";
import { UpcomingPanel } from "./UpcomingSettings";
import type { SettingsScopeSearch } from "./settingsScope";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { VoiceLibrarySections } from "./VoiceLibrarySettings";
import { PersonaGroupsSection } from "./PersonaRosterSettings";

function AccountsPage() {
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {environment === null ? null : (
        <TessayaAccountsSettings
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      )}
    </SettingsPageContainer>
  );
}

/** This machine's own server: the code pairs the phone with it and every machine linked to it. */
function PhonePage() {
  const primary = usePrimaryEnvironmentId();
  return (
    <SettingsPageContainer>
      {primary === null ? null : <AddPhoneSection environmentId={primary} />}
    </SettingsPageContainer>
  );
}

/** Agents › Trust › Always allowed: every standing yes (moved from Brain, D-038). */
function AllowedPage() {
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {environment === null ? null : (
        <StandingYeses key={environment.environmentId} environmentId={environment.environmentId} />
      )}
    </SettingsPageContainer>
  );
}

function HealthPage() {
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {environment === null ? null : (
        <HealthSection key={environment.environmentId} environmentId={environment.environmentId} />
      )}
    </SettingsPageContainer>
  );
}

function ForgottenPage() {
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {environment === null ? null : (
        <RecentlyForgottenSection
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      )}
    </SettingsPageContainer>
  );
}

/**
 * Her household's pages: one brain, so no environment or project picker (D-038). They read this machine's server, and
 * when it is down any other connected machine of his, since every one of them forwards her calls to the brain.
 */
function useHouseholdEnvironmentId() {
  const primary = usePrimaryEnvironmentId();
  const { environments } = useEnvironments();
  const connected = environments
    .filter((e) => e.connection.phase === "connected")
    .map((e) => e.environmentId);
  return pickTessayaEnvironment(connected, primary);
}
/** Personas › Personas: one card per persona (voice, body and place, mood), then where they are and how they feel. */
function PersonasPage() {
  const primary = useHouseholdEnvironmentId();
  return (
    <SettingsPageContainer>
      {primary === null ? null : <VoiceLibrarySections page="personas" environmentId={primary} />}
    </SettingsPageContainer>
  );
}

function GroupsPage() {
  const primary = useHouseholdEnvironmentId();
  return (
    <SettingsPageContainer>
      {primary === null ? null : <PersonaGroupsSection key={primary} environmentId={primary} />}
    </SettingsPageContainer>
  );
}

const BENCHES = [
  ["voices", "Voices"],
  ["prompts", "Prompts"],
  ["compare", "Compare"],
  ["body", "Body"],
] as const;
type Bench = (typeof BENCHES)[number][0];
const isBench = (b: unknown): b is Bench => BENCHES.some(([id]) => id === b);

/**
 * Personas › Lab: try, compare, keep and use. Voices (the Playground, every voice and "Use it for"), Prompts (Prompt
 * Lab), Compare (blind A/B of two voices) and Body (the body playground), each moved here whole. `?bench=` opens one.
 */
function LabPage() {
  const primary = useHouseholdEnvironmentId();
  const search = useLocation({ select: (location) => location.search as Record<string, unknown> });
  const [bench, setBench] = useState<Bench>(isBench(search["bench"]) ? search["bench"] : "voices");
  const server = useEnvironmentHttpBaseUrl(primary);
  return (
    <SettingsPageContainer>
      <SettingsSection title="Lab">
        <SettingsRow
          title="Try, compare, keep, use"
          description="Clone and try voices, tune each persona's prompt, compare two blind, and pose the body. Or say “open the prompt lab”."
          control={
            <ToggleGroup
              aria-label="Lab bench"
              variant="segmented"
              value={[bench]}
              onValueChange={(next) => {
                if (isBench(next[0])) setBench(next[0]);
              }}
            >
              {BENCHES.map(([id, label]) => (
                <Toggle key={id} value={id}>
                  {label}
                </Toggle>
              ))}
            </ToggleGroup>
          }
        />
      </SettingsSection>
      {primary === null ? null : bench === "voices" ? (
        <VoiceLibrarySections environmentId={primary} />
      ) : bench === "compare" ? (
        <VoiceLibrarySections page="compare" environmentId={primary} />
      ) : bench === "prompts" ? (
        <PromptLab environmentId={primary} />
      ) : server === null ? null : (
        <iframe
          title="Body playground"
          src={new URL("/tessaya/playground", server).href}
          className="h-[75vh] w-full rounded-xl border"
        />
      )}
    </SettingsPageContainer>
  );
}

/** Tessaya's pages that T3's web app draws: her window shows them inline at `/tessaya/<page>`. */
const TESSAYA_PAGES = {
  hardware: HardwareSettingsPanel,
  homeassistant: HomeSettingsPanel,
  apis: ApisSettingsPanel,
  accounts: AccountsPage,
  lab: LabPage,
  // the Voices page became the Lab's Voices bench; its old address opens it
  voices: LabPage,
  personas: PersonasPage,
  groups: GroupsPage,
  // Cast lives in the Personas page now; its old address opens that page
  cast: PersonasPage,
  usage: BrainUsagePanel,
  activity: ActivityPanel,
  brain: BrainSettingsPanel,
  team: TeamPanel,
  upcoming: UpcomingPanel,
  phone: PhonePage,
  forgotten: ForgottenPage,
  health: HealthPage,
  allowed: AllowedPage,
} as const;

export type TessayaPage = keyof typeof TESSAYA_PAGES;
const UNSCOPED: ReadonlySet<TessayaPage> = new Set([
  "hardware",
  "personas",
  "groups",
  "lab",
  "voices",
  "cast",
]);

export const isTessayaPage = (page: string): page is TessayaPage =>
  Object.hasOwn(TESSAYA_PAGES, page);

/** One Tessaya page alone, without T3's sidebar or settings list, on this app's own environment. */
export function TessayaPageView({ page }: { readonly page: TessayaPage }) {
  // One household on one brain (D-038): her pages read this machine's server, which forwards to the brain, and never
  // offer a machine or project to pick. SettingsScopeSentence stays hidden on /tessaya/ pages.
  const household = useHouseholdEnvironmentId();
  const search: SettingsScopeSearch = household === null ? {} : { machine: household };
  const Page = TESSAYA_PAGES[page];
  // In a browser (not inside her window) each page has a way back to the list of her places.
  const back = isTessayaGuest() ? null : (
    <div className="px-4 pt-3 text-sm">
      <Link
        to="/settings/tessaya"
        className="text-muted-foreground underline-offset-2 hover:underline"
      >
        ‹ All of Tessaya
      </Link>
    </div>
  );
  // The household's pages: no settings scope, so no server picker (13 Nov, D-038).
  if (UNSCOPED.has(page))
    return (
      <div className="flex h-dvh min-h-0 flex-col overflow-auto bg-background">
        {back}
        <Page />
      </div>
    );
  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-auto bg-background">
      <SettingsScopeProvider search={search} singleEnvironment onChange={() => undefined}>
        {back}
        <Page />
      </SettingsScopeProvider>
    </div>
  );
}

const PLACE_PAGE: Partial<Record<TessayaPlaceId, TessayaPage>> = {
  brain: "brain",
  hardware: "hardware",
  homeassistant: "homeassistant",
  apis: "apis",
  accounts: "accounts",
  personas: "personas",
  phone: "phone",
  health: "health",
};

function OpenPlace({ id }: { readonly id: TessayaPlaceId }): ReactNode {
  const open = batonDesktopBridge()?.openTessaya;
  if (open !== undefined)
    return (
      <Button size="xs" variant="outline" onClick={() => open(tessayaLink(id))}>
        Open in Tessaya
      </Button>
    );
  const page = PLACE_PAGE[id];
  // A browser has no Tessaya window: the pages T3 draws still open here; the rest live on the computer.
  return page === undefined ? (
    <span className="text-xs text-muted-foreground">On your computer</span>
  ) : (
    <Button size="xs" variant="outline" render={<Link to="/tessaya/$page" params={{ page }} />}>
      Show here
    </Button>
  );
}

/** Where a T3 page's Tessaya section went, kept for a release (2026-11) on the page that held it. */
export function TessayaMovedSection({ place }: { readonly place: TessayaPlaceId }) {
  const found = TESSAYA_PLACES.find((candidate) => candidate.id === place);
  if (found === undefined) return null;
  return (
    <SettingsSection title={found.label}>
      <SettingsRow
        title={`${found.label} moved to Tessaya`}
        description={`Tessaya › Settings › ${found.group} › ${found.label}`}
        control={<OpenPlace id={found.id} />}
      />
    </SettingsSection>
  );
}

/**
 * Settings → Tessaya: every setting of hers, which live in her own window. `moved` is the T3 page that used to hold
 * one of them; its old link lands here for a release (2026-11) and says where it went.
 */
export function TessayaPlacesPanel({ moved }: { readonly moved?: TessayaPlaceId }) {
  const hash = useLocation({ select: (location) => location.hash });
  const focus = moved ?? tessayaPlaceOf(hash.replace(/^tessaya-/, ""));
  const focused = TESSAYA_PLACES.find((place) => place.id === focus);
  return (
    <SettingsPageContainer>
      {focused === undefined ? null : (
        <SettingsSection title={moved === undefined ? focused.label : `${focused.label} moved`}>
          <SettingsRow
            title={`${focused.label} is in Tessaya's window`}
            description={`Tessaya › Settings › ${focused.group} › ${focused.label}. Everything of Tessaya's lives there now; T3's window keeps agents, code and connections.`}
            control={<OpenPlace id={focused.id} />}
          />
        </SettingsSection>
      )}
      <SettingsSection title="Team">
        <SettingsRow
          title="The team"
          description="Who leads which job, what each persona does, and how its work went."
          control={
            <Button
              size="xs"
              variant="outline"
              render={<Link to="/tessaya/$page" params={{ page: "team" }} />}
            >
              Show here
            </Button>
          }
        />
      </SettingsSection>
      <SettingsSection title="Coming up">
        <SettingsRow
          title="Coming up"
          description="House timers, reminders, scheduled tasks and rules, soonest first; cancel, pause or move one."
          control={
            <Button
              size="xs"
              variant="outline"
              render={<Link to="/tessaya/$page" params={{ page: "upcoming" }} />}
            >
              Show here
            </Button>
          }
        />
      </SettingsSection>
      <SettingsSection title="Memory">
        <SettingsRow
          title="Recently forgotten"
          description="People and facts she forgot, to restore or delete for good."
          control={
            <Button
              size="xs"
              variant="outline"
              render={<Link to="/tessaya/$page" params={{ page: "forgotten" }} />}
            >
              Show here
            </Button>
          }
        />
      </SettingsSection>
      {TESSAYA_SETTINGS_GROUPS.map((group) => (
        <SettingsSection key={group} title={group}>
          {TESSAYA_PLACES.filter((place) => place.group === group).map((place) => (
            <SettingsRow key={place.id} title={place.label} control={<OpenPlace id={place.id} />} />
          ))}
        </SettingsSection>
      ))}
    </SettingsPageContainer>
  );
}

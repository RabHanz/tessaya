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

import { usePrimaryEnvironmentId } from "../../state/environments";
import { Button } from "../ui/button";
import { ApisSettingsPanel } from "./ApisSettings";
import { TessayaAccountsSettings } from "./TessayaAccountsSettings";
import { BrainSettingsPanel } from "./BrainSettings";
import { BrainUsagePanel } from "./BrainUsageSettings";
import { HardwareSettingsPanel } from "./HardwareSettings";
import { HomeSettingsPanel } from "./HomeSettings";
import { SettingsScopeProvider, useSettingsScope } from "./SettingsScopeContext";
import type { SettingsScopeSearch } from "./settingsScope";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { VoiceLibrarySections } from "./VoiceLibrarySettings";

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

function VoicesPage() {
  return (
    <SettingsPageContainer>
      <VoiceLibrarySections />
    </SettingsPageContainer>
  );
}

/** Tessaya's pages that T3's web app draws: her window shows them inline at `/tessaya/<page>`. */
const TESSAYA_PAGES = {
  hardware: HardwareSettingsPanel,
  homeassistant: HomeSettingsPanel,
  apis: ApisSettingsPanel,
  accounts: AccountsPage,
  voices: VoicesPage,
  usage: BrainUsagePanel,
  brain: BrainSettingsPanel,
} as const;

export type TessayaPage = keyof typeof TESSAYA_PAGES;

export const isTessayaPage = (page: string): page is TessayaPage =>
  Object.hasOwn(TESSAYA_PAGES, page);

/** One Tessaya page alone, without T3's sidebar or settings list, on this app's own environment. */
export function TessayaPageView({ page }: { readonly page: TessayaPage }) {
  // This machine's own server first: Tessaya's window belongs to it, not to whichever machine sorts first.
  const primary = usePrimaryEnvironmentId();
  const [chosen, setChosen] = useState<SettingsScopeSearch | null>(null);
  const search = chosen ?? (primary === null ? {} : { machine: primary });
  const Page = TESSAYA_PAGES[page];
  // Hardware is the household's devices on every server: no settings scope, so no server picker (13 Nov).
  if (page === "hardware")
    return (
      <div className="flex h-dvh min-h-0 flex-col overflow-auto bg-background">
        <Page />
      </div>
    );
  return (
    <div className="flex h-dvh min-h-0 flex-col overflow-auto bg-background">
      <SettingsScopeProvider search={search} singleEnvironment onChange={setChosen}>
        <Page />
      </SettingsScopeProvider>
    </div>
  );
}

const PLACE_PAGE: Partial<Record<TessayaPlaceId, TessayaPage>> = {
  hardware: "hardware",
  homeassistant: "homeassistant",
  apis: "apis",
  accounts: "accounts",
  personas: "voices",
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

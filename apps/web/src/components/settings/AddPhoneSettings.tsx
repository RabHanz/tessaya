/**
 * Tessaya › Phone › Add a phone: one QR pairs the phone with this machine and every machine linked to it. Each code is
 * one-time and lasts ten minutes; each shows under its machine's Authorized clients until used, and can be revoked there.
 */
import type { EnvironmentId } from "@t3tools/contracts";
import { phonePairingLink, type PhonePairingResult } from "@t3tools/tessaya-contracts";
import * as DateTime from "effect/DateTime";
import { useState } from "react";

import { isLoopbackHostname } from "~/environments/primary";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useNowSecond } from "../../hooks/useNowSecond";
import { desktopNetworkAccessStateAtom } from "../../state/desktopNetworkAccess";
import { formatEnvironmentQueryError, useEnvironmentQuery } from "../../state/query";
import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatExpiresInLabel } from "../../timestampFormat";
import { Button } from "../ui/button";
import { QRCodeSvg } from "../ui/qr-code";
import {
  resolveAdvertisedEndpointPairingUrl,
  resolveCurrentOriginPairingUrl,
  selectPairingEndpoint,
} from "./ConnectionsSettings.logic";
import { resolveDesktopPairingUrl } from "./pairingUrls";
import { SettingsRow, SettingsSection } from "./settingsLayout";

/** Where the phone reaches this machine: a non-loopback address the desktop advertises, or the page's own origin. */
function useHerePairingUrl(): (credential: string) => string | null {
  const desktop = typeof window !== "undefined" && window.desktopBridge !== undefined;
  const network = useEnvironmentQuery(desktop ? desktopNetworkAccessStateAtom : null).data;
  return (credential) => {
    const endpoint = selectPairingEndpoint(
      (network?.advertisedEndpoints ?? []).filter((e) => e.reachability !== "loopback"),
    );
    if (endpoint !== null) return resolveAdvertisedEndpointPairingUrl(endpoint, credential);
    const exposed = network?.serverExposureState.endpointUrl;
    if (exposed && !isLoopbackHostname(new URL(exposed).hostname))
      return resolveDesktopPairingUrl(exposed, credential);
    return isLoopbackHostname(window.location.hostname)
      ? null
      : resolveCurrentOriginPairingUrl(credential);
  };
}

export function AddPhoneSection({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const issue = useAtomCommand(tessayaWorkSessions.phonePairing, { reportFailure: false });
  const hereUrl = useHerePairingUrl();
  const nowMs = useNowSecond();
  const { copyToClipboard, isCopied } = useCopyToClipboard();
  const [codes, setCodes] = useState<PhonePairingResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const make = async () => {
    setBusy(true);
    setError(null);
    const result = await issue({ environmentId, input: {} });
    setBusy(false);
    if (result._tag === "Success") setCodes(result.value);
    else setError(formatEnvironmentQueryError(result.cause));
  };

  const here = codes === null ? null : hereUrl(codes.here.credential);
  const urls =
    codes === null
      ? []
      : [...(here === null ? [] : [here]), ...codes.linked.map((l) => l.pairingUrl)];
  const link = urls.length === 0 ? null : phonePairingLink(urls);
  const expiresAt = codes === null ? null : DateTime.formatIso(codes.here.expiresAt);
  const expired = expiresAt !== null && Date.parse(expiresAt) <= nowMs;

  return (
    <SettingsSection title="Add a phone" id="add-phone">
      <SettingsRow
        title="Pair your phone with every machine"
        description="One code pairs the phone with this machine and each machine linked to it. In the phone app: Environments, Add environment, then Scan. Each code works once, for ten minutes."
        control={
          <Button size="sm" variant="outline" disabled={busy} onClick={() => void make()}>
            {busy ? "Making code…" : codes === null ? "Show code" : "New code"}
          </Button>
        }
      />
      {error === null ? null : (
        <p role="alert" className="px-4 pb-3 text-xs text-destructive">
          {error}
        </p>
      )}
      {codes === null ? null : (
        <div className="flex flex-col gap-3 px-4 pb-4 sm:flex-row sm:items-start">
          {link === null || expired ? null : (
            <div className="self-center rounded-lg bg-white p-2 sm:self-start">
              <QRCodeSvg
                value={link}
                size={192}
                level="L"
                marginSize={1}
                title="Phone pairing code. Scan it in the phone app"
              />
            </div>
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-2 text-xs">
            <p className="text-muted-foreground">
              {expired
                ? "These codes have expired. Make a new one."
                : expiresAt === null
                  ? null
                  : formatExpiresInLabel(expiresAt, nowMs)}
            </p>
            <ul className="flex flex-col gap-1">
              <li>
                {here === null
                  ? "This machine: left out, it has no address your phone can reach. Turn on network access in Connections."
                  : "This machine"}
              </li>
              {codes.linked.map((l) => (
                <li key={l.environmentId}>{l.label}</li>
              ))}
              {codes.missed.map((m) => (
                <li key={m.label} className="text-muted-foreground">
                  {m.label}: left out. {m.reason}
                </li>
              ))}
            </ul>
            {link === null || expired ? null : (
              <div>
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => copyToClipboard(link, undefined)}
                >
                  {isCopied ? "Copied" : "Copy link"}
                </Button>
              </div>
            )}
          </div>
        </div>
      )}
    </SettingsSection>
  );
}

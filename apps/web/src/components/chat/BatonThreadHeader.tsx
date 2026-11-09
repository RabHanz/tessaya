/**
 * The thread header's Tessaya parts (ACCOUNTS-3): a Terminal tag on terminal threads, one limit chip for the thread's
 * own account, and the Herdr pane behind a ⋯ menu.
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { maskedEmail, roomDetail, roomText, roomTone } from "@t3tools/baton-shared/accountRoom";
import { isLiveThreadId, LIVE_INSTANCE } from "@t3tools/baton-shared/liveThread";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { EllipsisIcon, GaugeIcon, SquareTerminalIcon } from "lucide-react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useComposerHandleContext } from "../../composerHandleContext";
import { batonWorkSessions } from "../../state/batonWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useTerminalUiStateStore } from "../../terminalUiStateStore";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Menu, MenuGroup, MenuGroupLabel, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useLiveAccounts } from "./BatonLiveModel";
import { useBatonAccounts } from "./BatonPickerAccount";

const TONE_VARIANT = { ok: "outline", warn: "warning", limit: "error" } as const;

/** "Work · 5h 34% · wk 62%" for the account this thread runs as; nothing when that is not known. */
function LimitChip(props: {
  readonly threadRef: ScopedThreadRef;
  readonly shell: EnvironmentThreadShell;
  readonly terminal: boolean;
}) {
  const now = Date.parse(`${useNowMinute()}:00Z`);
  const composer = useComposerHandleContext();
  const accounts = useBatonAccounts(props.threadRef.environmentId);
  const login = useLiveAccounts(props.threadRef).find((entry) => entry.active);
  const instanceId = props.shell.modelSelection.instanceId;
  const account =
    instanceId === LIVE_INSTANCE
      ? accounts.find((entry) => login !== undefined && entry.liveSwitchKey === login.key)
      : accounts.find((entry) => entry.instanceIds.includes(instanceId));
  if (account === undefined) return null;
  const room = roomText(account, now);
  const used = Math.round(
    Math.max(account.fiveHour?.usedPercent ?? 0, account.weekly?.usedPercent ?? 0),
  );
  const Icon = props.terminal ? SquareTerminalIcon : GaugeIcon;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Badge
            variant={TONE_VARIANT[roomTone(account)]}
            data-testid="thread-limit-chip"
            render={
              <button
                type="button"
                aria-label={`${account.label}: open the picker on its accounts`}
                onClick={() => composer?.current?.openModelPicker()}
              />
            }
          />
        }
      >
        {/* On a phone the chip is an icon and the % used, so the thread title keeps its room. */}
        <span className="max-sm:hidden">
          {room === null ? account.label : `${account.label} · ${room}`}
        </span>
        <span className="inline-flex items-center gap-1 sm:hidden">
          <Icon aria-hidden />
          {room === null ? null : `${used}%`}
        </span>
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        {props.terminal ? <div className="sm:hidden">Terminal session</div> : null}
        <div>
          {account.label}
          {account.email === null ? "" : ` · ${maskedEmail(account.email)}`}
        </div>
        {roomDetail(account, now).map((line) => (
          <div key={line}>{line}</div>
        ))}
      </TooltipPopup>
    </Tooltip>
  );
}

/** The Herdr pane, its id to copy, a terminal to attach from, and the move into Tessaya: kept out of the header line. */
function PaneMenu(props: { readonly threadRef: ScopedThreadRef; readonly pane: string | null }) {
  const { pane } = props;
  const herdrSession = pane === null ? null : (pane.split("~")[0] ?? pane);
  const { copyToClipboard } = useCopyToClipboard<string>({
    onCopy: (title) => toastManager.add({ type: "success", title }),
    onError: () => toastManager.add({ type: "error", title: "Could not copy" }),
  });
  const move = useAtomCommand(batonWorkSessions.sessionsMoveIntoTessaya, { reportFailure: false });
  const moveIntoTessaya = async () => {
    const confirmed = await requestConfirmDialog(
      "Move this session into Tessaya?\nIts terminal process ends and the same conversation continues here, with Tessaya's account switching and handover. Open in terminal brings it back.",
    );
    if (confirmed !== true) return;
    const result = await move({
      environmentId: props.threadRef.environmentId,
      input: { threadId: props.threadRef.threadId, providerChangeApproved: true },
    });
    toastManager.add(
      result._tag === "Success" && result.value.state === "moved"
        ? { type: "success", title: "Moved into Tessaya", description: result.value.detail }
        : {
            type: "error",
            title: "Not moved",
            ...(result._tag === "Success" ? { description: result.value.detail } : {}),
          },
    );
  };
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Terminal session actions"
            data-testid="thread-pane-menu"
          />
        }
      >
        <EllipsisIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        {pane === null || herdrSession === null ? null : (
          <MenuGroup>
            <MenuGroupLabel>Herdr pane {pane}</MenuGroupLabel>
            <MenuItem onClick={() => copyToClipboard(pane, "Pane id copied")}>
              Copy pane id
            </MenuItem>
            <MenuItem
              onClick={() => {
                // T3's terminal cannot be started on a command, so it opens with the attach line ready to paste.
                useTerminalUiStateStore.getState().setTerminalOpen(props.threadRef, true);
                copyToClipboard(
                  `herdr session attach ${herdrSession}`,
                  "Attach command copied: paste it here",
                );
              }}
            >
              Open in terminal
            </MenuItem>
          </MenuGroup>
        )}
        {isLiveThreadId(props.threadRef.threadId) ? (
          <MenuItem onClick={() => void moveIntoTessaya()}>Move into Tessaya…</MenuItem>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}

/** A Tessaya Claude thread's way out to a terminal: its own session in a Herdr pane, handed back when that closes. */
function OpenInTerminalMenu(props: { readonly threadRef: ScopedThreadRef }) {
  const open = useAtomCommand(batonWorkSessions.sessionsOpenInTerminal, { reportFailure: false });
  const openInTerminal = async () => {
    const result = await open({
      environmentId: props.threadRef.environmentId,
      input: { threadId: props.threadRef.threadId },
    });
    toastManager.add(
      result._tag === "Success" && result.value.state === "opened"
        ? { type: "success", title: "Opened in a terminal", description: result.value.detail }
        : {
            type: "error",
            title: "Not opened",
            ...(result._tag === "Success" ? { description: result.value.detail } : {}),
          },
    );
  };
  return (
    <Menu>
      <MenuTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label="Session actions"
            data-testid="thread-session-menu"
          />
        }
      >
        <EllipsisIcon />
      </MenuTrigger>
      <MenuPopup align="end">
        <MenuItem onClick={() => void openInTerminal()}>Open in terminal</MenuItem>
      </MenuPopup>
    </Menu>
  );
}

export function BatonThreadHeader(props: {
  readonly threadRef: ScopedThreadRef;
  readonly shell: EnvironmentThreadShell;
  readonly pane: string | null;
}) {
  // A Tessaya thread open in a terminal is on the live instance too, under its own id.
  const terminal = props.shell.providerInstanceId === LIVE_INSTANCE;
  const claude = useBatonAccounts(props.threadRef.environmentId).some(
    (account) =>
      account.driver === "claudeAgent" &&
      account.instanceIds.includes(props.shell.providerInstanceId),
  );
  return (
    <>
      {terminal ? (
        <span className="max-sm:hidden">
          <Badge variant="secondary" size="sm" data-testid="thread-terminal-tag">
            Terminal
          </Badge>
        </span>
      ) : null}
      <LimitChip threadRef={props.threadRef} shell={props.shell} terminal={terminal} />
      {terminal ? (
        props.pane !== null || isLiveThreadId(props.threadRef.threadId) ? (
          <PaneMenu threadRef={props.threadRef} pane={props.pane} />
        ) : null
      ) : claude ? (
        <OpenInTerminalMenu threadRef={props.threadRef} />
      ) : null}
    </>
  );
}

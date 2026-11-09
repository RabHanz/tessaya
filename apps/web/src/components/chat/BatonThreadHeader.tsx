/**
 * The thread header's Tessaya parts (ACCOUNTS-3): a Terminal tag on terminal threads, one limit chip for the thread's
 * own account, and the Herdr pane behind a ⋯ menu.
 */
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { maskedEmail, roomDetail, roomText, roomTone } from "@t3tools/baton-shared/accountRoom";
import { isLiveThreadId, LIVE_INSTANCE } from "@t3tools/baton-shared/liveThread";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { EllipsisIcon } from "lucide-react";

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
}) {
  const now = Date.parse(`${useNowMinute()}:00Z`);
  const accounts = useBatonAccounts(props.threadRef.environmentId);
  const login = useLiveAccounts(props.threadRef).find((entry) => entry.active);
  const instanceId = props.shell.modelSelection.instanceId;
  const account =
    instanceId === LIVE_INSTANCE
      ? accounts.find((entry) => login !== undefined && entry.liveSwitchKey === login.key)
      : accounts.find((entry) => entry.instanceIds.includes(instanceId));
  if (account === undefined) return null;
  const room = roomText(account, now);
  return (
    <Tooltip>
      <TooltipTrigger
        render={<Badge variant={TONE_VARIANT[roomTone(account)]} data-testid="thread-limit-chip" />}
      >
        {room === null ? account.label : `${account.label} · ${room}`}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
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

const copy = (text: string, title: string) =>
  void navigator.clipboard.writeText(text).then(
    () => toastManager.add({ type: "success", title }),
    () => toastManager.add({ type: "error", title: "Could not copy" }),
  );

/** The Herdr pane, its id to copy, and a terminal to attach from: kept out of the header line. */
function PaneMenu(props: { readonly threadRef: ScopedThreadRef; readonly pane: string }) {
  const herdrSession = props.pane.split("~")[0] ?? props.pane;
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
        <MenuGroup>
          <MenuGroupLabel>Herdr pane {props.pane}</MenuGroupLabel>
          <MenuItem onClick={() => copy(props.pane, "Pane id copied")}>Copy pane id</MenuItem>
          <MenuItem
            onClick={() => {
              // T3's terminal cannot be started on a command, so it opens with the attach line ready to paste.
              useTerminalUiStateStore.getState().setTerminalOpen(props.threadRef, true);
              copy(`herdr session attach ${herdrSession}`, "Attach command copied: paste it here");
            }}
          >
            Open in terminal
          </MenuItem>
        </MenuGroup>
      </MenuPopup>
    </Menu>
  );
}

export function BatonThreadHeader(props: {
  readonly threadRef: ScopedThreadRef;
  readonly shell: EnvironmentThreadShell;
  readonly pane: string | null;
}) {
  const terminal =
    isLiveThreadId(props.threadRef.threadId) && props.shell.providerInstanceId === LIVE_INSTANCE;
  return (
    <>
      {terminal ? (
        <Badge variant="secondary" size="sm" data-testid="thread-terminal-tag">
          Terminal
        </Badge>
      ) : null}
      <LimitChip threadRef={props.threadRef} shell={props.shell} />
      {terminal && props.pane !== null ? (
        <PaneMenu threadRef={props.threadRef} pane={props.pane} />
      ) : null}
    </>
  );
}

/**
 * A live thread whose terminal session is not running says so, always, instead of answering with a chat message:
 * the session list is read every 30 s, and a stopped session offers Resume (the same session id comes back).
 */
import type { ScopedThreadRef } from "@t3tools/contracts";
import { bindingBanner, bindingOf } from "@t3tools/baton-shared/liveThread";
import { useEffect, useState } from "react";

import { batonWorkSessions } from "../../state/batonWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";
import { useAtomSet } from "@effect/atom-react";
import { liveLoginAtom, liveSessionIdOf } from "./BatonLiveModel";

const CHECK_MS = 30_000;
type Found =
  | {
      readonly state: string;
      readonly source: string;
      readonly pane: string | null;
      readonly answeredBy: string | null;
    }
  | "missing"
  | null;

export function BatonLiveBinding({ threadRef }: { readonly threadRef: ScopedThreadRef }) {
  const sessionId = liveSessionIdOf(threadRef.threadId);
  const list = useAtomCommand(batonWorkSessions.sessionsList, { reportFailure: false });
  const resume = useAtomCommand(batonWorkSessions.sessionsResume, { reportFailure: false });
  const [found, setFound] = useState<Found>(null);
  const setLogin = useAtomSet(liveLoginAtom(sessionId ?? ""));
  const reattach = useAtomCommand(batonWorkSessions.sessionsReattach, { reportFailure: false });
  const kept = useAtomCommand(batonWorkSessions.sessionsKept, { reportFailure: false });
  const [messages, setMessages] = useState<ReadonlyArray<{ id: string; text: string }>>([]);
  const [busy, setBusy] = useState(false);
  // A folder with exactly one other running session: shown as "Reattach to <pane>?" until he taps it (never guessed).
  const [offer, setOffer] = useState<string | null>(null);
  const { environmentId } = threadRef;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- polls the server's session list, outside React
  useEffect(() => {
    if (sessionId === null) return;
    let cancelled = false;
    const check = () =>
      void list({ environmentId, input: { query: sessionId, limit: 10 } }).then((result) => {
        if (cancelled || result._tag !== "Success") return;
        const row = result.value.sessions.find((entry) => entry.id === sessionId);
        setLogin(row?.account ?? null);
        setFound(
          row === undefined
            ? "missing"
            : {
                state: row.state,
                source: row.source,
                pane: row.pane ?? null,
                answeredBy: row.answeredBy ?? null,
              },
        );
      });
    const checkKept = () =>
      void kept({ environmentId, input: { threadId: threadRef.threadId } }).then((result) => {
        if (!cancelled && result._tag === "Success") setMessages(result.value.messages);
      });
    check();
    checkKept();
    const timer = setInterval(() => {
      check();
      checkKept();
    }, CHECK_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [environmentId, kept, list, sessionId, setLogin, threadRef.threadId]);

  const banner = bindingBanner(found);
  const binding = bindingOf(found);
  if (sessionId === null) return null;
  const keptUi = messages.map((message) => (
    <span
      key={message.id}
      className="flex shrink-0 items-center gap-1"
      data-testid="thread-kept-message"
    >
      <span className="max-w-48 truncate text-2xs text-muted-foreground">
        Kept, not delivered: {message.text}
      </span>
      <Button
        size="xs"
        variant="outline"
        disabled={busy}
        className="shrink-0 [-webkit-app-region:no-drag]"
        onClick={() => {
          setBusy(true);
          void kept({
            environmentId,
            input: { threadId: threadRef.threadId, retryId: message.id },
          }).then((result) => {
            setBusy(false);
            if (result._tag === "Success") setMessages(result.value.messages);
            toastManager.add(
              result._tag === "Success" && result.value.retry === "sent"
                ? { type: "success", title: "Sent again" }
                : { type: "error", title: "Could not send it yet", description: "It stays kept." },
            );
          });
        }}
      >
        Retry
      </Button>
    </span>
  ));
  if (binding === null) return <>{keptUi}</>;
  const doReattach = () => {
    setBusy(true);
    void reattach({
      environmentId,
      input: { sessionId, ...(offer === null ? {} : { confirmPane: offer }) },
    }).then((result) => {
      setBusy(false);
      const state = result._tag === "Success" ? result.value.state : null;
      if (state === "confirm" && result._tag === "Success") setOffer(result.value.pane);
      else
        toastManager.add(
          state === "reattached" || state === "already-bound"
            ? {
                type: "success",
                title: "Reattached",
                description: "The thread follows its session.",
              }
            : {
                type: "error",
                title: "Could not reattach",
                ...(result._tag === "Success" ? { description: result.value.detail } : {}),
              },
        );
      if (state !== "confirm") setOffer(null);
    });
  };
  return (
    <>
      <span className="flex min-w-0 shrink items-center gap-1" data-testid="thread-not-connected">
        <span
          className={
            binding.kind === "pane"
              ? "min-w-0 truncate text-2xs text-muted-foreground"
              : "min-w-0 truncate text-2xs text-warning-foreground"
          }
        >
          {banner === null ? binding.text : `${banner.text} ${binding.text}`}
        </span>
        {binding.kind !== "pane" ? (
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            className="shrink-0 [-webkit-app-region:no-drag]"
            onClick={doReattach}
          >
            {offer === null ? "Reattach" : `Reattach to ${offer}?`}
          </Button>
        ) : null}
        {banner === null ? null : (
          <Button
            size="xs"
            variant="outline"
            disabled={busy}
            className="shrink-0 [-webkit-app-region:no-drag]"
            onClick={() => {
              setBusy(true);
              void resume({ environmentId, input: { sessionId } }).then((result) => {
                setBusy(false);
                toastManager.add(
                  result._tag === "Success"
                    ? {
                        type: "success",
                        title: "Resuming this session",
                        description: "The thread follows it once it runs.",
                      }
                    : { type: "error", title: "Could not resume this session" },
                );
              });
            }}
          >
            Resume
          </Button>
        )}
      </span>
      {keptUi}
    </>
  );
}

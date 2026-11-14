import type { EnrolCard } from "@t3tools/tessaya-contracts";

import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

const MARK = { done: "✓", again: "↺", now: "▸" } as const;

/** The sentence being read: the words he has said, the one he is on, and the rest. */
function Followed(props: {
  readonly text: string;
  readonly heard: number;
  readonly again: boolean;
}) {
  const words = props.text.split(" ");
  const said = words.slice(0, props.heard).join(" ");
  const next = words[props.heard];
  const rest = words.slice(props.heard + 1).join(" ");
  return (
    <>
      <span className={props.again ? "text-warning-foreground" : "text-primary"}>{said}</span>
      {said && next !== undefined ? " " : null}
      {next === undefined ? null : <span className="border-primary border-b-2">{next}</span>}
      {rest ? ` ${rest}` : null}
    </>
  );
}

/** The guided read while he enrols an R1: the room loop builds the card, this only draws it. */
export function VoiceEnrolCard({
  card,
  onClose,
  onRedo,
}: {
  readonly card: EnrolCard;
  readonly onClose: () => void;
  readonly onRedo: () => void;
}) {
  const over = card.phase === "done" || card.phase === "failed";
  const read = card.lines.filter((l) => l.state === "done").length;
  const again = card.lines.filter((l) => l.state === "again").length;
  const current = card.lines.find((l) => l.state === "again" || l.state === "now");
  // A click outside or Escape mid-read is not a cancel (13 Nov: two phantom cancels); only Cancel stops it.
  return (
    <Dialog open onOpenChange={(open) => !open && over && onClose()}>
      <DialogPopup showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{over && card.summary ? card.summary.headline : card.title}</DialogTitle>
          {over ? null : (
            <DialogDescription>
              {card.phase === "saving" ? "Making the voice profile from your read…" : card.lead}
            </DialogDescription>
          )}
        </DialogHeader>
        <DialogPanel>
          <p aria-live="polite" className="sr-only">
            {over ? "" : current ? (current.why ?? `Read: ${current.text}`) : ""}
          </p>
          {over && card.summary ? (
            <>
              <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-sm">
                {card.summary.rows.map((r) => (
                  <div key={r.label} className="contents">
                    <dt className="text-muted-foreground">{r.label}</dt>
                    <dd className="flex items-center gap-2">
                      {r.label === "Quality" ? (
                        <span aria-hidden className="inline-flex gap-0.5">
                          {[1, 2, 3].map((i) => (
                            <i
                              key={i}
                              className={cn(
                                "h-1.5 w-3.5 rounded-full",
                                i <= card.summary!.quality ? "bg-primary" : "bg-muted",
                              )}
                            />
                          ))}
                        </span>
                      ) : null}
                      {r.value}
                    </dd>
                  </div>
                ))}
              </dl>
              {card.summary.tip ? (
                <p className="rounded-lg border-s-2 border-primary bg-muted px-3 py-2 text-muted-foreground text-sm">
                  {card.summary.tip}
                </p>
              ) : null}
            </>
          ) : (
            <>
              <div className="flex items-center gap-3 text-muted-foreground text-xs">
                <span>
                  {read} of {card.lines.length} read
                </span>
                <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                  <span
                    className="block h-full bg-primary"
                    style={{ width: `${Math.round((100 * read) / card.lines.length)}%` }}
                  />
                </span>
                <span>{again > 0 ? `${again} to read again` : "about 30 s"}</span>
              </div>
              <ol className="grid gap-1">
                {card.lines.map((l, i) => {
                  const live = l.state === "now" || l.state === "again";
                  return (
                    <li
                      key={l.text}
                      className={cn(
                        "grid grid-cols-[1.25rem_1fr] gap-2 rounded-lg px-2.5 py-2 text-sm",
                        l.state === "todo" && "text-muted-foreground",
                        l.state === "now" && "bg-primary/10 text-base",
                        l.state === "again" && "bg-warning/10 text-base",
                        l.state === "done" && "text-muted-foreground max-sm:truncate",
                      )}
                    >
                      <span
                        aria-hidden
                        className={cn(
                          "text-center text-xs leading-6",
                          l.state === "again" ? "text-warning-foreground" : "text-primary",
                          l.state === "todo" && "text-muted-foreground",
                        )}
                      >
                        {l.state === "todo" ? i + 1 : MARK[l.state]}
                      </span>
                      <span className={cn(l.state === "done" && "max-sm:truncate")}>
                        {live ? (
                          <Followed text={l.text} heard={l.heard} again={l.state === "again"} />
                        ) : (
                          l.text
                        )}
                        {l.why ? (
                          <span className="mt-1 block font-medium text-warning-foreground text-xs">
                            {l.why}
                          </span>
                        ) : null}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </>
          )}
        </DialogPanel>
        <DialogFooter variant="bare" className="sm:items-center">
          {over ? null : (
            <span className="flex flex-1 items-center gap-2 text-muted-foreground text-xs">
              Listening through {card.mic}
              {card.phase === "reading" ? (
                <span
                  role="meter"
                  aria-label="Microphone level"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(card.level * 100)}
                  className="h-1.5 w-20 overflow-hidden rounded-full bg-muted"
                >
                  <span
                    className="block h-full bg-primary"
                    style={{ width: `${Math.round(card.level * 100)}%` }}
                  />
                </span>
              ) : null}
            </span>
          )}
          {over ? (
            <Button variant="outline" onClick={onRedo}>
              Redo
            </Button>
          ) : null}
          <Button variant={over ? "default" : "outline"} onClick={onClose} autoFocus={over}>
            {over ? "Done" : "Cancel"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

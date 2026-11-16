/**
 * Settings → Activity (B-046): every action on this server and what caused it, filterable; a row opens its "why"
 * (the cause chain) and what it caused. Likely bugs and gaps from the log's detector sit on top.
 */
import type {
  EnvironmentId,
  TessayaActionEvent,
  TessayaActivityListResult,
  TessayaActivityWhyResult,
} from "@t3tools/tessaya-contracts";
import { useEffect, useState } from "react";

import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { SettingsPageContainer, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

const RANGES = [
  { minutes: 60, label: "Hour" },
  { minutes: 1_440, label: "Day" },
  { minutes: 10_080, label: "7 days" },
] as const;
const FAMILIES = [
  "",
  "tool",
  "model",
  "rpc",
  "device",
  "room",
  "record",
  "outcome",
  "private",
] as const;
const time = new Intl.DateTimeFormat(undefined, { dateStyle: "short", timeStyle: "medium" });

const who = (e: TessayaActionEvent) => {
  const name = e.actor.id ?? e.actor.kind;
  return e.actor.certainty < 1 ? `${name} (${Math.round(e.actor.certainty * 100)}%)` : name;
};

export function ActivityPanel() {
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {environment?.connection.phase === "connected" ? (
        <ActivitySections
          key={environment.environmentId}
          environmentId={environment.environmentId}
        />
      ) : (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          Connect an environment to see what she did and why.
        </p>
      )}
    </SettingsPageContainer>
  );
}

function ActivitySections({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const list = useAtomCommand(tessayaWorkSessions.activityList, { reportFailure: false });
  const why = useAtomCommand(tessayaWorkSessions.activityWhy, { reportFailure: false });
  const [minutes, setMinutes] = useState<number>(60);
  const [family, setFamily] = useState<string>("");
  const [text, setText] = useState("");
  const [result, setResult] = useState<TessayaActivityListResult | null>(null);
  const [failed, setFailed] = useState(false);
  const [open, setOpen] = useState<{
    readonly id: string;
    readonly why: TessayaActivityWhyResult | "reading" | "failed";
  } | null>(null);

  const refresh = async () => {
    const r = await list({
      environmentId,
      input: {
        sinceMinutes: minutes,
        limit: 300,
        ...(family === "" ? {} : { kind: family }),
        ...(text.trim() === "" ? {} : { text: text.trim() }),
      },
    });
    setFailed(r._tag !== "Success");
    if (r._tag === "Success") setResult(r.value);
  };
  const toggle = async (id: string) => {
    if (open?.id === id) return setOpen(null);
    setOpen({ id, why: "reading" });
    const r = await why({ environmentId, input: { id } });
    const answer = r._tag === "Success" ? r.value : "failed";
    setOpen((current) => (current?.id === id ? { id, why: answer } : current));
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the server's log once per environment, range and family
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect, react/exhaustive-effect-dependencies -- one read per environment, range and family; refresh closes over them
    void refresh();
  }, [environmentId, minutes, family]);

  return (
    <>
      {result !== null && result.findings.length > 0 ? (
        <SettingsSection title="Likely bugs and gaps">
          <ul className="divide-y text-sm">
            {result.findings.map((f) => (
              <li
                key={`${f.rule}|${f.key}`}
                className="flex items-start justify-between gap-3 px-4 py-2"
              >
                <span>
                  {f.title}
                  <span className="text-muted-foreground">
                    {" "}
                    · {f.count}× · last {time.format(f.lastAt)}
                  </span>
                </span>
                {f.eventIds.length === 0 ? null : (
                  <Button
                    size="xs"
                    variant="outline"
                    onClick={() => void toggle(f.eventIds.at(-1)!)}
                  >
                    Why
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </SettingsSection>
      ) : null}
      <SettingsSection
        title="What she did"
        headerAction={
          <div className="flex gap-1" role="group" aria-label="Range">
            {RANGES.map((range) => (
              <Button
                key={range.minutes}
                size="xs"
                variant={range.minutes === minutes ? "secondary" : "ghost-muted"}
                aria-pressed={range.minutes === minutes}
                onClick={() => setMinutes(range.minutes)}
              >
                {range.label}
              </Button>
            ))}
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-2 px-4 py-2">
          <div className="flex flex-wrap gap-1" role="group" aria-label="Kind">
            {FAMILIES.map((f) => (
              <Button
                key={f}
                size="xs"
                variant={f === family ? "secondary" : "ghost-muted"}
                aria-pressed={f === family}
                onClick={() => setFamily(f)}
              >
                {f === "" ? "All" : f}
              </Button>
            ))}
          </div>
          <form
            className="flex gap-1"
            onSubmit={(event) => {
              event.preventDefault();
              void refresh();
            }}
          >
            <Input
              aria-label="Search the log"
              placeholder="Tool, device, setting…"
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
            <Button size="xs" type="submit" variant="outline">
              Find
            </Button>
          </form>
        </div>
        {failed ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">Couldn't read the log.</p>
        ) : result === null ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">Reading…</p>
        ) : result.events.length === 0 ? (
          <p className="px-4 py-3 text-sm text-muted-foreground">Nothing in this window.</p>
        ) : (
          <ul className="divide-y text-sm">
            {result.events.map((e) => (
              <li key={e.id}>
                <button
                  type="button"
                  className="flex w-full items-baseline gap-3 px-4 py-1.5 text-left hover:bg-accent"
                  aria-expanded={open?.id === e.id}
                  onClick={() => void toggle(e.id)}
                >
                  <span className="shrink-0 tabular-nums text-muted-foreground">
                    {time.format(e.at)}
                  </span>
                  <span className="shrink-0 font-medium">{e.kind}</span>
                  <span className="min-w-0 flex-1 truncate">{e.subject}</span>
                  <span className="shrink-0 text-muted-foreground">{who(e)}</span>
                  {e.outcome === "ok" ? null : (
                    <span className="shrink-0 text-destructive">{e.outcome}</span>
                  )}
                </button>
                {open?.id === e.id ? <WhyView why={open.why} /> : null}
              </li>
            ))}
          </ul>
        )}
        {result !== null && result.dropped > 0 ? (
          <p className="px-4 py-2 text-xs text-muted-foreground">
            {result.dropped} events were dropped since this server started (the writer fell behind).
          </p>
        ) : null}
      </SettingsSection>
      {open !== null && !result?.events.some((e) => e.id === open.id) ? (
        <SettingsSection title="Why">
          <WhyView why={open.why} />
        </SettingsSection>
      ) : null}
    </>
  );
}

function WhyView({ why }: { readonly why: TessayaActivityWhyResult | "reading" | "failed" }) {
  if (why === "reading") return <p className="px-6 py-2 text-xs text-muted-foreground">Tracing…</p>;
  if (why === "failed")
    return <p className="px-6 py-2 text-xs text-muted-foreground">Couldn't trace it.</p>;
  return (
    <div className="space-y-1 px-6 py-2 text-xs">
      {why.lines.map((line, i) => (
        <p key={line} className={i === 0 ? "font-medium" : "text-muted-foreground"}>
          {line}
        </p>
      ))}
      {why.effects.length === 0 ? null : (
        <p className="text-muted-foreground">
          Led to:{" "}
          {why.effects
            .map((e) => `${e.kind}${e.subject === "" ? "" : ` (${e.subject})`}`)
            .join(", ")}
        </p>
      )}
    </div>
  );
}

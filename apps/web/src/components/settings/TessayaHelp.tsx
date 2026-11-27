import { batonDesktopBridge, type EnvironmentId } from "@t3tools/tessaya-contracts";
import {
  DOC_AREAS,
  DOC_AUDIENCES,
  DOC_FEATURES,
  DOC_LESSONS,
  DOC_SURFACES,
  lessonDone,
  searchDocs,
  type DocAudience,
  type DocFeature,
  type DocStatus,
  type DocSurface,
} from "@t3tools/tessaya-shared/docs";
import { readLearnProgress } from "@t3tools/tessaya-shared/learn";
import { Link, useLocation } from "@tanstack/react-router";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { readLocalApi } from "../../localApi";
import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { useLeadAsk } from "../sidebar/useLeadAsk";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

const GUIDES = "https://github.com/RabHanz/tessaya/blob/main/docs/user/";
/** The pages T3's web app draws, so "Show me" in a browser opens them here. */
const WEB_PAGES = new Set([
  "hardware",
  "homeassistant",
  "apis",
  "accounts",
  "lab",
  "personas",
  "groups",
  "usage",
  "upcoming",
  "phone",
  "health",
]);

const STATUS = {
  live: { label: msg("Live"), variant: "success" },
  beta: { label: msg("Beta"), variant: "warning" },
  coming: { label: msg("Coming"), variant: "outline" },
} as const;

function StatusBadge({ status }: { readonly status: DocStatus }) {
  const s = STATUS[status];
  const m = useMessages();
  return (
    <Badge size="sm" variant={s.variant}>
      {m(s.label)}
    </Badge>
  );
}

function ShowMe({ place }: { readonly place: string }): ReactNode {
  const open = batonDesktopBridge()?.openTessaya;
  if (open !== undefined)
    return (
      <Button size="xs" variant="outline" onClick={() => open(`tessaya://${place}`)}>
        <T>Show me in Tessaya</T>
      </Button>
    );
  const [page, bench] = place.split(":");
  if (page === undefined || !WEB_PAGES.has(page))
    return (
      <span className="text-xs text-muted-foreground">
        <T>In Tessaya's window on your computer</T>
      </span>
    );
  return (
    <Button
      size="xs"
      variant="outline"
      render={
        <Link to="/tessaya/$page" params={{ page }} search={bench === undefined ? {} : { bench }} />
      }
    >
      <T>Show me here</T>
    </Button>
  );
}

function Phrase({ text }: { readonly text: string }) {
  const [copied, setCopied] = useState(false);
  const gt = useGT();
  return (
    <li className="flex items-center gap-2 rounded-lg border px-3 py-1.5 text-sm">
      <span className="min-w-0 flex-1">
        <T>
          “<Var>{text}</Var>”
        </T>
      </span>
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label={gt("Copy “{text}”", { text })}
        onClick={() =>
          void navigator.clipboard.writeText(text).then(
            () => setCopied(true),
            () => undefined,
          )
        }
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </li>
  );
}

function FeaturePage({
  feature,
  onBack,
}: {
  readonly feature: DocFeature;
  readonly onBack: () => void;
}) {
  const area = DOC_AREAS.find((a) => a.id === feature.area)?.label;
  const related = DOC_FEATURES.filter((f) => f.area === feature.area && f.id !== feature.id).slice(
    0,
    5,
  );
  return (
    <SettingsSection title={feature.title}>
      <div className="flex flex-col gap-4 p-4" data-testid="help-feature">
        <div className="flex flex-wrap items-center gap-1.5">
          <StatusBadge status={feature.status} />
          {feature.on.map((s) => (
            <Badge key={s} size="sm" variant="outline">
              {DOC_SURFACES.find((x) => x.id === s)?.label}
            </Badge>
          ))}
          <span className="text-xs text-muted-foreground">{area}</span>
        </div>
        <p className="max-w-prose text-sm">{feature.lead}</p>
        {feature.say.length === 0 ? null : (
          <div className="flex flex-col gap-1.5">
            <h3 className="text-xs font-medium text-muted-foreground">
              <T>Try saying</T>
            </h3>
            <ul className="flex max-w-prose flex-col gap-1.5">
              {feature.say.map((s) => (
                <Phrase key={s} text={s} />
              ))}
            </ul>
          </div>
        )}
        {feature.steps.length === 0 ? null : (
          <ol className="flex max-w-prose list-decimal flex-col gap-1 ps-5 text-sm">
            {feature.steps.map((s) => (
              <li key={s}>{s.replace(/\*\*/g, "")}</li>
            ))}
          </ol>
        )}
        {feature.good === null ? null : (
          <p className="max-w-prose text-sm text-muted-foreground">
            <T>
              Good to know: <Var>{feature.good}</Var>
            </T>
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <ShowMe place={feature.place} />
          {feature.guide === null ? null : (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => void readLocalApi()?.shell.openExternal(`${GUIDES}${feature.guide}`)}
            >
              <T>Read the full guide</T>
            </Button>
          )}
          <Button size="xs" variant="ghost" onClick={onBack}>
            <T>‹ All of Help</T>
          </Button>
        </div>
        {related.length === 0 ? null : (
          <p className="text-xs text-muted-foreground">
            <T>
              Related: <Var>{related.map((r) => r.title).join(" · ")}</Var>
            </T>
          </p>
        )}
      </div>
    </SettingsSection>
  );
}

function FeatureRows({
  features,
  onOpen,
}: {
  readonly features: ReadonlyArray<DocFeature>;
  readonly onOpen: (id: string) => void;
}) {
  return features.map((f) => (
    <SettingsRow
      key={f.id}
      title={f.title}
      description={f.lead}
      status={<StatusBadge status={f.status} />}
      control={
        <Button size="xs" variant="outline" onClick={() => onOpen(f.id)}>
          <T>Open</T>
        </Button>
      }
    />
  ));
}

/**
 * Help: Tessaya's features and lessons from docs/user, by what you want to do, where you use her and who you are. A
 * question goes to her as a typed ask, so she answers it the way she answers anything, from the same pages.
 */
export function TessayaHelpPanel({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const search = useLocation({ select: (location) => location.search as Record<string, unknown> });
  const asked = typeof search["ask"] === "string" ? search["ask"] : "";
  const onPage = typeof search["place"] === "string" ? search["place"] : null;
  const [query, setQuery] = useState(asked || (typeof search["q"] === "string" ? search["q"] : ""));
  const [open, setOpen] = useState<string | null>(
    typeof search["f"] === "string" ? search["f"] : null,
  );
  const [surface, setSurface] = useState<DocSurface | null>(null);
  const [audience, setAudience] = useState<DocAudience | null>(null);
  const [answer, setAnswer] = useState<{ q: string; line: string } | null>(null);
  const [used, setUsed] = useState<ReadonlyArray<string>>([]);
  const lead = useLeadAsk(environmentId, (line) =>
    setAnswer((a) => (a === null ? a : { ...a, line })),
  );
  const learnCall = useAtomCommand(tessayaWorkSessions.learnCall, { reportFailure: false });
  const gt = useGT();

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads his lesson progress from his server once
  useEffect(() => {
    let live = true;
    void learnCall({ environmentId, input: { kind: "read", op: "get" } }).then((result) => {
      if (live && result._tag === "Success" && result.value.ok)
        setUsed(readLearnProgress(result.value.value).used);
    });
    return () => {
      live = false;
    };
  }, [environmentId, learnCall]);

  const ask = (q: string) => {
    if (q.trim() === "") return;
    setAnswer({ q: q.trim(), line: gt("Asking Tessaya…") });
    void lead.ask(q.trim());
  };
  // A question handed over from the window's Ctrl+K is asked once, as he typed it there.
  const askedOnce = useRef(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the question the window's palette passed in the address, once
  useEffect(() => {
    if (asked === "" || askedOnce.current) return;
    askedOnce.current = true;
    ask(asked);
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- once per page load
  }, [asked]);

  const feature = open === null ? undefined : DOC_FEATURES.find((f) => f.id === open);
  if (feature !== undefined)
    return (
      <SettingsPageContainer>
        <FeaturePage feature={feature} onBack={() => setOpen(null)} />
      </SettingsPageContainer>
    );

  const hits = query.trim() === "" ? [] : searchDocs(DOC_FEATURES, query).slice(0, 6);
  const here = onPage === null ? [] : DOC_FEATURES.filter((f) => f.place === onPage);
  const filtered = DOC_FEATURES.filter(
    (f) =>
      (surface === null || f.on.includes(surface)) &&
      (audience === null || f.audience === audience),
  );
  return (
    <SettingsPageContainer>
      <SettingsSection title={gt("What do you want to do?")}>
        <div className="flex flex-col gap-3 p-4">
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              ask(query);
            }}
          >
            <Input
              nativeInput
              type="search"
              aria-label={gt("Search Help or ask Tessaya")}
              placeholder={gt("Search or ask")}
              value={query}
              data-testid="help-search"
              onChange={(e) => setQuery(e.target.value)}
            />
            <Button type="submit" variant="outline" disabled={query.trim() === ""}>
              <T>Ask Tessaya</T>
            </Button>
          </form>
          {answer === null ? null : (
            <div
              role="status"
              className="rounded-lg border bg-muted/40 p-3 text-sm"
              data-testid="help-answer"
            >
              <p className="text-xs text-muted-foreground">
                <T>
                  You asked: <Var>{answer.q}</Var>
                </T>
              </p>
              <p className="mt-1">{answer.line}</p>
            </div>
          )}
          {hits.length === 0 ? null : (
            <ul className="flex flex-col">
              {hits.map((f) => (
                <li key={f.id}>
                  <button
                    type="button"
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-start text-sm hover:bg-accent"
                    onClick={() => setOpen(f.id)}
                  >
                    <span className="font-medium">{f.title}</span>
                    <span className="min-w-0 flex-1 truncate text-muted-foreground">{f.task}</span>
                    <StatusBadge status={f.status} />
                  </button>
                </li>
              ))}
            </ul>
          )}
          {query.trim() !== "" && hits.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              <T>Nothing in Help matches. Ask Tessaya and she will say if she can help.</T>
            </p>
          ) : null}
        </div>
      </SettingsSection>

      {here.length === 0 ? null : (
        <SettingsSection title={gt("On this page")}>
          <FeatureRows features={here} onOpen={setOpen} />
        </SettingsSection>
      )}

      <SettingsSection title={gt("Lessons")}>
        {DOC_LESSONS.map((lesson) => {
          const done = lessonDone(lesson, used);
          const count = done.filter(Boolean).length;
          return (
            <SettingsRow
              key={lesson.id}
              title={gt("{title} · {minutes} min", {
                title: lesson.title,
                minutes: lesson.minutes,
              })}
              description={
                <span className="flex flex-col gap-1">
                  <span>{lesson.blurb}</span>
                  <ol className="flex flex-col gap-0.5">
                    {lesson.steps.map((step, n) => (
                      <li key={step.title} className="flex items-baseline gap-1.5">
                        <span aria-hidden className="w-3 shrink-0">
                          {done[n] ? "✓" : `${n + 1}.`}
                        </span>
                        <span>
                          <span className="text-foreground">{step.title}.</span> {step.text}{" "}
                          <T>
                            Say “<Var>{step.say}</Var>”
                          </T>
                          {done[n] ? (
                            <span className="sr-only">
                              <T> (done)</T>
                            </span>
                          ) : null}
                        </span>
                      </li>
                    ))}
                  </ol>
                </span>
              }
              status={
                <span className="text-xs text-muted-foreground">
                  <T>
                    <Var>{count}</Var> of <Var>{lesson.steps.length}</Var> done
                  </T>
                </span>
              }
            />
          );
        })}
      </SettingsSection>

      <SettingsSection title={gt("Where you use her")}>
        <div className="flex flex-col gap-3 p-4">
          <ToggleGroup
            aria-label={gt("Where you use her")}
            value={surface === null ? [] : [surface]}
            onValueChange={(v) => setSurface((v[0] as DocSurface | undefined) ?? null)}
          >
            {DOC_SURFACES.map((s) => (
              <Toggle key={s.id} value={s.id}>
                {s.label}
              </Toggle>
            ))}
          </ToggleGroup>
          <ToggleGroup
            aria-label={gt("Who you are")}
            value={audience === null ? [] : [audience]}
            onValueChange={(v) => setAudience((v[0] as DocAudience | undefined) ?? null)}
          >
            {DOC_AUDIENCES.map((a) => (
              <Toggle key={a.id} value={a.id}>
                {a.label}
              </Toggle>
            ))}
          </ToggleGroup>
        </div>
      </SettingsSection>

      {DOC_AREAS.map((area) => {
        const list = filtered.filter((f) => f.area === area.id);
        return list.length === 0 ? null : (
          <SettingsSection key={area.id} title={area.label}>
            <FeatureRows features={list} onOpen={setOpen} />
          </SettingsSection>
        );
      })}
    </SettingsPageContainer>
  );
}

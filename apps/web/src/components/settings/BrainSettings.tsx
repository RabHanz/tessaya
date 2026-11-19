/**
 * Settings → Brain, in Tessaya's window (BRAIN-DESIGN §13): the one routing table. Each kind of her work picks the
 * login that pays (his subscription or the API key, interchangeable) and the model; the spend guard lists what the
 * key may pay for; hard tasks go to Opus by his escalation setting. Every call reads this when it is made.
 */
import type { EnvironmentId, TessayaRecordEntry } from "@t3tools/tessaya-contracts";
import { DEFAULT_DEEP_DAILY_CAP } from "@t3tools/tessaya-shared/brainEscalation";
import { BRAIN_ROLE_LABELS, brainRoute, keyRoles } from "@t3tools/tessaya-shared/brainRoutes";
import { DEFAULT_ROUTING } from "@t3tools/tessaya-shared/costRouting";
import {
  BrainEffort,
  BrainModel,
  BrainRole,
  type BrainCredential,
  type BrainEscalationRule,
} from "@t3tools/contracts";
import { PULSE_ROWS, pulseLog } from "@t3tools/tessaya-shared/pulseLog";
import { useAtomValue } from "@effect/atom-react";
import { ThumbsDownIcon, ThumbsUpIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { tessayaWorkSessions } from "../../state/tessayaWorkSessions";
import { useAtomCommand } from "../../state/use-atom-command";
import { Link } from "@tanstack/react-router";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";

const KEY: BrainCredential = "apiKey:anthropic";
const PLAN: BrainCredential = "subscription";
const LOGIN_LABELS: Readonly<Record<string, string>> = {
  [PLAN]: "Subscription",
  [KEY]: "API key",
};
const FALLBACK_LABELS: Readonly<Record<string, string>> = {
  none: "No fallback",
  [PLAN]: "Then subscription",
  [KEY]: "Then API key",
};
const ROLE_HINTS: Readonly<Record<BrainRole, string>> = {
  cleanup: "Tidying what you dictate.",
  voice: "Her spoken and typed answers.",
  deep: "Hard tasks she hands to the stronger model.",
  background: "Learning, extracting and episodes, out of sight.",
  consolidation: "Keeping her memory tidy overnight.",
  web: "Searching and reading the web.",
  vision: "Reading your screen.",
  intent: "Reading a sentence the grammar did not catch.",
  synopsis: "Two lines on what a work session did.",
  hold: "A short line while a slow answer comes.",
  gist: "A few words on what each of her conversations is about.",
};
const MODE_LABELS = {
  ask: "Ask me each time",
  auto: "Go on her own",
  never: "Never",
} as const;
const THEN_LABELS = { opus: "Opus", ask: "Ask me", sonnet: "Stay on Sonnet" } as const;

export function BrainSettingsPanel() {
  const { environment } = useSettingsScope();
  return (
    <SettingsPageContainer>
      {environment === null ? (
        <p className="px-4 py-3 text-sm text-muted-foreground">
          Connect an environment to set her brain.
        </p>
      ) : (
        <BrainSections key={environment.environmentId} environmentId={environment.environmentId} />
      )}
    </SettingsPageContainer>
  );
}

export function Choice<T extends string>({
  label,
  value,
  options,
  labels,
  onChange,
}: {
  readonly label: string;
  readonly value: T;
  readonly options: ReadonlyArray<T>;
  readonly labels: Readonly<Record<string, string>>;
  readonly onChange: (value: T) => void;
}) {
  return (
    <Select value={value} onValueChange={(next) => next !== null && onChange(next as T)}>
      <SelectTrigger size="sm" aria-label={label}>
        <SelectValue>{(v: string | null) => labels[v ?? ""] ?? v}</SelectValue>
      </SelectTrigger>
      <SelectPopup align="end" alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem key={option} value={option}>
            {labels[option] ?? option}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

const MODELS = BrainModel.literals;
const MODEL_LABELS: Readonly<Record<string, string>> = {
  haiku: "Haiku",
  sonnet: "Sonnet",
  opus: "Opus",
  "claude-haiku-5-5": "Haiku 5.5",
  "claude-sonnet-5-5": "Sonnet 5.5",
  "claude-opus-5-5": "Opus 5.5",
};
const EFFORTS = ["default", ...BrainEffort.literals] as const;
const EFFORT_LABELS: Readonly<Record<string, string>> = {
  default: "Default effort",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

function BrainSections({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const settings = useEnvironmentSettings(environmentId);
  const update = useUpdateEnvironmentSettings(environmentId);
  const allowed = keyRoles(settings, "anthropic");

  const setLogin = (role: BrainRole, use: BrainCredential) => {
    const others = allowed.filter((r) => r !== role);
    update({
      brainCredentials: { [role]: { use, fallback: "none" } },
      // The key pays only for what its row names: choosing it adds the role to the guard, the subscription takes it back.
      brainKeyRoles: { anthropic: use === KEY ? [...others, role] : others },
    });
  };

  return (
    <>
      <SettingsSection title="Who does what">
        {BrainRole.literals.map((role) => {
          // shortcut: the background row's unset default is routing.json's cheap model, which only the server reads;
          // this shows the shipped default until he sets the row.
          const row = brainRoute(settings, role, DEFAULT_ROUTING.cheap);
          const use = row.use.startsWith("apiKey:") ? KEY : PLAN;
          const refused = use === KEY && !allowed.includes(role);
          return (
            <SettingsRow
              key={role}
              title={BRAIN_ROLE_LABELS[role]}
              description={
                refused
                  ? "Refused: the spend guard below doesn't let the API key pay for this."
                  : ROLE_HINTS[role]
              }
              control={
                <div className="grid w-full grid-cols-2 gap-1.5 sm:w-80">
                  <Choice
                    label={`${BRAIN_ROLE_LABELS[role]}: login`}
                    value={use}
                    options={[PLAN, KEY]}
                    labels={LOGIN_LABELS}
                    onChange={(next) => setLogin(role, next)}
                  />
                  <Choice
                    label={`${BRAIN_ROLE_LABELS[role]}: model`}
                    value={row.model}
                    options={MODELS.includes(row.model as never) ? MODELS : [row.model, ...MODELS]}
                    labels={MODEL_LABELS}
                    onChange={(model) =>
                      update({
                        brainModels: {
                          [role]: {
                            model: model as (typeof MODELS)[number],
                            ...(row.effort === null ? {} : { effort: row.effort }),
                          },
                        },
                      })
                    }
                  />
                  <Choice
                    label={`${BRAIN_ROLE_LABELS[role]}: effort`}
                    value={row.effort ?? "default"}
                    options={EFFORTS}
                    labels={EFFORT_LABELS}
                    onChange={(effort) =>
                      MODELS.includes(row.model as never) &&
                      update({
                        brainModels: {
                          [role]: {
                            model: row.model as (typeof MODELS)[number],
                            ...(effort === "default" ? {} : { effort }),
                          },
                        },
                      })
                    }
                  />
                  <Choice
                    label={`${BRAIN_ROLE_LABELS[role]}: if it fails`}
                    value={row.fallback ?? "none"}
                    options={["none", use === KEY ? PLAN : KEY]}
                    labels={FALLBACK_LABELS}
                    onChange={(fallback) =>
                      update({
                        brainCredentials: {
                          [role]: { use: row.use, fallback: fallback as BrainCredential | "none" },
                        },
                      })
                    }
                  />
                </div>
              }
            />
          );
        })}
      </SettingsSection>

      <SettingsSection title="Spend guard">
        <p className="px-4 text-sm text-muted-foreground">
          What the API key may pay for. Anything else is refused and logged, never sent, and never
          moved to the key without a fallback its row names. Usage shows what each one spent.
        </p>
        {BrainRole.literals.map((role) => (
          <SettingsRow
            key={role}
            title={`API key pays for ${BRAIN_ROLE_LABELS[role].toLowerCase()}`}
            control={
              <Switch
                aria-label={`API key pays for ${BRAIN_ROLE_LABELS[role].toLowerCase()}`}
                checked={allowed.includes(role)}
                onCheckedChange={(on) =>
                  update({
                    brainKeyRoles: {
                      anthropic: on
                        ? [...allowed.filter((r) => r !== role), role]
                        : allowed.filter((r) => r !== role),
                    },
                  })
                }
              />
            }
          />
        ))}
      </SettingsSection>

      <Escalation environmentId={environmentId} />
      <Lines environmentId={environmentId} />
      <Pulse environmentId={environmentId} />
      <SettingsSection title="Prompt lab">
        <SettingsRow
          title="Prompt Lab is in the Lab"
          description="Personas › Lab › Prompts: each persona's live prompt, variants side by side, and making one live with a rollback."
          control={
            <Button
              size="xs"
              variant="outline"
              render={
                <Link to="/tessaya/$page" params={{ page: "lab" }} search={{ bench: "prompts" }} />
              }
            >
              Open Prompts
            </Button>
          }
        />
      </SettingsSection>
      <SettingsSection title="Moved">
        <SettingsRow
          title="Always allowed is in Trust"
          description="Agents › Trust: every standing yes, what it covers, and taking it back."
          control={
            <Button
              size="xs"
              variant="outline"
              render={<Link to="/tessaya/$page" params={{ page: "allowed" }} />}
            >
              Open
            </Button>
          }
        />
        <SettingsRow
          title="Being moved and haptics are on Tessels"
          description="Devices › Tessels: how a Tessel answers being picked up, and how it buzzes."
          control={
            <Button
              size="xs"
              variant="outline"
              render={<Link to="/tessaya/$page" params={{ page: "hardware" }} />}
            >
              Open
            </Button>
          }
        />
      </SettingsSection>
    </>
  );
}

const MOTION_LABELS: Readonly<Record<string, string>> = {
  lively: "Lively",
  calm: "Calm",
  important: "Important only",
};

const LIVELINESS = { still: "Still", calm: "Calm", lively: "Lively" } as const;

/** Her lines on every device: written by her brain or the plain ones, and how much she says unprompted. */
function Lines({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const written = useEnvironmentSettings(environmentId, (s) => s.tessayaExpression);
  const motion = useEnvironmentSettings(environmentId, (s) => s.companionMotion);
  const mood = useEnvironmentSettings(environmentId, (s) => s.tessayaMood.enabled);
  const cleanup = useEnvironmentSettings(environmentId, (s) => s.tessayaRoomCleanup);
  const ownCamera = useEnvironmentSettings(environmentId, (s) => s.tessayaOwnSensorsNoApproval);
  const lively = useEnvironmentSettings(environmentId, (s) => s.tessayaLiveliness);
  const breath = useEnvironmentSettings(environmentId, (s) => s.tessayaVoiceBreath);
  const keepTurns = useEnvironmentSettings(environmentId, (s) => s.tessayaTurnCapture);
  const outsideBody = useEnvironmentSettings(environmentId, (s) => s.tessayaBodyOutsideAgents);
  const physicsClips = useEnvironmentSettings(environmentId, (s) => s.tessayaBodyPhysicsClips);
  const update = useUpdateEnvironmentSettings(environmentId);
  return (
    <SettingsSection title="Her lines">
      <SettingsRow
        title="Her own words"
        description="Acknowledgements, confirmations and notices in her voice, varied and never the same twice. Off says the plain lines."
        control={
          <Switch
            aria-label="Her own words"
            checked={written}
            onCheckedChange={(on) => update({ tessayaExpression: on })}
          />
        }
      />
      <SettingsRow
        title="Fix misheard words"
        description="When words she heard on the Tessel sound like one of your names but are not, she fixes them from what you were talking about before answering. Clear turns never wait for it."
        control={
          <Switch
            aria-label="Fix misheard words"
            checked={cleanup}
            onCheckedChange={(on) => update({ tessayaRoomCleanup: on })}
          />
        }
      />
      <SettingsRow
        title="Her own camera without a card"
        description="When you ask her to look, the Tessel's camera takes its picture without a card to your phone. Her eyes show she is looking. An agent or a job still asks you."
        control={
          <Switch
            aria-label="Her own camera without a card"
            checked={ownCamera}
            onCheckedChange={(on) => update({ tessayaOwnSensorsNoApproval: on })}
          />
        }
      />
      <SettingsRow
        title="Body-only agents move her body"
        description="Agents you approved for her body only may move her own body, not only the body playground. It still waits while a conversation you are in has her."
        control={
          <Switch
            aria-label="Body-only agents move her body"
            checked={outsideBody}
            onCheckedChange={(on) => update({ tessayaBodyOutsideAgents: on })}
          />
        }
      />
      <SettingsRow
        title="Physics-trained moves"
        description="Moves from her library play the version trained in a physics simulation, so her arms never pass through her. Moves without one play as before."
        control={
          <Switch
            aria-label="Physics-trained moves"
            checked={physicsClips}
            onCheckedChange={(on) => update({ tessayaBodyPhysicsClips: on })}
          />
        }
      />
      <SettingsRow
        title="Her own life"
        description="What she does when you're not talking to her: rest, wander, sulk, play, come looking for you. Still never moves on her own; lively does more. She never makes a sound or gets in front of your work."
        control={
          <Select
            value={lively}
            onValueChange={(value) => {
              if (value !== null) update({ tessayaLiveliness: value as typeof lively });
            }}
          >
            <SelectTrigger aria-label="Her own life" size="sm">
              <SelectValue>{LIVELINESS[lively]}</SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {(Object.keys(LIVELINESS) as Array<typeof lively>).map((k) => (
                <SelectItem key={k} value={k}>
                  {LIVELINESS[k]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Breath between sentences"
        description="A soft breath before a long sentence of her reply on the Tessel. Off, she pauses instead."
        control={
          <Switch
            aria-label="Breath between sentences"
            checked={breath}
            onCheckedChange={(on) => update({ tessayaVoiceBreath: on })}
          />
        }
      />
      <SettingsRow
        title="Keep my voice for training"
        description="Your own turns on the Tessel, only ones Voice ID knows are you, are kept privately to train your voice ID and recogniser. Nobody else's voice is kept."
        control={
          <Switch
            aria-label="Keep my voice for training"
            checked={keepTurns}
            onCheckedChange={(on) => update({ tessayaTurnCapture: on })}
          />
        }
      />
      <SettingsRow
        title="Her mood"
        description="A working state that shapes her tone and her face on every device, moved only by your own turns. It never changes what she does. Off keeps her face neutral and clears her mood."
        control={
          <Switch
            aria-label="Her mood"
            checked={mood}
            onCheckedChange={(on) => update({ tessayaMood: { enabled: on } })}
          />
        }
      />
      <SettingsRow
        title="Chatter"
        description="What she says and does unprompted. Answers to you and safety alerts always play."
        control={
          <Choice
            label="Chatter"
            value={motion}
            options={["lively", "calm", "important"] as const}
            labels={MOTION_LABELS}
            onChange={(next) => update({ companionMotion: next })}
          />
        }
      />
    </SettingsSection>
  );
}

/** Her pulse: what she may raise unprompted, what she was told to stop raising, and what she noticed and why. */
function Pulse({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const pulse = useEnvironmentSettings(environmentId, (s) => s.tessayaPulse);
  const update = useUpdateEnvironmentSettings(environmentId);
  const read = useAtomCommand(tessayaWorkSessions.recordList, { reportFailure: false });
  const react = useAtomCommand(tessayaWorkSessions.pulseReact);
  const mayReact = useAtomValue(tessayaWorkSessions.pulseReact.permissionAtom(environmentId));
  const [log, setLog] = useState<ReadonlyArray<TessayaRecordEntry>>([]);
  const load = () =>
    read({ environmentId, input: { kind: "pulse", limit: 60 } }).then((r) => {
      if (r._tag === "Success") setLog(r.value.entries);
    });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- loads the server's decision log once per environment
  useEffect(() => {
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- one read per environment; load is remade each render
    void load();
  }, [environmentId]);
  const rows = pulseLog(log).slice(0, 12);
  // His reaction is a Record row the pulse learns from; reading the log back shows it on its row.
  const reactTo = (row: number, reaction: "liked" | "told_off" | "stop") =>
    void react({ environmentId, input: { row, reaction } }).then(load);
  return (
    <SettingsSection title="Pulse">
      <SettingsRow
        title="Notice on her own"
        description="She reviews what happened since last time and decides whether to say anything. Usually she stays quiet. How often she speaks is Chatter above."
        control={
          <Switch
            aria-label="Notice on her own"
            checked={pulse.enabled}
            onCheckedChange={(on) => update({ tessayaPulse: { enabled: on } })}
          />
        }
      />
      {PULSE_ROWS.map((row) => (
        <SettingsRow
          key={row.key}
          title={row.title}
          description={row.description}
          control={
            <Switch
              aria-label={`Notice ${row.title.toLowerCase()}`}
              checked={pulse.categories[row.key]}
              disabled={!pulse.enabled}
              onCheckedChange={(on) => update({ tessayaPulse: { categories: { [row.key]: on } } })}
            />
          }
        />
      ))}
      {pulse.muted.map((words) => (
        <SettingsRow
          key={words}
          title={`Stopped: ${words}`}
          description="You told her to stop raising this."
          control={
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                update({ tessayaPulse: { muted: pulse.muted.filter((m) => m !== words) } })
              }
            >
              Allow again
            </Button>
          }
        />
      ))}
      {rows.length === 0 ? (
        <SettingsRow
          title="What she noticed"
          description="Nothing yet. Each review she makes, and why she spoke or stayed quiet, shows here."
        />
      ) : (
        rows.map((r) => (
          <SettingsRow
            key={r.id}
            title={r.event}
            description={`${new Date(r.at).toLocaleString([], { weekday: "short", hour: "2-digit", minute: "2-digit" })} · ${r.decision}${r.reason === "" ? "" : ` · ${r.reason}`}`}
            control={
              mayReact ? (
                <div className="flex gap-1">
                  <Button
                    size="icon-sm"
                    variant={r.reaction === "liked" ? "secondary" : "ghost"}
                    aria-label="Helpful"
                    aria-pressed={r.reaction === "liked"}
                    onClick={() => reactTo(r.id, "liked")}
                  >
                    <ThumbsUpIcon />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant={r.reaction === "told_off" ? "secondary" : "ghost"}
                    aria-label="Not helpful"
                    aria-pressed={r.reaction === "told_off"}
                    onClick={() => reactTo(r.id, "told_off")}
                  >
                    <ThumbsDownIcon />
                  </Button>
                  {r.category === null ? null : (
                    <Button
                      size="sm"
                      variant={r.reaction === "stopped" ? "secondary" : "ghost"}
                      disabled={!pulse.categories[r.category]}
                      onClick={() => reactTo(r.id, "stop")}
                    >
                      {pulse.categories[r.category] ? "Stop this" : "Stopped"}
                    </Button>
                  )}
                </div>
              ) : null
            }
          />
        ))
      )}
    </SettingsSection>
  );
}

/** When a hard task goes to Opus (BRAIN-DESIGN §18): ask, go within a daily cap, or never; and his standing rules. */
function Escalation({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const escalation = useEnvironmentSettings(environmentId, (s) => s.brainEscalation);
  const update = useUpdateEnvironmentSettings(environmentId);
  const rules = escalation.rules ?? [];
  const [when, setWhen] = useState("");
  const [then, setThen] = useState<BrainEscalationRule["then"]>("opus");
  const setRules = (next: ReadonlyArray<BrainEscalationRule>) =>
    update({ brainEscalation: { rules: [...next] } });
  return (
    <SettingsSection title="Hard tasks">
      <SettingsRow
        title="Moving to Opus"
        description="When she thinks a task needs the stronger model. Your yes always goes."
        control={
          <Choice
            label="Moving to Opus"
            value={escalation.mode ?? "ask"}
            options={["ask", "auto", "never"] as const}
            labels={MODE_LABELS}
            onChange={(mode) => update({ brainEscalation: { mode } })}
          />
        }
      />
      <SettingsRow
        title="Without asking, at most"
        description="Opus turns a day she may start on her own, in your time zone."
        control={
          <Input
            key={String(escalation.autoDeepDailyCap ?? DEFAULT_DEEP_DAILY_CAP)}
            type="number"
            min={0}
            max={500}
            className="w-20"
            aria-label="Opus turns a day without asking"
            defaultValue={escalation.autoDeepDailyCap ?? DEFAULT_DEEP_DAILY_CAP}
            onBlur={(event) => {
              const cap = Math.round(Number(event.target.value));
              if (Number.isFinite(cap) && cap >= 0 && cap <= 500)
                update({ brainEscalation: { autoDeepDailyCap: cap } });
            }}
          />
        }
      />
      {rules.map((rule, i) => (
        <SettingsRow
          key={rule.when}
          title={`${i + 1}. ${rule.when}`}
          description={THEN_LABELS[rule.then]}
          control={
            <Button
              size="xs"
              variant="ghost-destructive"
              onClick={() => setRules(rules.filter((_, at) => at !== i))}
            >
              Remove
            </Button>
          }
        />
      ))}
      <SettingsRow
        title="Add a rule"
        description='In your words, such as "coding questions". You can also say it to her.'
        control={
          <form
            className="flex flex-wrap justify-end gap-1.5"
            onSubmit={(event) => {
              event.preventDefault();
              const text = when.trim().slice(0, 200);
              if (text === "" || rules.length >= 30 || rules.some((r) => r.when === text)) return;
              setRules([...rules, { when: text, then }]);
              setWhen("");
            }}
          >
            <Input
              className="w-44"
              aria-label="When"
              placeholder="coding questions"
              value={when}
              onChange={(event) => setWhen(event.target.value)}
            />
            <Choice
              label="Then"
              value={then}
              options={["opus", "ask", "sonnet"] as const}
              labels={THEN_LABELS}
              onChange={setThen}
            />
            <Button size="sm" type="submit" variant="outline" disabled={when.trim() === ""}>
              Add
            </Button>
          </form>
        }
      />
    </SettingsSection>
  );
}

/**
 * Settings → Brain, in Tessaya's window (BRAIN-DESIGN §13): the one routing table. Each kind of her work picks the
 * login that pays (his subscription or the API key, interchangeable) and the model; the spend guard lists what the
 * key may pay for; hard tasks go to Opus by his escalation setting. Every call reads this when it is made.
 */
import type { EnvironmentId } from "@t3tools/baton-contracts";
import { DEFAULT_DEEP_DAILY_CAP } from "@t3tools/baton-shared/brainEscalation";
import { BRAIN_ROLE_LABELS, brainRoute, keyRoles } from "@t3tools/baton-shared/brainRoutes";
import { DEFAULT_ROUTING } from "@t3tools/baton-shared/costRouting";
import {
  BrainEffort,
  BrainModel,
  BrainRole,
  type BrainCredential,
  type BrainEscalationRule,
} from "@t3tools/contracts";
import { useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { PromptLab } from "./PromptLabSettings";
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

function Choice<T extends string>({
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
      <PromptLab environmentId={environmentId} />
    </>
  );
}

const MOTION_LABELS: Readonly<Record<string, string>> = {
  lively: "Lively",
  calm: "Calm",
  important: "Important only",
};

/** Her lines on every device: written by her brain or the plain ones, and how much she says unprompted. */
function Lines({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const written = useEnvironmentSettings(environmentId, (s) => s.tessayaExpression);
  const motion = useEnvironmentSettings(environmentId, (s) => s.companionMotion);
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

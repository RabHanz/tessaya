// @effect-diagnostics globalDate:off
/**
 * The Intercom page (COMMS-DESIGN §5, Devices area): messages on or off, quiet hours, your do-not-disturb, the
 * emergencies the owner defines (and one sounding now), and who may drop in on you. The server owns every rule; this
 * only asks `/tessaya/comms` and draws.
 */
import type {
  CommsCallResult,
  CommsConsent,
  CommsEmergency,
  CommsEmergencyKind,
  CommsSettings,
  TessayaHouseholdMember,
} from "@t3tools/tessaya-contracts";

import type { HomeControl } from "./tessayaHome.ts";
import { text } from "./strings.ts";

/** One request to `/tessaya/comms`; rejects with the server's reason in plain words. */
export type CommsCall = (op: string, args?: Record<string, unknown>) => Promise<CommsCallResult>;

/** Quiet hours he picks from, as "from-to" in his own time zone; "" is none. */
const QUIET = ["", "21:00-07:00", "22:00-07:00", "22:00-08:00", "23:00-07:00", "23:00-08:00"];
const DND = ["", "1h", "3h", "morning"] as const;
const WHO = ["any", "adults", "owner"] as const;
const CONSENTS = ["knock", "allow", "never"] as const;

/** A do-not-disturb choice as its end time: in an hour or three, or 07:00 tomorrow. */
export const dndUntil = (choice: string, now: Date): string | null => {
  if (choice === "1h" || choice === "3h")
    return new Date(now.getTime() + (choice === "1h" ? 1 : 3) * 3_600_000).toISOString();
  if (choice !== "morning") return null;
  const at = new Date(now);
  at.setHours(7, 0, 0, 0);
  if (at <= now) at.setDate(at.getDate() + 1);
  return at.toISOString();
};

/** "Fire: get out now" as a kind; null when it names nothing. */
export const kindOf = (line: string, who: (typeof WHO)[number]): CommsEmergencyKind | null => {
  const at = line.indexOf(":");
  if (at < 0) return null;
  const label = line.slice(0, at).trim().slice(0, 60);
  const said = line
    .slice(at + 1)
    .trim()
    .slice(0, 300);
  const id = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
  if (id === "" || said === "") return null;
  return { id, label, text: said, who, children: true, automations: false };
};

const kindLine = (k: CommsEmergencyKind) => `${k.label}: ${k.text} (${text(`ic.who.${k.who}`)})`;

export const intercomControls = (s: {
  readonly settings: CommsSettings | null;
  readonly owner: boolean;
  readonly kinds: ReadonlyArray<CommsEmergencyKind>;
  readonly alarm: CommsEmergency | null;
  readonly people: ReadonlyArray<Pick<TessayaHouseholdMember, "id" | "name">>;
  readonly consents: ReadonlyArray<CommsConsent>;
  readonly me: string | null;
  readonly who: (typeof WHO)[number];
  readonly status: string | null;
}): ReadonlyArray<HomeControl> => {
  const section = text("ic.section");
  const rows: Array<HomeControl> = [];
  const set = s.settings;
  if (s.alarm !== null)
    rows.push({
      id: "ic.alarm",
      section,
      label: `🚨 ${s.alarm.label}`,
      hint: text("ic.alarm.hint", { by: s.alarm.by, n: s.alarm.pending.length }),
      kind: "action",
      button: text("ic.alarm.ok"),
      secondary: text("ic.alarm.false"),
      lead: true,
    });
  if (set === null) {
    rows.push({
      id: "ic.loading",
      section,
      label: text("ic.loading"),
      kind: "check",
      status: "ok",
      detail: "",
    });
    return rows;
  }
  rows.push(
    s.owner
      ? {
          id: "ic.enabled",
          section,
          label: text("ic.enabled"),
          hint: text("ic.enabled.hint"),
          kind: "toggle",
          on: set.enabled,
        }
      : {
          id: "ic.enabled",
          section,
          label: text("ic.enabled"),
          kind: "check",
          status: set.enabled ? "ok" : "warn",
          detail: text(set.enabled ? "ic.on" : "ic.off"),
        },
  );
  const quiet = set.quietHours === null ? "" : `${set.quietHours.from}-${set.quietHours.to}`;
  if (s.owner)
    rows.push({
      id: "ic.quiet",
      section,
      label: text("ic.quiet"),
      hint: text("ic.quiet.hint"),
      kind: "choice",
      value: QUIET.includes(quiet) ? quiet : "",
      options: [...new Set([...QUIET, quiet])].map((q) => ({
        value: q,
        label: q === "" ? text("ic.quiet.none") : q.replace("-", " to "),
      })),
    });
  rows.push({
    id: "ic.dnd",
    section,
    label: text("ic.dnd"),
    hint:
      set.dndUntil === null
        ? text("ic.dnd.hint")
        : text("ic.dnd.until", {
            at: new Date(set.dndUntil).toLocaleString(undefined, {
              dateStyle: "medium",
              timeStyle: "short",
            }),
          }),
    kind: "choice",
    value: "",
    options: DND.map((d) => ({ value: d, label: text(`ic.dnd.${d === "" ? "off" : d}`) })),
  });
  // Who may drop in on you: knock first unless you say otherwise (Decision 1); each can be set back.
  const mine = s.me === null ? null : `person:${s.me.toLowerCase()}`;
  for (const p of s.people) {
    const set = s.consents.find((c) => c.target === mine && c.caller === p.id)?.state ?? "knock";
    rows.push({
      id: `ic.consent:${p.id}`,
      section,
      label: text("ic.consent", { name: p.name }),
      hint: text("ic.consent.hint"),
      kind: "choice",
      value: set,
      options: CONSENTS.map((c) => ({ value: c, label: text(`ic.consent.${c}`) })),
    });
  }
  rows.push({
    id: "ic.kinds",
    section,
    label: text("ic.kinds"),
    hint: text(s.owner ? "ic.kinds.hint" : "ic.kinds.view"),
    kind: "list",
    items: s.kinds.map(kindLine),
    placeholder: text("ic.kinds.placeholder"),
    addLabel: text("ic.kinds.add"),
    ...(s.owner ? {} : { required: true }),
  });
  if (s.owner)
    rows.push({
      id: "ic.who",
      section,
      label: text("ic.who"),
      kind: "choice",
      value: s.who,
      options: WHO.map((w) => ({ value: w, label: text(`ic.who.${w}`) })),
    });
  if (s.status !== null)
    rows.push({
      id: "ic.status",
      section,
      label: s.status,
      kind: "check",
      status: "ok",
      detail: "",
    });
  return rows;
};

export const createIntercomTab = (input: {
  readonly call: CommsCall;
  /** The household list, for who lives here and which member this computer is. */
  readonly members: () => Promise<ReadonlyArray<TessayaHouseholdMember>>;
  readonly refresh: () => void;
  readonly now?: () => Date;
}) => {
  let settings: CommsSettings | null = null;
  let kinds: ReadonlyArray<CommsEmergencyKind> = [];
  let alarm: CommsEmergency | null = null;
  let consents: ReadonlyArray<CommsConsent> = [];
  let people: ReadonlyArray<TessayaHouseholdMember> = [];
  let who: (typeof WHO)[number] = "any";
  let status: string | null = null;
  const me = () => people.find((m) => m.you) ?? null;

  const load = async () => {
    try {
      const [s, k, c, m] = await Promise.all([
        input.call("settings"),
        input.call("emergencyKinds"),
        input.call("consents"),
        input.members(),
      ]);
      settings = s.settings ?? null;
      alarm = s.emergency ?? null;
      kinds = k.emergencyKinds ?? [];
      consents = c.consents ?? [];
      people = m;
    } catch (e) {
      status = e instanceof Error ? e.message : text("ic.failed");
    }
    input.refresh();
  };
  let busy: Promise<void> = Promise.resolve();
  const run = (op: string, args: Record<string, unknown> = {}) => {
    busy = busy.then(async () => {
      try {
        const r = await input.call(op, args);
        status = r.line === "" ? null : r.line;
      } catch (e) {
        status = e instanceof Error ? e.message : text("ic.failed");
      }
      await load();
    });
  };

  return {
    load,
    settled: () => busy,
    controls: (): ReadonlyArray<HomeControl> =>
      intercomControls({
        settings,
        owner: me()?.role === "owner" || me()?.role === "admin",
        kinds,
        alarm,
        people: people.filter((m) => !m.you && m.state === "active" && m.role !== "guest"),
        consents,
        me: me()?.id ?? null,
        who,
        status,
      }),
    /** Handles a click on one of its controls; false when the id is not its own. */
    act: (id: string, value: unknown): boolean => {
      if (!id.startsWith("ic.")) return false;
      const [kind, rest = ""] = id.slice(3).split(":");
      if (kind === "enabled") run("settings", { enabled: value === true });
      else if (kind === "quiet" && typeof value === "string") {
        const [from, to] = value.split("-");
        run("settings", {
          quietHours:
            from === undefined || to === undefined || value === ""
              ? null
              : { from, to, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone },
        });
      } else if (kind === "dnd" && typeof value === "string")
        run("dnd", { until: dndUntil(value, input.now?.() ?? new Date()) });
      else if (kind === "alarm") run(rest === "later" ? "emergencyCancel" : "emergencyAck");
      else if (kind === "who" && WHO.includes(value as (typeof WHO)[number]))
        who = value as (typeof WHO)[number];
      else if (kind === "kinds" && rest === "add" && typeof value === "string") {
        const k = kindOf(value, who);
        if (k === null) status = text("ic.kinds.bad");
        else run("emergencyKinds", { kinds: [...kinds.filter((x) => x.id !== k.id), k] });
      } else if (kind === "kinds" && rest === "rm" && typeof value === "string")
        run("emergencyKinds", { kinds: kinds.filter((k) => kindLine(k) !== value) });
      else if (kind === "consent" && rest !== "" && typeof value === "string" && me() !== null)
        run("consentSet", { target: `person:${me()!.id}`, caller: rest, state: value });
      else return true;
      input.refresh();
      return true;
    },
  };
};

export type IntercomTab = ReturnType<typeof createIntercomTab>;

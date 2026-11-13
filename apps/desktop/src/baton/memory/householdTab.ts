// @effect-diagnostics globalDate:off
/**
 * The Household area (ACCOUNTS-IDENTITY-DESIGN I-1): who lives here, each one's role and devices, adding someone with a
 * code for their phone, removing them (their data waits 7 days for their export) or bringing them back, and enrolling
 * each person's voice with the guided card. The server owns every rule; this only asks and draws.
 */
import type { BatonHouseholdCallResult, BatonHouseholdMember } from "@t3tools/baton-contracts";

import type { HomeControl } from "../home/batonHome.ts";
import { text } from "../home/strings.ts";

/** One request to `/tessaya/household`; rejects with the server's reason in plain words. */
export type HouseholdCall = (
  op: string,
  args?: Record<string, unknown>,
) => Promise<BatonHouseholdCallResult>;

const ROLES = ["admin", "adult", "child", "guest"] as const;
type InviteRole = (typeof ROLES)[number];

const time = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

const noteOf = (m: BatonHouseholdMember): string =>
  [
    m.you ? text("hh.you") : null,
    m.state === "invited"
      ? text("hh.invited")
      : m.state === "leaving" && m.purgeAfter !== null
        ? text("hh.leaving", { at: time(m.purgeAfter) })
        : m.devices === 1
          ? text("hh.devices.one")
          : text("hh.devices", { n: m.devices }),
    m.machine ? text("hh.machine") : null,
    m.role === "child" && m.adultAge !== null ? text("hh.adultAt", { n: m.adultAge }) : null,
  ]
    .filter((x): x is string => x !== null)
    .join(" · ");

/** Choices with a fixed set of answers; the rest are said in their own words. */
const PREF_CHOICES: Readonly<Record<string, ReadonlyArray<readonly [string, string]>>> = {
  units: [
    ["metric", "hh.prefs.units.metric"],
    ["imperial", "hh.prefs.units.imperial"],
  ],
  timeFormat: [
    ["12-hour with AM/PM", "hh.prefs.timeFormat.12"],
    ["24-hour", "hh.prefs.timeFormat.24"],
  ],
};
const PREF_KEYS = ["name", "persona", "voice", "units", "timeFormat", "news", "music"] as const;

/**
 * One person's preferences (HOUSEHOLD-DESIGN §4): yours, and, for the owner, anyone's picked above them. A worded one
 * is a one-line list (its text, Remove, and a line to set it); units and times are choices.
 */
const preferenceControls = (
  s: {
    readonly members: ReadonlyArray<BatonHouseholdMember>;
    readonly prefsFor: string | null;
    readonly prefs: Readonly<Record<string, string>>;
  },
  section: string,
): ReadonlyArray<HomeControl> => {
  const you = s.members.find((m) => m.you);
  const whose = s.members.find((m) => m.id === s.prefsFor);
  if (you === undefined || whose === undefined) return [];
  const others =
    you.role === "owner" ? s.members.filter((m) => m.state !== "leaving" && m.id !== you.id) : [];
  const rows: Array<HomeControl> = [];
  if (others.length > 0)
    rows.push({
      id: "m.hh.prefsFor",
      section,
      label: text("hh.prefs.for"),
      hint: text("hh.prefs.for.hint"),
      kind: "choice",
      value: whose.id,
      options: [you, ...others].map((m) => ({
        value: m.id,
        label: m.you ? text("hh.you") : m.name,
      })),
    });
  // Their own name is theirs to change; someone else's is the owner's (the server asks for a yes where it must).
  if (whose.you || you.role === "owner")
    rows.push({
      id: "m.hh.rename",
      section,
      label: text("hh.prefs.member"),
      hint: text("hh.prefs.member.hint"),
      kind: "list",
      items: [whose.name],
      required: true,
      placeholder: text("hh.prefs.name.placeholder"),
      addLabel: text("hh.prefs.rename"),
    });
  for (const key of PREF_KEYS) {
    const now = s.prefs[key];
    const choices = PREF_CHOICES[key];
    rows.push(
      choices !== undefined
        ? {
            id: `m.hh.pref:${key}`,
            section,
            label: text(`hh.prefs.${key}`),
            kind: "choice",
            value: now ?? "",
            options: [
              { value: "", label: text("hh.prefs.unset") },
              ...choices.map(([value, label]) => ({ value, label: text(label) })),
            ],
          }
        : {
            id: `m.hh.pref:${key}`,
            section,
            label: text(`hh.prefs.${key}`),
            ...(key === "name" ? { hint: text("hh.prefs.name.hint") } : {}),
            kind: "list",
            items: now === undefined ? [] : [now],
            placeholder: text(
              key === "name" ? "hh.prefs.name.placeholder" : "hh.prefs.text.placeholder",
            ),
            addLabel: text("hh.prefs.set"),
          },
    );
  }
  return rows;
};

export const householdControls = (s: {
  readonly members: ReadonlyArray<BatonHouseholdMember>;
  readonly inviteRole: InviteRole;
  readonly code: { readonly name: string; readonly code: string; readonly until: string } | null;
  readonly status: string | null;
  readonly canEnrol: boolean;
  readonly homeOn: string | null;
  readonly peers: ReadonlyArray<string>;
  /** Whose preferences are shown (a member id), and theirs. */
  readonly prefsFor: string | null;
  readonly prefs: Readonly<Record<string, string>>;
}): ReadonlyArray<HomeControl> => {
  const section = text("hh.section");
  const rows: Array<HomeControl> = [];
  for (const m of s.members) {
    if (m.role === "owner") {
      rows.push({
        id: `m.hh.owner:${m.id}`,
        section,
        label: m.name,
        hint: text("hh.role.owner"),
        kind: "check",
        status: "ok",
        detail: noteOf(m),
      });
      continue;
    }
    rows.push({
      id: `m.hh.role:${m.id}`,
      section,
      label: m.name,
      hint: noteOf(m),
      kind: "choice",
      value: m.role,
      options: ROLES.map((r) => ({ value: r, label: text(`hh.role.${r}`) })),
      ...(m.state === "leaving" ? { disabled: true } : {}),
    });
    if (m.state !== "leaving" && (m.role === "admin" || m.role === "adult"))
      rows.push({
        id: `m.hh.machine:${m.id}`,
        section,
        label: text("hh.machine.label", { name: m.name }),
        hint: text("hh.machine.warning", { name: m.name }),
        kind: "toggle",
        on: m.machine,
      });
    rows.push(
      m.state === "leaving"
        ? {
            id: `m.hh.leaving:${m.id}`,
            section,
            label: m.name,
            kind: "action",
            button: text("hh.restore"),
            secondary: text("hh.removeNow"),
            value: m.id,
          }
        : {
            id: `m.hh.member:${m.id}`,
            section,
            label: m.name,
            kind: "action",
            button: text("hh.remove"),
            secondary: s.canEnrol ? text("hh.enrol") : text("hh.newCode"),
            value: m.id,
          },
    );
  }
  rows.push(...preferenceControls(s, section));
  // Only where there is another server to keep them on.
  if (s.peers.length > 0 || s.homeOn !== null)
    rows.push({
      id: "m.hh.homeOn",
      section,
      label: text("hh.homeOn"),
      hint: text("hh.homeOn.hint"),
      kind: "choice",
      value: s.homeOn ?? "",
      options: [
        { value: "", label: text("hh.homeOn.here") },
        ...[...new Set([...s.peers, ...(s.homeOn === null ? [] : [s.homeOn])])].map((p) => ({
          value: p,
          label: p,
        })),
      ],
    });
  rows.push(
    {
      id: "m.hh.inviteRole",
      section,
      label: text("hh.add.role"),
      kind: "choice",
      value: s.inviteRole,
      options: ROLES.map((r) => ({ value: r, label: text(`hh.role.${r}`) })),
    },
    {
      id: "m.hh.invite",
      section,
      label: text("hh.add"),
      hint: text("hh.hint"),
      kind: "list",
      items: [],
      placeholder: text("hh.add.name"),
      addLabel: text("hh.add.button"),
    },
  );
  if (s.code !== null)
    rows.push({
      id: "m.hh.code",
      section,
      label: text("hh.code", { name: s.code.name, code: s.code.code }),
      kind: "check",
      status: "ok",
      detail: text("hh.code.until", { at: time(s.code.until) }),
    });
  if (s.status !== null)
    rows.push({
      id: "m.hh.status",
      section,
      label: s.status,
      kind: "check",
      status: "ok",
      detail: "",
    });
  return rows;
};

export const createHouseholdTab = (input: {
  readonly call: HouseholdCall;
  /** Opens the guided Voice ID card for this member, saving their profile under their member id. */
  readonly enrol: ((member: { readonly id: string; readonly name: string }) => void) | null;
  readonly refresh: () => void;
}) => {
  let members: ReadonlyArray<BatonHouseholdMember> = [];
  let homeOn: string | null = null;
  let peers: ReadonlyArray<string> = [];
  let inviteRole: InviteRole = "adult";
  let code: { name: string; code: string; until: string } | null = null;
  let status: string | null = null;
  let confirmNow: string | null = null;
  let prefsFor: string | null = null;
  let prefs: Readonly<Record<string, string>> = {};

  const load = async () => {
    try {
      const listed = await input.call("list");
      members = listed.members ?? [];
      homeOn = listed.homeOn ?? null;
      peers = listed.peers ?? [];
      if (!members.some((m) => m.id === prefsFor && m.state !== "leaving"))
        prefsFor = members.find((m) => m.you)?.id ?? null;
      prefs =
        prefsFor === null
          ? {}
          : ((await input.call("preferences", { id: prefsFor })).preferences ?? {});
    } catch (e) {
      status = e instanceof Error ? e.message : text("hh.failed");
    }
    input.refresh();
  };
  let busy: Promise<void> = Promise.resolve();
  const run = (op: string, args: Record<string, unknown>, name?: string) => {
    busy = busy.then(() => request(op, args, name));
  };
  const request = async (op: string, args: Record<string, unknown>, name?: string) => {
    try {
      const r = await input.call(op, args);
      status = r.line;
      if (r.code !== undefined && r.codeExpiresAt !== undefined)
        code = { name: name ?? "", code: r.code, until: r.codeExpiresAt };
    } catch (e) {
      status = e instanceof Error ? e.message : text("hh.failed");
    }
    await load();
  };
  const memberOf = (id: string) => members.find((m) => m.id === id);

  return {
    load,
    /** Resolves once every request it was asked for has answered. */
    settled: () => busy,
    controls: (): ReadonlyArray<HomeControl> =>
      householdControls({
        members,
        inviteRole,
        code,
        status,
        canEnrol: input.enrol !== null,
        homeOn,
        peers,
        prefsFor,
        prefs,
      }),
    /** Handles a click on one of its controls; false when the id is not its own. */
    act: (id: string, value: unknown): boolean => {
      if (!id.startsWith("m.hh.")) return false;
      const body = id.slice("m.hh.".length);
      const at = body.indexOf(":");
      const kind = at < 0 ? body : body.slice(0, at);
      const rest = at < 0 ? "" : body.slice(at + 1);
      const target = memberOf(rest.replace(/:later$/, ""));
      if (kind === "prefsFor" && typeof value === "string") {
        prefsFor = value;
        void load();
      } else if (
        kind === "rename" &&
        prefsFor !== null &&
        typeof value === "string" &&
        value.trim() !== ""
      ) {
        run("rename", { id: prefsFor, name: value.trim().slice(0, 120) });
      } else if (kind === "pref" && prefsFor !== null) {
        // A list's ids end in :add (the text) or :rm (its one item); a choice sends its value, "" for not set.
        const [key, edit] = rest.split(":");
        const set =
          edit === "rm"
            ? null
            : typeof value === "string" && value.trim() !== ""
              ? value.trim()
              : null;
        run("setPreference", { id: prefsFor, key, value: set });
      } else if (kind === "homeOn" && typeof value === "string")
        run("setHome", { on: value === "" ? null : value });
      else if (kind === "inviteRole" && ROLES.includes(value as InviteRole))
        inviteRole = value as InviteRole;
      else if (
        kind === "invite" &&
        rest === "add" &&
        typeof value === "string" &&
        value.trim() !== ""
      )
        run("invite", { name: value.trim().slice(0, 120), role: inviteRole }, value.trim());
      else if (kind === "machine" && target !== undefined)
        run("machine", { id: target.id, on: value === true }, target.name);
      else if (kind === "role" && target !== undefined && ROLES.includes(value as InviteRole))
        run("setRole", { id: target.id, role: value });
      else if (kind === "member" && target !== undefined) {
        if (!rest.endsWith(":later")) run("remove", { id: target.id });
        else if (input.enrol !== null) input.enrol({ id: target.id, name: target.name });
        else run("pair", { id: target.id }, target.name);
      } else if (kind === "leaving" && target !== undefined) {
        if (!rest.endsWith(":later")) run("restore", { id: target.id });
        // Destroying their data can't be undone: the first click only asks for a second.
        else if (confirmNow === target.id) {
          confirmNow = null;
          run("remove", { id: target.id, now: true });
        } else {
          confirmNow = target.id;
          status = text("hh.removeNow.confirm", { name: target.name });
        }
      } else return true;
      input.refresh();
      return true;
    },
  };
};

export type HouseholdTab = ReturnType<typeof createHouseholdTab>;

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

export const householdControls = (s: {
  readonly members: ReadonlyArray<BatonHouseholdMember>;
  readonly inviteRole: InviteRole;
  readonly code: { readonly name: string; readonly code: string; readonly until: string } | null;
  readonly status: string | null;
  readonly canEnrol: boolean;
  readonly homeOn: string | null;
  readonly peers: ReadonlyArray<string>;
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

  const load = async () => {
    try {
      const listed = await input.call("list");
      members = listed.members ?? [];
      homeOn = listed.homeOn ?? null;
      peers = listed.peers ?? [];
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
      }),
    /** Handles a click on one of its controls; false when the id is not its own. */
    act: (id: string, value: unknown): boolean => {
      if (!id.startsWith("m.hh.")) return false;
      const body = id.slice("m.hh.".length);
      const at = body.indexOf(":");
      const kind = at < 0 ? body : body.slice(0, at);
      const rest = at < 0 ? "" : body.slice(at + 1);
      const target = memberOf(rest.replace(/:later$/, ""));
      if (kind === "homeOn" && typeof value === "string")
        run("setHome", { on: value === "" ? null : value });
      else if (kind === "inviteRole" && ROLES.includes(value as InviteRole))
        inviteRole = value as InviteRole;
      else if (
        kind === "invite" &&
        rest === "add" &&
        typeof value === "string" &&
        value.trim() !== ""
      )
        run("invite", { name: value.trim().slice(0, 60), role: inviteRole }, value.trim());
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

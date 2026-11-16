// @effect-diagnostics globalDate:off
/**
 * People (HOUSEHOLD-DESIGN §11), in the Household area: her suggestions first (one person or two, a name for someone
 * heard often), then everyone she knows by voice or from his memory, what she keeps about each and why, and how long.
 * The server owns every rule (who may merge or forget); this only asks and draws.
 */
import type {
  TessayaHouseholdCallResult,
  TessayaHouseholdMember,
  TessayaPeopleSuggestion,
  TessayaPerson,
} from "@t3tools/tessaya-contracts";

import type { HomeControl } from "../home/tessayaHome.ts";
import { text } from "../home/strings.ts";
import type { HouseholdCall } from "./householdTab.ts";

const PREFIX = "m.hh.ppl.";

type Forgotten = NonNullable<TessayaHouseholdCallResult["forgotten"]>[number];

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { dateStyle: "medium" });

/** "Ali, my cousin" → name Ali, relation "my cousin"; a bare name has no relation. */
export const nameAndRelation = (
  said: string,
): { readonly name: string; readonly relation?: string } | null => {
  const [name, ...rest] = said.split(",");
  const n = (name ?? "").trim().slice(0, 60);
  if (n === "") return null;
  const relation = rest.join(",").trim().slice(0, 60);
  return relation === "" ? { name: n } : { name: n, relation };
};

const nameOf = (p: TessayaPerson | undefined): string =>
  p === undefined
    ? text("ppl.someone")
    : (p.name ?? (p.status === "not_person" ? text("ppl.status.tv") : text("ppl.someone")));

const summaryOf = (p: TessayaPerson): string =>
  [
    text(`ppl.status.${p.status}`),
    p.heard === 1 ? text("ppl.heard.one") : text("ppl.heard", { n: p.heard }),
    p.firstSeen === null ? null : text("ppl.first", { at: day(p.firstSeen) }),
    p.lastSeen === null ? null : text("ppl.last", { at: day(p.lastSeen) }),
    p.keepUntil === null ? text("ppl.kept") : text("ppl.keptUntil", { at: day(p.keepUntil) }),
  ]
    .filter((x): x is string => x !== null)
    .join(" · ");

export const peopleControls = (s: {
  readonly people: ReadonlyArray<TessayaPerson>;
  readonly suggestions: ReadonlyArray<TessayaPeopleSuggestion>;
  readonly retentionDays: number;
  readonly askNames: boolean;
  readonly members: ReadonlyArray<TessayaHouseholdMember>;
  /** The row waiting for its second click: `forget:<id>`, `purge:<id>` or `purge:all`. */
  readonly confirmForget: string | null;
  readonly forgotten: ReadonlyArray<Forgotten>;
  readonly binDays: number;
  readonly status: string | null;
}): ReadonlyArray<HomeControl> => {
  const section = text("ppl.section");
  const rows: Array<HomeControl> = [
    {
      id: `${PREFIX}retention`,
      section,
      label: text("ppl.retention"),
      hint: `${text("ppl.retention.hint")} ${text("ppl.retention.detail")}`,
      kind: "choice",
      value: String(s.retentionDays),
      options: [0, 30, 90, 365].map((n) => ({
        value: String(n),
        label: n === 0 ? text("ppl.retention.forever") : text("ppl.retention.days", { n }),
      })),
    },
    {
      id: `${PREFIX}askAll`,
      section,
      label: text("ppl.askAll"),
      hint: text("ppl.askAll.hint"),
      kind: "toggle",
      on: s.askNames,
    },
  ];
  for (const g of s.suggestions) {
    if (g.kind === "same" && g.other !== null)
      rows.push({
        id: `${PREFIX}same:${g.id}|${g.other}`,
        section,
        label: g.line,
        kind: "action",
        button: text("ppl.same"),
        secondary: text("ppl.different"),
      });
    else if (g.kind === "name")
      rows.push({
        id: `${PREFIX}name:${g.id}`,
        section,
        label: g.line,
        hint: text("ppl.name.hint"),
        kind: "list",
        items: [],
        placeholder: text("ppl.name.placeholder"),
        addLabel: text("ppl.name.save"),
      });
    else if (g.kind === "split")
      rows.push({
        id: `${PREFIX}split:${g.id}`,
        section,
        label: g.line,
        kind: "action",
        button: text("ppl.split"),
      });
  }
  if (s.people.length === 0)
    rows.push({
      id: `${PREFIX}none`,
      section,
      label: text("ppl.none"),
      kind: "check",
      status: "ok",
      detail: "",
    });
  const active = s.members.filter((m) => m.state === "active");
  for (const p of s.people) {
    const who = nameOf(p);
    rows.push({
      id: `${PREFIX}person:${p.id}`,
      section,
      label: who,
      kind: "check",
      status: p.status === "unknown" ? "warn" : "ok",
      detail: summaryOf(p),
    });
    for (const [i, r] of p.relations.entries())
      rows.push({
        id: `${PREFIX}rel:${p.id}:${i}`,
        section,
        label: r.text,
        kind: "check",
        status: "ok",
        detail: r.why === null ? text("ppl.why.told") : text("ppl.why", { text: r.why }),
        more: true,
      });
    if (p.topics.length > 0)
      rows.push({
        id: `${PREFIX}said:${p.id}`,
        section,
        label: text("ppl.said", { name: who }),
        kind: "check",
        status: "ok",
        detail: p.topics.map((t) => `${day(t.at)}: "${t.said}"`).join("; "),
        more: true,
      });
    if (p.impression !== null)
      rows.push({
        id: `${PREFIX}impression:${p.id}`,
        section,
        label: text("ppl.impression"),
        kind: "check",
        status: "ok",
        detail: p.impression,
        more: true,
      });
    rows.push({
      id: `${PREFIX}name:${p.id}`,
      section,
      label: p.name === null ? text("ppl.name.new") : text("ppl.name.rename", { name: who }),
      hint: text("ppl.name.hint"),
      kind: "list",
      items: p.name === null ? [] : [p.name],
      required: p.name !== null,
      placeholder: text("ppl.name.placeholder"),
      addLabel: text("ppl.name.save"),
      more: true,
    });
    if (p.status !== "member" || active.length > 0)
      rows.push({
        id: `${PREFIX}status:${p.id}`,
        section,
        label: text("ppl.status.label", { name: who }),
        kind: "choice",
        value: p.status === "not_person" ? "tv" : p.status === "member" ? "member" : p.status,
        options: [
          ...(p.status === "unknown"
            ? [{ value: "unknown", label: text("ppl.status.unknown") }]
            : []),
          ...(p.status === "member" ? [{ value: "member", label: text("ppl.status.member") }] : []),
          { value: "guest", label: text("ppl.status.guest") },
          { value: "tv", label: text("ppl.status.tv") },
          ...active.map((m) => ({
            value: `member:${m.id}`,
            label: text("ppl.isMember", { name: m.name }),
          })),
        ],
        more: true,
      });
    // Everyone named is remembered: only an unnamed voice under an expiry has a keep switch.
    if (p.status === "unknown" && s.retentionDays > 0)
      rows.push({
        id: `${PREFIX}keep:${p.id}`,
        section,
        label: text("ppl.keep", { name: who }),
        hint: text("ppl.keep.hint", { n: s.retentionDays }),
        kind: "toggle",
        on: p.keepUntil === null,
        more: true,
      });
    if (p.name === null && p.status === "unknown")
      rows.push({
        id: `${PREFIX}ask:${p.id}`,
        section,
        label: text("ppl.ask"),
        kind: "toggle",
        on: p.askName,
        more: true,
      });
    rows.push({
      id: `${PREFIX}forget:${p.id}`,
      section,
      label:
        s.confirmForget === `forget:${p.id}`
          ? text("ppl.forget.confirm", { name: who, n: s.binDays })
          : who,
      kind: "action",
      button: text("ppl.forget"),
      more: s.confirmForget !== `forget:${p.id}`,
    });
  }
  // Recently forgotten: restorable for binDays; deleting for good is here alone, each with a second click.
  const bin = text("ppl.bin.section");
  rows.push({
    id: `${PREFIX}bin`,
    section: bin,
    label: text("ppl.bin.days"),
    hint: text("ppl.bin.hint"),
    kind: "choice",
    value: String(s.binDays),
    options: [7, 30, 90].map((n) => ({ value: String(n), label: text("ppl.bin.keep", { n }) })),
  });
  for (const f of s.forgotten)
    rows.push({
      id: `${PREFIX}gone:${f.id}`,
      section: bin,
      label:
        s.confirmForget === `purge:${f.id}`
          ? text("ppl.purge.confirm", { name: f.name ?? text("ppl.someone") })
          : (f.name ?? text("ppl.someone")),
      hint: text(`ppl.by.${f.by === "themselves" || f.by === "expiry" ? f.by : "owner"}`, {
        at: day(f.at),
      }),
      kind: "action",
      button: text("ppl.restore"),
      secondary: text("ppl.purge"),
    });
  if (s.forgotten.length > 0)
    rows.push({
      id: `${PREFIX}purgeAll`,
      section: bin,
      label:
        s.confirmForget === "purge:all" ? text("ppl.purgeAll.confirm") : text("ppl.purgeAll.label"),
      kind: "action",
      button: text("ppl.purgeAll"),
    });
  else
    rows.push({
      id: `${PREFIX}binEmpty`,
      section: bin,
      label: text("ppl.bin.empty"),
      kind: "check",
      status: "ok",
      detail: "",
    });
  if (s.status !== null)
    rows.push({
      id: `${PREFIX}status`,
      section,
      label: s.status,
      kind: "check",
      status: "ok",
      detail: "",
    });
  return rows;
};

/** What a click on one of its rows asks the server, or a local step (the first Forget click); null: not its own. */
export const peopleRequest = (
  id: string,
  value: unknown,
  confirmForget: string | null,
):
  | { readonly op: "peopleManage"; readonly args: Record<string, unknown> }
  | { readonly confirm: string | null }
  | null => {
  if (!id.startsWith(PREFIX)) return null;
  const body = id.slice(PREFIX.length);
  const at = body.indexOf(":");
  const kind = at < 0 ? body : body.slice(0, at);
  const rest = at < 0 ? "" : body.slice(at + 1);
  const manage = (args: Record<string, unknown>) => ({ op: "peopleManage" as const, args });
  if (kind === "askAll") return manage({ action: "ask", on: value === true });
  if (kind === "retention") return manage({ action: "retention", days: Number(value) || 0 });
  if (kind === "same") {
    const later = rest.endsWith(":later");
    const [a, b] = rest.replace(/:later$/, "").split("|");
    if (a === undefined || b === undefined) return { confirm: confirmForget };
    return manage({ action: later ? "notSame" : "merge", id: a, into: b });
  }
  if (kind === "split") return manage({ action: "split", id: rest });
  if (kind === "name") {
    // A list's ids end in :add (the text); a required name has no Remove.
    if (!rest.endsWith(":add") || typeof value !== "string") return { confirm: confirmForget };
    const said = nameAndRelation(value);
    return said === null
      ? { confirm: confirmForget }
      : manage({ action: "name", id: rest.slice(0, -":add".length), ...said });
  }
  if (kind === "status" && typeof value === "string") {
    if (value === "tv") return manage({ action: "notPerson", id: rest });
    if (value === "guest") return manage({ action: "setStatus", id: rest, status: "guest" });
    if (value.startsWith("member:"))
      return manage({
        action: "setStatus",
        id: rest,
        status: "member",
        member: value.slice("member:".length),
      });
    return { confirm: confirmForget };
  }
  if (kind === "keep") return manage({ action: value === true ? "save" : "unsave", id: rest });
  if (kind === "ask") return manage({ action: "ask", id: rest, on: value === true });
  // Forgetting can't be undone: the first click only asks for a second.
  if (kind === "forget")
    return confirmForget === `forget:${rest}`
      ? manage({ action: "forget", id: rest, confirmed: true })
      : { confirm: `forget:${rest}` };
  if (kind === "bin") return manage({ action: "bin", days: Number(value) || 30 });
  if (kind === "gone") {
    if (!rest.endsWith(":later")) return manage({ action: "restore", id: rest });
    const one = rest.slice(0, -":later".length);
    return confirmForget === `purge:${one}`
      ? manage({ action: "purge", id: one })
      : { confirm: `purge:${one}` };
  }
  if (kind === "purgeAll")
    return confirmForget === "purge:all" ? manage({ action: "purge" }) : { confirm: "purge:all" };
  return { confirm: confirmForget };
};

export const createPeopleSection = (input: {
  readonly call: HouseholdCall;
  readonly refresh: () => void;
}) => {
  let people: ReadonlyArray<TessayaPerson> = [];
  let suggestions: ReadonlyArray<TessayaPeopleSuggestion> = [];
  let retentionDays = 0;
  let askNames = true;
  /** Only the owner and admins see People: anyone else's list is refused, and the section stays hidden. */
  let shown = false;
  let confirmForget: string | null = null;
  let forgotten: ReadonlyArray<Forgotten> = [];
  let binDays = 30;
  let status: string | null = null;

  const load = async () => {
    try {
      const r = await input.call("peopleList");
      shown = r.status === "done";
      people = r.people ?? [];
      suggestions = r.suggestions ?? [];
      retentionDays = r.retentionDays ?? retentionDays;
      askNames = r.askNames ?? askNames;
      forgotten = r.forgotten ?? [];
      binDays = r.binDays ?? binDays;
    } catch {
      shown = false;
    }
  };
  let busy: Promise<void> = Promise.resolve();

  return {
    load,
    settled: () => busy,
    controls: (members: ReadonlyArray<TessayaHouseholdMember>): ReadonlyArray<HomeControl> =>
      shown
        ? peopleControls({
            people,
            suggestions,
            retentionDays,
            askNames,
            members,
            confirmForget,
            forgotten,
            binDays,
            status,
          })
        : [],
    /** Handles a click on one of its rows; false when the id is not its own. */
    act: (id: string, value: unknown): boolean => {
      const asked = peopleRequest(id, value, confirmForget);
      if (asked === null) return false;
      if ("confirm" in asked) {
        confirmForget = asked.confirm;
        input.refresh();
        return true;
      }
      confirmForget = null;
      busy = busy.then(async () => {
        try {
          status = (await input.call(asked.op, asked.args)).line;
        } catch (e) {
          status = e instanceof Error ? e.message : text("hh.failed");
        }
        await load();
        input.refresh();
      });
      return true;
    },
  };
};

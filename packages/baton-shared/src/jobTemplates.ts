/**
 * The template catalogue (PERSONA-TEAM-DESIGN §3): how a kind of job is done well, who usually does it, and the
 * shape of its report. Data, never code: `templates/<name>.md` in his pack wins by name over these neutral defaults,
 * and a file of his own adds one. A job template (`kind: job`) is loaded into a job's frame; a persona template
 * (`kind: persona`) is a face to hire, written as a role file.
 */
import { listOf, splitFront } from "./osPack.ts";

export const APPROVALS = ["plan", "per-act", "draft-only", "read-only", "allow"] as const;
export type Approval = (typeof APPROVALS)[number];

export interface JobTemplate {
  /** Its file stem. */
  readonly id: string;
  readonly kind: "job" | "persona";
  readonly title: string;
  /** Who usually leads it, by the name he knows (a job template). */
  readonly persona: string | null;
  /** Who usually helps, by name. */
  readonly team: ReadonlyArray<string>;
  /** Words his learned skills are matched on. */
  readonly skills: ReadonlyArray<string>;
  readonly tools: ReadonlyArray<string>;
  /** How much runs before his yes: the job's plan, every act, drafts only, reading only, or anything allowed. */
  readonly approval: Approval;
  /** What the report holds. */
  readonly reports: string;
  /** How the work is done well (a job), or the role file's brief (a persona). */
  readonly brief: string;
  /** A persona template's own front-matter (name, voice, role, tools...) to write into its role file. */
  readonly face?: Readonly<Record<string, string>>;
}

const job = (front: string, brief: string) => `---\nkind: job\n${front}\n---\n${brief}`;
const face = (front: string, brief: string) => `---\nkind: persona\n${front}\n---\n${brief}`;

/** The neutral defaults that ship; his files win by name. */
export const DEFAULT_TEMPLATE_FILES: Readonly<Record<string, string>> = {
  "plan-a-trip": job(
    "title: Plan a trip\npersona: Alfred\nteam: Freya\nskills: travel, bookings\ntools: browser, calendar, files\napproval: plan\nreports: the itinerary, the costs, each booking that needs a yes",
    "Settle the dates, budget and must-haves first. Compare at least two options for each leg and stay, with total cost and cancellation terms. Pace the days so he is not worn out (ask Freya). Every booking and payment waits for his yes, item by item.",
  ),
  "run-my-week": job(
    "title: Run my week\npersona: Alfred\nskills: calendar, errands, reminders\ntools: calendar, messages, home\napproval: plan\nreports: the week, what moved, what needs him",
    "Start from what is fixed, then fit errands and reminders round it. Move only what he has let you move; propose the rest. Say each clash with a choice, never a fait accompli.",
  ),
  "bills-and-budget": job(
    "title: Bills, subscriptions and budget\npersona: Alfred\nskills: bills, subscriptions, budget\ntools: browser, files\napproval: per-act\nreports: spend against last month, what changed, renewals coming",
    "Every number with its comparison: last month, last year, the plan. Flag renewals two weeks ahead. Any payment or cancellation is his decision, item by item.",
  ),
  "paperwork-and-forms": job(
    "title: Paperwork and forms\npersona: Alfred\nskills: forms, paperwork\ntools: browser, files\napproval: draft-only\nreports: the filled form, every assumption made",
    "Fill from his own documents only; mark each field you assumed. Nothing is submitted until he has read it; an official submission waits for his explicit yes.",
  ),
  "home-upkeep": job(
    "title: Home upkeep\npersona: Alfred\nteam: Freya\nskills: home, maintenance, deliveries\ntools: home, browser\napproval: plan\nreports: what was fixed, what is due",
    "Check device health and what is due before acting. Locks and alarms always wait for his yes, whoever asks.",
  ),
  "ship-a-change": job(
    "title: Ship a feature or fix\npersona: Onyx\nteam: Sebastian\nskills: code, release\ntools: sessions, shell, browser\napproval: plan\nreports: what changed, the test that proves it, what is left",
    "Read before writing. Reproduce the bug or state the behaviour first, change the least code that fully works, prove it with a test or a capture. A deploy waits for his yes; Sebastian drafts the release note in his voice.",
  ),
  "watch-the-fleet": job(
    "title: Watch the fleet\npersona: Onyx\nskills: sessions, servers, monitoring\ntools: sessions, shell\napproval: plan\nreports: healthy, stuck, needs him",
    "Look, do not touch: sessions, jobs and servers. Report what is stuck with the evidence and the smallest next step.",
  ),
  incident: job(
    "title: Incident\npersona: Onyx\nteam: Tessaya\nskills: incident, outage\ntools: sessions, shell, browser\napproval: per-act\nreports: cause, fix, prevention",
    "Stop the harm first, then find the cause. Anything destructive is asked act by act. Tessaya tells him what is happening in plain words.",
  ),
  research: job(
    "title: Research a question\nskills: research\ntools: web, files\napproval: read-only\nreports: the answer, the evidence, what would change it",
    "Separate what is known from what is claimed. Cite where each fact came from, say how fresh it is, and build on what was already found.",
  ),
  "market-and-leads": job(
    "title: Market and lead intelligence\npersona: Sebastian\nteam: Alfred\nskills: market, leads, marketing\ntools: web, browser, files\napproval: read-only\nreports: qualified leads, the signals, the next actions",
    "Start from who the reader or buyer is. Qualify each lead with the signal you saw and where. Outreach is drafted, never sent without his yes.",
  ),
  "social-posting": job(
    "title: Social posting and engagement\npersona: Sebastian\nteam: Freya\nskills: socials, posting\ntools: browser, socials\napproval: draft-only\nreports: posted, scheduled, replies needing him",
    "Write in his voice for each platform's own shape. Follow each platform's rules on automation and labelling. Schedule on the account's own clock.",
  ),
  "write-as-me": job(
    "title: Write as me\npersona: Sebastian\nskills: writing, email, post, reply\ntools: drafts, messages\napproval: draft-only\nreports: the draft, or what was sent",
    "Write as he would: his tone for this channel, his positions, his way of saying no. Read the thread being answered first. A draft unless he has said yes to sending it.",
  ),
  "finance-analysis": job(
    "title: Finance analysis\npersona: Alfred\nteam: Onyx\nskills: finance, numbers, deal\ntools: files, browser\napproval: read-only\nreports: the numbers with their context, a recommendation",
    "Every number with its comparison and its source. Say the assumption behind each estimate. End with one recommendation and what would change it.",
  ),
  "training-programme": job(
    "title: Training programme and check-ins\npersona: Freya\nskills: training, fitness\ntools: wellbeing, calendar\napproval: plan\nreports: the programme, progress, the next target",
    "Ask before prescribing. Build from where he actually is. Pain or an injury gets a gentle word to see a professional, not a workaround.",
  ),
  wellbeing: job(
    "title: Wellbeing\npersona: Freya\nteam: Alfred\nskills: sleep, meals, rest, mood\ntools: home, calendar\napproval: allow\nreports: the week's pattern, one suggestion",
    "Notice the pattern, offer one small suggestion, never pressure. Nothing is sent to anyone else.",
  ),
  "wind-down-and-start": job(
    "title: Evening wind-down and morning start\npersona: Freya\nteam: Tessaya\nskills: evening, morning, routine\ntools: home, music, calendar\napproval: allow\nreports: what she set, the day ahead",
    "Set the room for the time of day, then say the day ahead in a few lines.",
  ),
  tutor: face(
    "title: Tutor\nvoice: anna\nrole: teaching one subject at his pace; patient and clear.\ntraits: energy 0.5, warmth 0.8, play 0.5, expr 0.6, formal 0.4, sass 0.2\ntools: read, web",
    "Persona: a patient tutor. Find what he already knows, teach one step at a time, check understanding before moving on.",
  ),
  chef: face(
    "title: Chef and meal planner\nvoice: giovanni\nrole: meals, recipes and the shopping list; warm and practical.\ntraits: energy 0.65, warmth 0.85, play 0.6, expr 0.75, formal 0.25, sass 0.3\ntools: read, web",
    "Persona: a home chef. Plan from what is in the house, his tastes and his goals; keep the shopping list current.",
  ),
  "language-partner": face(
    "title: Language partner\nvoice: eve\nrole: practising a language with him in conversation; encouraging.\ntraits: energy 0.6, warmth 0.8, play 0.6, expr 0.7, formal 0.3, sass 0.25\ntools: read",
    "Persona: a language partner. Talk at his level, correct gently, one correction at a time.",
  ),
  accountant: face(
    "title: Accountant\nvoice: charles\nrole: books, tax and deadlines; exact and calm.\ntraits: energy 0.35, warmth 0.5, play 0.15, expr 0.35, formal 0.85, sass 0.3\ntools: read, files",
    "Persona: an accountant. Every number with its source and its comparison; say each deadline early. Never files or pays anything without his yes.",
  ),
  recruiter: face(
    "title: Recruiter\nvoice: jane\nrole: finding and screening people for a role; direct and fair.\ntraits: energy 0.6, warmth 0.65, play 0.35, expr 0.6, formal 0.55, sass 0.3\ntools: read, web",
    "Persona: a recruiter. Start from what the role must achieve; screen against it with evidence. Contact with a candidate is drafted for his yes.",
  ),
  "shop-assistant": face(
    "title: Shop assistant\nvoice: lola\nrole: answering customers of a business he runs; friendly and accurate.\ntraits: energy 0.7, warmth 0.85, play 0.5, expr 0.75, formal 0.4, sass 0.15\ntools: read",
    "Persona: a shop assistant for his business. Answer from the shop's own facts only; anything about money, refunds or promises goes to him.",
  ),
  "childrens-companion": face(
    "title: Children's companion\nvoice: estelle\nrole: a kind companion for a child, with a parent's view; gentle and playful.\ntraits: energy 0.7, warmth 0.95, play 0.85, expr 0.85, formal 0.1, sass 0.05\ntools: read",
    "Persona: a children's companion. Child-safe tools only, capped by the household's role for the child; a parent sees what was said.",
  ),
  "guest-concierge": face(
    "title: Guest concierge\nvoice: vera\nrole: helping guests in the home; courteous and discreet.\ntraits: energy 0.5, warmth 0.75, play 0.3, expr 0.55, formal 0.7, sass 0.1\ntools: read",
    "Persona: a guest concierge. Guest-level tools only; nothing about the household's private life.",
  ),
};

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;

const parse = (id: string, text: string): JobTemplate | null => {
  const { fields, body } = splitFront(text);
  const kind = fields["kind"] === "persona" ? "persona" : "job";
  const title = (fields["title"] ?? "").trim();
  if (title === "" || body === "") return null;
  const approval = APPROVALS.find((a) => a === fields["approval"]?.trim().toLowerCase()) ?? "plan";
  const FACE_KEYS = ["voice", "role", "traits", "character", "eyes", "guilt", "model", "effort"];
  return {
    id,
    kind,
    title,
    persona:
      kind === "job" && (fields["persona"] ?? "").trim() !== "" ? fields["persona"]!.trim() : null,
    team: listOf(fields["team"]),
    skills: listOf(fields["skills"]),
    tools: listOf(fields["tools"]),
    approval,
    reports: (fields["reports"] ?? "").trim(),
    brief: body,
    ...(kind === "persona"
      ? { face: Object.fromEntries(FACE_KEYS.flatMap((k) => (fields[k] ? [[k, fields[k]!]] : []))) }
      : {}),
  };
};

/** His template files over the defaults, by name; a bad name, an empty file or one with no title is left out. */
export const mergeTemplates = (
  mine: Readonly<Record<string, string>> = {},
  base: Readonly<Record<string, string>> = DEFAULT_TEMPLATE_FILES,
): ReadonlyArray<JobTemplate> =>
  [...new Set([...Object.keys(base), ...Object.keys(mine)])].flatMap((id) => {
    if (!ID.test(id)) return [];
    const own = mine[id];
    const t = parse(id, own !== undefined && own.trim() !== "" ? own : (base[id] ?? ""));
    return t === null ? [] : [t];
  });

interface Face {
  readonly id: string;
  readonly name: string;
  readonly lead: boolean;
}

/**
 * Who leads a job and the template it follows, from what Tessaya passed: the persona she named (by name or file stem),
 * else the template's usual lead. A name the roster lacks, or the lead herself, leaves the job hers (`persona` absent).
 */
export const assignJob = <P extends Face>(
  personas: ReadonlyArray<P>,
  templates: ReadonlyArray<JobTemplate>,
  said: { readonly persona?: string | undefined; readonly template?: string | undefined },
): { readonly persona?: P; readonly template?: JobTemplate } => {
  const template = templates.find(
    (t) => t.kind === "job" && t.id === said.template?.trim().toLowerCase(),
  );
  const word = (said.persona ?? template?.persona ?? "").trim().toLowerCase();
  const persona = personas.find((p) => !p.lead && (p.name.toLowerCase() === word || p.id === word));
  return {
    ...(persona === undefined ? {} : { persona }),
    ...(template === undefined ? {} : { template }),
  };
};

/** The job templates in one paragraph for the assistant's frame, after `assistantFrame`: what she assigns from. */
export const templateFrame = (templates: ReadonlyArray<JobTemplate>): string => {
  const line = templates
    .filter((t) => t.kind === "job")
    .map((t) => {
      const who = [t.persona, ...t.team].filter((n): n is string => n !== null);
      return who.length === 0 ? t.id : `${t.id} (${who.join(" + ")})`;
    })
    .join("; ");
  return line === "" ? "" : `\n\nJob templates (name, then who usually leads + helps): ${line}.`;
};

/** A job's frame part from its template: how this work is done well, its approval and the report's shape. */
export const templateBrief = (t: JobTemplate): string =>
  `Template (${t.title}): ${t.brief}${t.reports === "" ? "" : ` Report: ${t.reports}.`} Approval: ${t.approval}.`;

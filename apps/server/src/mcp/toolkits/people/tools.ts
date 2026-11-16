/**
 * People she knows by voice or from his memory, for every vessel (HOUSEHOLD-DESIGN §11): who someone is and how he
 * knows them, introductions, "forget me", and the owner's changes. What each caller hears is the service's to decide.
 */
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
  success: Schema.Unknown,
};
const Name = Schema.String.check(Schema.isMaxLength(60));

const WhoTool = Tool.make("people_who", {
  ...shared,
  description:
    'Who someone is and how he knows them ("who is Ali?", "how do I know her?", "what do you know about Sara?", "what did Sara and I talk about last time?"), who was at an event ("who was at the party?"), who was heard on a day, or, with nothing, who the voice just heard was ("who was that?"). Say its line; it already leaves out what this person may not hear.',
  parameters: Schema.Struct({
    name: Schema.optionalKey(Name),
    event: Schema.optionalKey(
      Schema.String.check(Schema.isMaxLength(120)).annotate({
        description: '"the party", "Sara\'s wedding".',
      }),
    ),
    day: Schema.optionalKey(
      Schema.String.check(Schema.isMaxLength(10)).annotate({ description: "YYYY-MM-DD." }),
    ),
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
const IntroduceTool = Tool.make("people_introduce", {
  ...shared,
  description:
    'The person speaking tells you their name ("I\'m Ali", "call me Sara"), or answers when you asked. Binds the name to their voice, and she remembers them from then on. Say its line.',
  parameters: Schema.Struct({
    name: Name.annotate({ description: "Their name, as they said it." }),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
const ForgetMeTool = Tool.make("people_forget_me", {
  ...shared,
  description:
    'Only when the person speaking clearly asks you to forget them ("forget me", "don\'t remember my voice"), never for "forget it" or "never mind". First call it without `confirmed`: it says back what would go; ask them, and only after a clear yes call it again with `confirmed` true. It can be restored for a while.',
  parameters: Schema.Struct({ confirmed: Schema.optionalKey(Schema.Boolean) }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
const ListTool = Tool.make("people_list", {
  ...shared,
  description:
    "Everyone she knows by voice or from his memory, with what she keeps about each and why, how long an unnamed voice is kept (0: until forgotten), and her suggestions (voices that may be one person, someone new heard often, a voice that may be two). Owner or admin only.",
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
const ManageTool = Tool.make("people_manage", {
  ...shared,
  description:
    'The owner\'s changes to people. name: "remember that\'s my cousin Ali" (id "last" is the voice just heard; `relation` is how he knows them; saves them). merge (owner only): `id` is the same person as `into`. split: one voice was two people. notSame: `id` and `into` are different people. notPerson: a TV or radio. setStatus member (with `member`, their household id) or guest. save / unsave: keep an unnamed voice, or let it go at the expiry. retention (`days`, no `id`): forget unnamed voices after that many days; 0 keeps them (everyone named is always kept). ask: whether she may ask a new voice\'s name (`on`; no `id` for everyone). forget (owner only): "forget her", never "forget it" or "never mind"; first without `confirmed`, which says back what would go; only after his clear yes again with `confirmed` true; it goes to Recently forgotten. restore: bring back someone from Recently forgotten. Take ids from people_list. Say its line.',
  parameters: Schema.Struct({
    action: Schema.Literals([
      "name",
      "merge",
      "split",
      "notSame",
      "notPerson",
      "setStatus",
      "save",
      "unsave",
      "ask",
      "forget",
      "retention",
      "restore",
    ]),
    id: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(140))),
    into: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(140))),
    name: Schema.optionalKey(Name),
    relation: Schema.optionalKey(Name),
    status: Schema.optionalKey(Schema.Literals(["member", "guest"])),
    member: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(140))),
    on: Schema.optionalKey(Schema.Boolean),
    days: Schema.optionalKey(Schema.Number),
    confirmed: Schema.optionalKey(Schema.Boolean),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

/** Spread into Tessaya's toolkit, so every vessel gets them through its one registration. */
export const PeopleTools = [WhoTool, IntroduceTool, ForgetMeTool, ListTool, ManageTool] as const;

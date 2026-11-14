/**
 * Who lives here, by voice, for every vessel: list the members and who is around, add or invite someone, change a role,
 * remove someone (their data waits 7 days for their export) or bring them back. A voice never finishes an admin act on
 * its own: those come back `asked`, sent to the owner's device for a yes.
 */
import { BatonPreferenceKey } from "@t3tools/baton-contracts";
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
const Id = Schema.String.check(Schema.isMaxLength(140)).annotate({
  description: "The member's id, from members_list.",
});
const Role = Schema.Literals(["admin", "adult", "child", "guest"]);
const ListTool = Tool.make("members_list", {
  ...shared,
  description:
    "The people who live here: each one's id, name, role (owner, admin, adult, child, guest), whether they're invited, active or leaving, and how many devices they have. Only members may ask.",
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
const InviteTool = Tool.make("member_invite", {
  ...shared,
  description:
    "Add someone to the household with a role. Comes back `asked` when the owner's yes is needed on their device: say it waits for that and nothing is added yet. When done, read out the pairing code for their phone, then offer to enrol their voice.",
  parameters: Schema.Struct({
    name: Schema.String.check(Schema.isMaxLength(120)).annotate({
      description:
        'What to call them, in their words; when they spell it ("Zaid, Z-A-Y-D") pass the spelling too, and it is kept as spelled.',
    }),
    role: Role,
    born: Schema.optionalKey(
      Schema.String.check(Schema.isMaxLength(10)).annotate({
        description: "A child's birth date, YYYY-MM-DD, if given.",
      }),
    ),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);
const SetRoleTool = Tool.make("member_set_role", {
  ...shared,
  description:
    "Change a member's role. Raising one needs the owner's yes on their device; a narrower role signs out their devices that held more. Say what changed, and that it can be changed back the same way.",
  parameters: Schema.Struct({ id: Id, role: Role }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);
const RemoveTool = Tool.make("member_remove", {
  ...shared,
  description:
    "Remove someone from the household: they're signed out everywhere at once, and their data is kept 7 days so they can export it, then destroyed; member_restore undoes it until then. Only with `now` for a safety case: then their data is destroyed at once and can't be undone. Never the owner.",
  parameters: Schema.Struct({
    id: Id,
    now: Schema.optionalKey(
      Schema.Boolean.annotate({ description: "Destroy their data at once." }),
    ),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);
const RestoreTool = Tool.make("member_restore", {
  ...shared,
  description:
    "Bring back a member removed in the last 7 days, with their data; they pair their devices again.",
  parameters: Schema.Struct({ id: Id }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

const RenameTool = Tool.make("member_rename", {
  ...shared,
  description:
    "Change a member's name in the household: their own, or anyone's by an admin (then it comes back `asked` for the owner's yes). Pass a spelling with the name (\"Zaid, Z-A-Y-D\") and it is kept as spelled; say the line back, spelling included.",
  parameters: Schema.Struct({
    id: Id,
    name: Schema.String.check(Schema.isMaxLength(120)).annotate({
      description: "The new name, with its spelling when they spelled it.",
    }),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
const PreferencesTool = Tool.make("member_preferences", {
  ...shared,
  description:
    "A member's own preferences (what to call them, persona, voice, units, time format, news, music): their own, or anyone's for the owner.",
  parameters: Schema.Struct({ id: Id }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);
const PreferenceSetTool = Tool.make("member_preference_set", {
  ...shared,
  description:
    "Set or clear another member's preference, which only the owner may do (the speaker's own go through tessaya_preference_set). `key` is name, persona, voice, units, timeFormat, news, music or wakeTraining (on or off: whether their enrolled voice may train her wake words); an empty `value` clears it. Say the line back.",
  parameters: Schema.Struct({
    id: Id,
    key: BatonPreferenceKey,
    value: Schema.optional(Schema.String.check(Schema.isMaxLength(120))),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const HomeServerTool = Tool.make("household_home_server", {
  ...shared,
  description:
    "Choose which of his linked servers holds the household's members (its name, as members_list's `peers` gives), or null for this one. Only the owner chooses; it comes back `asked` when his yes is needed.",
  parameters: Schema.Struct({
    on: Schema.NullOr(Schema.String.check(Schema.isMaxLength(60))).annotate({
      description: "The server's name, or null for this one.",
    }),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

/** Never the model's: another of this home's servers asks the members here, carrying who asked there. */
const PeerTool = Tool.make("household_peer", {
  ...shared,
  description:
    "Used only by another of this home's linked servers to ask about its members. Never call it yourself.",
  parameters: Schema.Struct({
    input: Schema.Unknown,
    member: Schema.NullOr(Schema.String.check(Schema.isMaxLength(140))),
    service: Schema.Boolean,
    assurance: Schema.Int,
    tainted: Schema.Boolean,
    via: Schema.String.check(Schema.isMaxLength(120)),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

/** Never the model's: another of this home's servers says a member's data was destroyed; vessels here forget their voice. */
const VoiceForgetTool = Tool.make("household_voice_forget", {
  ...shared,
  description:
    "Used only by another of this home's linked servers when a member's data is destroyed. Never call it yourself.",
  parameters: Schema.Struct({ member: Schema.String.check(Schema.isMaxLength(140)) }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

/** Spread into Tessaya's toolkit, so every vessel gets them through its one registration. */
export const MembersTools = [
  ListTool,
  InviteTool,
  SetRoleTool,
  RemoveTool,
  RestoreTool,
  RenameTool,
  PreferencesTool,
  PreferenceSetTool,
  HomeServerTool,
  PeerTool,
  VoiceForgetTool,
] as const;

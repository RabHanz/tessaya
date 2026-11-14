/** Switching his Claude login on one machine, several, or all of them, from any vessel (B-032). */
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { On, PeerOrigin } from "../../../peer/PeerVessels.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

export const AccountUseResult = Schema.Struct({
  results: Schema.Array(
    Schema.Struct({ on: Schema.String, switched: Schema.Boolean, line: Schema.String }),
  ),
});

const UseTool = Tool.make("tessaya_account_use", {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
  description:
    "Switch his Claude login to another of his accounts on a machine: its default login and every Claude session running there, busy ones at the end of their turn. Without `machines` or `everywhere` it is this machine only. Use it for 'switch to the work account', 'switch everything to the home account' (everywhere) or 'switch the studio and the laptop to work'. Say each machine's line as it came back; a machine that did not switch says why.",
  parameters: Schema.Struct({
    account: Schema.String.check(Schema.isMaxLength(120)).annotate({
      description: "The account in his words: a name ('work') or an address.",
    }),
    machines: Schema.optional(
      Schema.Array(On).annotate({
        description: "His other machines to switch, by name. Add 'this' to switch this one too.",
      }),
    ),
    everywhere: Schema.optional(
      Schema.Boolean.annotate({ description: "Every machine he has paired, this one included." }),
    ),
    ...PeerOrigin,
  }),
  success: AccountUseResult,
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

/** Spread into Tessaya's toolkit, so every vessel gets it through its one registration. */
export const AccountTools = [UseTool] as const;

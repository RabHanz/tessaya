/** Her body on Tessaya's /mcp (M-065): move it and feel it, for her own brain and any permitted agent (TessayaBody.ts). */
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
};
const Num = (min: number, max: number, description: string) =>
  Schema.Number.check(Schema.isBetween({ minimum: min, maximum: max })).annotate({ description });
const Bones = Schema.Record(Schema.String, Schema.Array(Schema.Number)).annotate({
  description:
    "Bone: [x, y, z] radians, VRM 1.0 axes from a T-pose (she faces +z, her left is +x). Arms down: leftUpperArm [0, 0, -1.2], rightUpperArm [0, 0, 1.2]. Elbows fold on y (left -, right +), knees on x (+), the trunk and head bend forward on x (+). Out-of-range joints are corrected, never broken.",
});
const Step = {
  act: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "Something she does with her whole body: stand, sit, lie, lean, cuddle, hug, reach, turnAway, walkOver, stepBack, dance, wave, nod, shrug, bow, giggle, sigh, stretch.",
    }),
  ),
  posture: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "A held posture (happy, playful, teasing, shy, affectionate, sad, sleepy, guarded, hug, reach, turn, sit, lie, stand), or auto to hand back to her feelings.",
    }),
  ),
  gesture: Schema.optionalKey(
    Schema.String.annotate({
      description:
        "A short gesture: nodSmall, nodSoft, tilt, shrug, leanIn, wave, hop, bounce, lookAway, chuckle, sigh, yawn, startle, thumbsUp, bow, think, giggleOnce.",
    }),
  ),
  mood: Schema.optionalKey(
    Schema.Struct({
      name: Schema.String,
      intensity: Schema.optionalKey(Num(0, 1, "How strongly, 0 to 1.")),
    }).annotate({
      description: "Her face and posture for a mood, e.g. {name: 'shy', intensity: 0.4}.",
    }),
  ),
  look: Schema.optionalKey(
    Schema.Struct({
      x: Num(-1, 1, "Across: her left is +."),
      y: Num(-1, 1, "Up is +."),
      ms: Schema.optionalKey(Num(200, 20000, "How long, then back to him.")),
    }),
  ),
  face: Schema.optionalKey(
    Schema.Struct({
      weights: Schema.Record(Schema.String, Schema.Number).annotate({
        description:
          "happy, angry, sad, relaxed, surprised, aa, ih, ou, ee, oh, blink, blinkLeft: 0 to 1.",
      }),
      ms: Schema.optionalKey(Num(200, 20000, "How long it holds.")),
    }),
  ),
  morphs: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Number).annotate({
      description:
        "The model's own shape keys by name, 0 to 1, held until set again (tessaya_body_state lists them).",
    }),
  ),
  bones: Schema.optionalKey(Bones),
  ms: Schema.optionalKey(Num(80, 5000, "How long the bones take to arrive.")),
  keys: Schema.optionalKey(
    Schema.Array(
      Schema.Struct({ atMs: Num(0, 20000, "When, from the start."), bones: Bones }),
    ).annotate({
      description: "A keyframed motion, 2 to 32 keys in time order; held at the end unless loop.",
    }),
  ),
  loop: Schema.optionalKey(Schema.Boolean),
  release: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "Hand her body back to her own feelings." }),
  ),
};
const MoveTool = Tool.make("tessaya_body_move", {
  ...shared,
  description:
    'Move her body: the one body on every screen she is on. Combine intent (act, posture, gesture, mood, look) with direct control (bones, face, keys) in one call, and put what follows in `then`, each step `afterMs` from the start, so a whole beat ("lean in, a little shy, then look away") is one request. Call tessaya_body_state first to see what this body can do and where it is. Moves that belong to a private moment only run in one.',
  parameters: Schema.Struct({
    ...Step,
    then: Schema.optionalKey(
      Schema.Array(
        Schema.Struct({
          ...Step,
          afterMs: Num(0, 20000, "When this step starts, from the first."),
        }),
      ),
    ),
  }),
  success: Schema.Struct({
    ok: Schema.Boolean,
    route: Schema.Literals(["private", "desk", "none"]),
    said: Schema.String,
    retryMs: Schema.optionalKey(Schema.Number),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);
const StateTool = Tool.make("tessaya_body_state", {
  ...shared,
  description:
    "Feel her body: whether it is open on a screen, its posture, every posed bone, face, gaze, what her hands rest on, what the rig had to correct, and this model's capabilities (bones, fingers, spine segments, expressions), plus the full move vocabulary and joint limits.",
  success: Schema.Struct({
    open: Schema.Boolean,
    body: Schema.Unknown,
    capabilities: Schema.Unknown,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

/** Spread into Tessaya's toolkit. */
export const BodyTools = [MoveTool, StateTool] as const;

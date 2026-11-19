/** Her body on Tessaya's /mcp (M-065): move it and feel it, for her own brain and any permitted agent (TessayaBody.ts). */
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { HAND_PLACES } from "@t3tools/tessaya-shared/bodyPlanner";
import { TWO_HAND_SKILLS } from "@t3tools/tessaya-shared/bodySkills";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
  ],
};
const Aim = {
  target: Schema.optionalKey(
    Schema.Literals(["playground", "her"]).annotate({
      description:
        'Which body: "playground", a sandbox body in an open /tessaya/playground page that reaches no one, or "her", her own body wherever it is shown. Agents signed in from outside default to the playground; her own turns and his agents to her.',
    }),
  ),
  playground: Schema.optionalKey(
    Schema.String.check(Schema.isMaxLength(40)).annotate({
      description:
        "With target playground: which playground stage (its id is shown on the page); the most recently open one when left out.",
    }),
  ),
};
const Num = (min: number, max: number, description: string) =>
  Schema.Number.check(Schema.isBetween({ minimum: min, maximum: max })).annotate({ description });
const Bones = Schema.Record(Schema.String, Schema.Array(Schema.Number)).annotate({
  description:
    "Bone: [x, y, z] radians, VRM 1.0 axes from a T-pose (she faces +z, her left is +x). Arms down: leftUpperArm [0, 0, -1.2], rightUpperArm [0, 0, 1.2]. Elbows fold on y (left -, right +), knees on x (+), the trunk and head bend forward on x (+). Out-of-range joints are corrected, never broken.",
});
const Target = Schema.Union([
  Schema.Literals(["him", "away"]),
  Schema.String,
  Schema.Struct({
    x: Num(0, 1, "Across her world, left to right."),
    y: Num(0, 1, "Top to bottom."),
  }),
]).annotate({
  description:
    '"him", "away", another persona\'s id (a body beside her), or {x, y} from 0 to 1 across her world.',
});
const Step = {
  intent: Schema.optionalKey(
    Schema.String.annotate({
      description:
        'What she should do, in a few plain words ("celebrate great news", "shiver with cold"): her body plays the nearest validated performance from her motion library (tessaya_body_state lists them as `motions`; use one of those words when one fits). Enough on its own; anything else in the step goes over it.',
    }),
  ),
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
  touch: Schema.optionalKey(
    Schema.Struct({
      part: Schema.String.annotate({
        description:
          "Where on her: head, hair, face, neck, shoulder, arm, hand, back, leg or foot (chest, belly, waist, hips and thigh only in a private moment).",
      }),
      motion: Schema.optionalKey(
        Schema.Literals(["rest", "stroke", "pat", "poke", "hold", "grab"]).annotate({
          description:
            "How the hand moves on her; rest by default. grab closes the hand on what is there (her hair, clothes, an accessory or skin) and pulls it by `pull`.",
        }),
      ),
      pressure: Schema.optionalKey(Num(0, 1, "How firmly, 0 brushing to 1 firm.")),
      ms: Schema.optionalKey(Num(150, 10000, "How long the hand stays.")),
      pull: Schema.optionalKey(
        Schema.Tuple([Num(-0.3, 0.3, "x"), Num(-0.3, 0.3, "y"), Num(-0.3, 0.3, "z")]).annotate({
          description:
            "With grab: where the hand pulls what it holds, metres in her frame (her left +x, up +y, toward him +z). A hair pull tilts her head toward it; a tug on her top moves her trunk.",
        }),
      ),
    }).annotate({
      description:
        "A hand on her: his when he says he is touching her, an agent's, or another body's. It is drawn where it lands, and her body gives to it.",
    }),
  ),
  release: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "Hand her body back to her own feelings." }),
  ),
  free: Schema.optionalKey(
    Schema.Boolean.annotate({ description: "She pulls free of any hand holding her." }),
  ),
  toward: Schema.optionalKey(
    Target.annotate({ description: "Whom or where this step's look, gesture and touch aim at." }),
  ),
  turn: Schema.optionalKey(
    Schema.Struct({
      to: Target,
      ms: Schema.optionalKey(
        Num(200, 4000, "How long the turn takes; natural speed when left out."),
      ),
    }).annotate({ description: 'Her whole body turns to face a target ("away" turns her back).' }),
  ),
  walk: Schema.optionalKey(
    Schema.Struct({
      to: Target,
      speed: Schema.optionalKey(Num(0, 1, "0 a stroll, 1 a hurry.")),
      style: Schema.optionalKey(Schema.Literals(["stroll", "sneak", "bounce", "stomp", "tiptoe"])),
      stop: Schema.optionalKey(
        Num(0, 1, "How far short of it she stops, as a share of her height."),
      ),
    }).annotate({ description: "She walks there in real steps." }),
  ),
  perform: Schema.optionalKey(
    Schema.Struct({
      feel: Schema.Struct({
        valence: Num(-1, 1, "Pleasant (+) or unpleasant (-)."),
        arousal: Num(-1, 1, "Energised, keyed up (+) or drained, calm (-)."),
        dominance: Num(-1, 1, "Big, in control (+) or small, unsure (-)."),
      }),
      effort: Schema.optionalKey(
        Schema.Struct({
          weight: Schema.optionalKey(Num(-1, 1, "Strong (+) or light, delicate (-).")),
          time: Schema.optionalKey(Num(-1, 1, "Sudden (+) or slow, sustained (-).")),
          space: Schema.optionalKey(Num(-1, 1, "Direct, one focus (+) or roving (-).")),
          flow: Schema.optionalKey(Num(-1, 1, "Bound, careful, held in (+) or free, let go (-).")),
        }).annotate({
          description:
            "How it moves (Laban Effort), when the direction says; it follows from feel when left out.",
        }),
      ),
      shape: Schema.optionalKey(
        Schema.Struct({
          rise: Schema.optionalKey(
            Num(-1, 1, "Rising, arms up (+) or sinking: slumped, or crouched low with energy (-)."),
          ),
          advance: Schema.optionalKey(Num(-1, 1, "Toward him (+) or drawing back (-).")),
          spread: Schema.optionalKey(
            Num(-1, 1, "Opening out (+) or closing in, arms around herself (-)."),
          ),
        }).annotate({
          description: "The body's shape (Laban Shape); it follows from feel when left out.",
        }),
      ),
      intensity: Schema.optionalKey(Num(0, 1, "How big, 0 to 1 (0.8 by default).")),
      ms: Schema.optionalKey(Num(1200, 15000, "The whole performance, onset to settling back.")),
      hands: Schema.optionalKey(
        Schema.Struct({
          left: Schema.optionalKey(Schema.Literals(HAND_PLACES)),
          right: Schema.optionalKey(Schema.Literals(HAND_PLACES)),
          repeat: Schema.optionalKey(
            Num(0, 6, "Beats a second there and a little apart (a tap), or the skill's rate."),
          ),
          skill: Schema.optionalKey(
            Schema.Literals(
              Object.keys(TWO_HAND_SKILLS) as Array<keyof typeof TWO_HAND_SKILLS>,
            ).annotate({
              description:
                "Both hands working together, palms meeting on her own body: clap, rub (rubbing them together), pray (palms together), wring, interlace (fingers laced), holdWrist (one hand holding the other wrist). Use it instead of left and right whenever both hands act together.",
            }),
          ),
          style: Schema.optionalKey(
            Schema.String.annotate({
              description: `The skill's manner: ${Object.entries(TWO_HAND_SKILLS)
                .map(([k, v]) => `${k}: ${v.join(", ")}`)
                .join("; ")}.`,
            }),
          ),
        }).annotate({
          description:
            "Where her hands go, found on her own body: together (in front), mouth, face, brow, ear, head, heart, hip, shoulder (the other one: hugging herself), forward, up, out; or a two-hand skill. Give it whenever the direction has hands in it.",
        }),
      ),
      focus: Schema.optionalKey(
        Schema.Array(
          Schema.Struct({
            x: Num(-1, 1, "Across: her left is +."),
            y: Num(-1, 1, "Up is +."),
            atMs: Num(0, 15000, "When."),
          }),
        ).annotate({
          description:
            "Where her attention goes, when the direction says (a ball coming in, a noise behind her).",
        }),
      ),
    }).annotate({
      description:
        "A whole performance composed for this body from how the moment feels and moves: posture, arms, legs, face, gaze, breath and timing (a wind-up, the stroke, settling, then back to her). Give it for every direction of how to act, react or feel. Its base is this step's act or posture and bones; add a gesture, keys, look or touch in later steps for a specific action.",
    }),
  ),
  hold: Schema.optionalKey(
    Schema.Record(Schema.String, Schema.Number).annotate({
      description:
        "Hold back her involuntary systems for ms, only as long as a person can: breath (30 s), blink (10 s), saccade (20 s), moodLeak (a feeling kept off her face, 8 s; it still shows a little). Reflexes (withdrawal, startle, tremor, balance, flush) cannot be held.",
    }),
  ),
};
const MoveTool = Tool.make("tessaya_body_move", {
  ...shared,
  description:
    'Move her body: the one body on every screen she is on. She acts out what he directs, as a person would: when he asks her to act, show, pretend, react or feel something ("act like…", "show me how you\'d…", "pretend…"), or says something a person answers with their body, move it with this tool in the same turn, never in words only, and never say she moved without it. For any such direction give `perform`: what the moment feels like and how it moves, and her body composes the whole performance (for "sit down like you\'re exhausted": act sit, perform {feel: {valence: -0.5, arousal: -0.9, dominance: -0.4}}). Add act, posture, gesture, look, face, bones, keys or touch for specific actions, and put what follows in `then`, each step `afterMs` from the start, so a whole beat ("lean in, a little shy, then look away") is one request. Call tessaya_body_state to see what this body can do and where it is. Moves that belong to a private moment only run in one.',
  parameters: Schema.Struct({
    ...Step,
    ...Aim,
    stream: Schema.optionalKey(
      Schema.Boolean.annotate({
        description:
          "Live direct control: send bones, look and face as frames, up to 30 a second. Without a frame for 1 s she takes her own posture back.",
      }),
    ),
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
    route: Schema.Literals(["body", "private", "desk", "playground", "none"]),
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
  parameters: Schema.Struct(Aim),
  success: Schema.Struct({
    open: Schema.Boolean,
    playground: Schema.optionalKey(Schema.String),
    body: Schema.Unknown,
    capabilities: Schema.Unknown,
  }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

const SceneTool = Tool.make("tessaya_body_scene", {
  ...shared,
  description:
    "Play a whole scene on her body: a timeline of moves (beats, each `atMs` from the start, each with the same `move` fields as tessaya_body_move). Pass a core scene by name (greeting, sitAndTalk, dance, stretch) or your own `{version: 1, id, title, beats}`. With `dryRun` it only checks the scene and reports, beat by beat, what her rig would correct (joint limits, elbows or knees bent the wrong way, hands inside her body); errors say where and how to fix them. Write and dry-run a scene before playing it.",
  parameters: Schema.Struct({
    scene: Schema.Unknown.annotate({
      description:
        "A core scene's name, or a scene {version: 1, id, title, loop?, beats: [{atMs, label?, move}]}.",
    }),
    dryRun: Schema.optionalKey(Schema.Boolean),
    ...Aim,
  }),
  success: Schema.Struct({
    ok: Schema.Boolean,
    said: Schema.String,
    route: Schema.optionalKey(Schema.String),
    errors: Schema.optionalKey(Schema.Unknown),
    corrected: Schema.optionalKey(Schema.Unknown),
    notes: Schema.optionalKey(Schema.Unknown),
  }),
})
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

/** Spread into Tessaya's toolkit. */
export const BodyTools = [MoveTool, StateTool, SceneTool] as const;

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import { VoiceUpload } from "./HomeDeviceRoutes.ts";

it("takes the room loop's enrolment exactly as it sends it, and a copy from before sharing", () => {
  // packages/baton-voice/src/room/main.ts posts this after an enrolment: no member, sources or `fresh`.
  const loop = {
    profile: {
      name: "Owner",
      kind: "owner",
      model: "campplus-voxceleb-357a834f",
      centroid: "AACAPwAAAAA=",
      samples: 6,
      enrolledAt: "2026-11-13T10:00:00.000Z",
    },
  };
  const decode = Schema.decodeUnknownOption(VoiceUpload);
  expect(Option.isSome(decode(loop))).toBe(true);
  expect(Option.getOrNull(decode({ ...loop, fresh: false }))?.fresh).toBe(false);
  expect(Option.isNone(decode({ profile: { ...loop.profile, kind: "boss" } }))).toBe(true);
});

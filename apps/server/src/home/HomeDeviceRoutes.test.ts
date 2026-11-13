import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";

import { uploadAuthorized, VoiceUpload } from "./HomeDeviceRoutes.ts";

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

it("takes a camera upload on the LAN as before, and over the tunnel only with the device key", () => {
  const key = "k".repeat(32);
  expect(uploadAuthorized({}, null)).toBe(true);
  const tunnel = { "cf-connecting-ip": "203.0.113.9" };
  expect(uploadAuthorized(tunnel, key)).toBe(false);
  expect(uploadAuthorized({ ...tunnel, authorization: "Bearer wrong" }, key)).toBe(false);
  expect(uploadAuthorized({ ...tunnel, authorization: `Bearer ${key}` }, key)).toBe(true);
  expect(uploadAuthorized({ ...tunnel, authorization: `Bearer ${key}` }, null)).toBe(false);
});

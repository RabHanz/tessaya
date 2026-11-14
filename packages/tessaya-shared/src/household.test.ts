import { describe, expect, it } from "vite-plus/test";

import {
  memberOfSpeaker,
  memberOfSubject,
  memberSubject,
  OWNER_MEMBER_ID,
  vesselSubject,
  voiceAssurance,
} from "./household.ts";

describe("memberOfSubject", () => {
  it.each([
    // Everything paired before members existed is the owner's, so nobody re-pairs.
    ["desktop-bootstrap", OWNER_MEMBER_ID],
    ["one-time-token", OWNER_MEMBER_ID],
    ["cloud-connect", OWNER_MEMBER_ID],
    ["token-delegated", OWNER_MEMBER_ID],
    ["mcp-client", OWNER_MEMBER_ID],
    ["cli-issued-session", OWNER_MEMBER_ID],
    [vesselSubject("kitchen"), OWNER_MEMBER_ID],
    [memberSubject("sara"), "sara"],
    [memberSubject("7f3c-a1"), "7f3c-a1"],
    // A badly named member is nobody, never the owner.
    ["member:", null],
    ["member:a b", null],
    ["member:a:b", null],
  ])("%s acts for %s", (subject, member) => {
    expect(memberOfSubject(subject)).toBe(member);
  });
});

describe("a spoken turn's member and assurance", () => {
  const voice = (
    kind: "owner" | "saved" | "guest" | "unverified",
    verified = true,
    inherited = false,
  ) => ({
    kind,
    personId: kind === "saved" ? "sara" : kind === "owner" ? "owner" : null,
    verified,
    inherited,
  });
  it.each([
    [voice("owner"), OWNER_MEMBER_ID, 2],
    [voice("owner", false), OWNER_MEMBER_ID, 1],
    [voice("owner", true, true), OWNER_MEMBER_ID, 1],
    [voice("saved"), "sara", 2],
    [voice("guest"), null, 0],
    // A voice Voice ID could not judge stays on the owner's path, at A0.
    [voice("unverified", false), OWNER_MEMBER_ID, 0],
    [null, OWNER_MEMBER_ID, 0],
  ] as const)("%o is %s at A%i", (speaker, member, level) => {
    expect(memberOfSpeaker(speaker)).toBe(member);
    expect(voiceAssurance(speaker)).toBe(level);
  });
});

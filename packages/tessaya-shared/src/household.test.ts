import { describe, expect, it } from "vite-plus/test";

import {
  inQuiet,
  memberOfSpeaker,
  memberOfSubject,
  memberSubject,
  OWNER_MEMBER_ID,
  vesselSubject,
  voiceAssurance,
} from "./household.ts";

describe("a child's quiet hours", () => {
  it.each([
    ["21:00-07:00", 22 * 60, true],
    ["21:00-07:00", 6 * 60 + 59, true],
    ["21:00-07:00", 7 * 60, false],
    ["21:00-07:00", 12 * 60, false],
    ["13:00-15:00", 14 * 60, true],
    ["13:00-15:00", 15 * 60, false],
    ["9pm-7am", 22 * 60, false],
    ["07:00-07:00", 7 * 60, false],
  ] as const)("%s at minute %i is quiet: %s", (range, minutes, quiet) => {
    expect(inQuiet(range, minutes)).toBe(quiet);
  });
});

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
    // Where Voice ID runs, a voice it has not judged (late) or could not judge is nobody: never fail open to him.
    [voice("unverified", false), null, 0],
    // Only a vessel with no Voice ID to run keeps the owner's path, at A0.
    [{ ...voice("unverified", false), voiceIdOff: true }, OWNER_MEMBER_ID, 0],
    [null, OWNER_MEMBER_ID, 0],
  ] as const)("%o is %s at A%i", (speaker, member, level) => {
    expect(memberOfSpeaker(speaker)).toBe(member);
    expect(voiceAssurance(speaker)).toBe(level);
  });
});

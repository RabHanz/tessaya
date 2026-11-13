import { describe, expect, it } from "vite-plus/test";

import { memberOfSubject, memberSubject, OWNER_MEMBER_ID, vesselSubject } from "./household.ts";

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

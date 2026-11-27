import type {
  TessayaHouseholdCallInput,
  TessayaHouseholdCallResult,
} from "@t3tools/tessaya-contracts";
import { describe, expect, it } from "vite-plus/test";

import { copyPreferences, copyVoice, linkProfiles, type LinkHome } from "./profileLinks.ts";

/** A home that answers as the server does for her, recording what it was asked. */
const home = (label: string, me: string, role: "owner" | "adult", refuseLink = false) => {
  const asked: Array<TessayaHouseholdCallInput> = [];
  const links: Array<string> = [];
  const h: LinkHome = {
    label,
    environmentId: `env-${label}`,
    call: async (input): Promise<TessayaHouseholdCallResult> => {
      asked.push(input);
      if (input.op === "whoAmI")
        return {
          status: "done",
          line: "",
          you: { id: me, name: "Sara", role, assurance: 3, kept: [], seenBy: "", consented: true },
        };
      if (input.op === "linkProfile") {
        if (refuseLink) return { status: "refused", line: "Confirm it's you first." };
        links.push(input.home);
      }
      if (input.op === "unlinkProfile") links.splice(links.indexOf(input.home), 1);
      if (input.op === "myVoice")
        return {
          status: "done",
          line: "",
          voices: [
            {
              id: me,
              name: "Sara",
              kind: role === "owner" ? "owner" : "saved",
              model: "m",
              centroid: "AAAA",
              samples: 4,
              sources: ["spoken"],
              enrolledAt: "2026-11-27",
              version: 3,
              updatedAt: "2026-11-27",
            },
          ],
        };
      if (input.op === "preferences")
        return { status: "done", line: "", preferences: { name: "Sar", camera: "on" } };
      return { status: "done", line: "" };
    },
  };
  return { h, asked, links };
};

describe("link my profiles", () => {
  it("records the link in both homes, or takes the first back when the second refuses", async () => {
    const mine = home("Home", "owner", "owner");
    const mum = home("Mum's", "sara-2", "adult");
    expect((await linkProfiles(mine.h, mum.h)).ok).toBe(true);
    expect([mine.links, mum.links]).toEqual([["Mum's"], ["Home"]]);
    expect(mine.asked).toContainEqual({
      op: "linkProfile",
      home: "Mum's",
      member: "sara-2",
      environmentId: "env-Mum's",
    });

    const other = home("Home", "owner", "owner");
    const refusing = home("Gran's", "s-9", "adult", true);
    const r = await linkProfiles(other.h, refusing.h);
    expect(r).toEqual({ ok: false, line: "Confirm it's you first." });
    expect(other.links).toEqual([]);
  });

  it("copies her voice as hers there, and only her portable preferences", async () => {
    const mine = home("Home", "owner", "owner");
    const mum = home("Mum's", "sara-2", "adult");
    expect((await copyVoice(mine.h, mum.h)).ok).toBe(true);
    const saved = mum.asked.find((i) => i.op === "saveVoice");
    expect(saved).toMatchObject({ profile: { id: "sara-2", kind: "saved" }, fresh: true });
    expect(saved && "profile" in saved && "version" in saved.profile).toBe(false);

    await copyPreferences(mine.h, mum.h);
    // A consent like the camera is that home's own to give.
    expect(mum.asked.filter((i) => i.op === "setPreference")).toEqual([
      { op: "setPreference", id: "sara-2", key: "name", value: "Sar" },
    ]);
  });
});

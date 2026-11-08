import { describe, expect, it } from "vite-plus/test";
import { adoptTessayaEnv } from "./tessayaEnv.ts";

describe("adoptTessayaEnv", () => {
  it("lets TESSAYA_ win, keeps BATON_ working, and notes the old names once", () => {
    const notes: string[] = [];
    const env: Record<string, string | undefined> = {
      TESSAYA_REPO: "a/b",
      BATON_REPO: "old/old",
      BATON_ONLY: "1",
    };
    expect(adoptTessayaEnv(env, (m) => notes.push(m))).toEqual(["BATON_ONLY"]);
    expect(env["BATON_REPO"]).toBe("a/b");
    adoptTessayaEnv(env, (m) => notes.push(m));
    expect(notes).toHaveLength(1);
  });
});

import { describe, expect, it } from "vite-plus/test";
import { DEFAULT_REPO, releasesUrl, repoSlug } from "./repo.ts";

describe("repoSlug", () => {
  it("prefers TESSAYA_REPO, then BATON_REPO, then the default", () => {
    expect(repoSlug({ TESSAYA_REPO: "RabHanz/tessaya", BATON_REPO: "old/name" })).toBe(
      "RabHanz/tessaya",
    );
    expect(repoSlug({ BATON_REPO: "a/b" })).toBe("a/b");
    expect(repoSlug({ TESSAYA_REPO: " " })).toBe(DEFAULT_REPO);
    expect(releasesUrl({})).toBe(`https://github.com/${DEFAULT_REPO}/releases`);
  });
});

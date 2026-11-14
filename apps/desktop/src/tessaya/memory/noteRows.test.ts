import { describe, expect, it } from "vite-plus/test";

import { noteAction, noteControls } from "./noteRows.ts";

describe("the Memory area", () => {
  it("offers Edit and Delete per note, and says so when there are none", () => {
    expect(noteControls([])[0]).toMatchObject({ id: "m.empty" });
    const rows = noteControls([{ id: "20261102-likes-tea", text: "Likes tea", file: "x.md" }]);
    expect(rows[0]).toMatchObject({
      id: "m:20261102-likes-tea",
      button: "Edit",
      secondary: "Delete",
    });
    expect(noteAction("m:20261102-likes-tea")).toEqual({ id: "20261102-likes-tea", remove: false });
    expect(noteAction("m:20261102-likes-tea:later")).toEqual({
      id: "20261102-likes-tea",
      remove: true,
    });
    expect(noteAction("m.folder")).toBeNull();
  });
});

import { describe, expect, it } from "vite-plus/test";

import { classifyHelperThread } from "./HelperThreads.ts";

const base = { title: "x", projectRoot: "D:\\Projects\\app", running: false, messages: 0 };

describe("helper thread cleanup", () => {
  it("archives mirrors in Tessaya's own folder, but never a running one or a user's project", () => {
    expect(
      classifyHelperThread({
        ...base,
        title: "userdata-28 · orbit",
        projectRoot: "C:\\Users\\a\\.t3\\userdata",
        messages: 4,
      })?.kind,
    ).toBe("archive");
    expect(
      classifyHelperThread({
        ...base,
        title: "userdata-28 · orbit",
        projectRoot: "C:\\Users\\a\\.t3\\userdata",
        running: true,
      })?.kind,
    ).toBe("leave");
    expect(classifyHelperThread({ ...base, title: "Fix the printer" })).toBeNull();
  });
  it("leaves a helper-looking thread outside .t3 that has messages, archives it when empty", () => {
    expect(
      classifyHelperThread({
        ...base,
        title: "Add sentence punctuation and capitals to this",
        messages: 2,
      })?.kind,
    ).toBe("leave");
    expect(classifyHelperThread({ ...base, title: "shell in app (deleted)" })?.kind).toBe(
      "archive",
    );
  });
});

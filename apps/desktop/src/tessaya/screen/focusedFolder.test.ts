import { describe, expect, it } from "vite-plus/test";

import { focusedFolder, folderFromUrl } from "./focusedFolder.ts";

describe("the folder in a window", () => {
  it("comes from Explorer's URL", () => {
    expect(folderFromUrl("file:///C:/Users/Rab/My%20Docs\r\n")).toBe("C:\\Users\\Rab\\My Docs");
  });

  it("is null for what is not a local folder", () => {
    expect(folderFromUrl("")).toBeNull();
    expect(folderFromUrl("https://example.com")).toBeNull();
    expect(folderFromUrl("file:///C:/bad%E0%A4%A")).toBeNull();
  });

  it("asks nothing away from Windows, or for a window that is not a number", async () => {
    expect(await focusedFolder(5, "linux")).toBeNull();
    expect(await focusedFolder(Number.NaN, "win32")).toBeNull();
  });
});

// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import type { AdoptedSessionService } from "./AdoptedSessionService.ts";
import { liveAttach, safeInboxName } from "./LiveActions.ts";

const withPane = (cwd: string) =>
  ({
    discover: Effect.succeed({
      available: true,
      reason: "",
      candidates: [{ location: { pane: "fab-x~w1:p1", workspace: "x", host: null }, cwd }],
    }),
  }) as unknown as AdoptedSessionService["Service"];

describe("a file sent to a live session (D73)", () => {
  it("keeps a sent name inside the inbox", () => {
    expect(safeInboxName("../../etc/passwd", "T")).toBe("T-passwd");
    expect(safeInboxName(".env", "T")).toBe("T-env");
    expect(safeInboxName("my shot (1).png", "T")).toBe("T-my-shot-1-.png");
  });

  it.effect("lands in the session's directory, out of git, and returns its path", () =>
    Effect.gen(function* () {
      const repo = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "baton-attach-"));
      NodeFS.mkdirSync(NodePath.join(repo, ".git", "info"), { recursive: true });
      const result = yield* liveAttach(withPane(repo), {
        target: { pane: "fab-x~w1:p1" },
        fileName: "shot.png",
        dataBase64: Buffer.from("hello").toString("base64"),
      });
      expect(result.saved).toBe(true);
      expect(result.path?.startsWith(NodePath.join(repo, ".baton", "inbox"))).toBe(true);
      expect(NodeFS.readFileSync(result.path!, "utf8")).toBe("hello");
      expect(NodeFS.readFileSync(NodePath.join(repo, ".baton", ".gitignore"), "utf8")).toBe("*\n");
    }),
  );

  it.effect("refuses a pane that is not running", () =>
    Effect.gen(function* () {
      const result = yield* liveAttach(withPane("/tmp"), {
        target: { pane: "nope" },
        fileName: "a.txt",
        dataBase64: "",
      });
      expect(result.saved).toBe(false);
    }),
  );
});

import { STATIC_KEYBINDING_COMMANDS } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  APP_COMMAND_VOICE,
  appCommandAsks,
  appCommandLine,
  VOICED_APP_COMMANDS,
} from "./appCommands.ts";
import { judgeToolCall } from "./operator.ts";

describe("app commands by voice", () => {
  it("every app command has a voice line or says why it has none", () => {
    expect(Object.keys(APP_COMMAND_VOICE).toSorted()).toEqual(
      [...STATIC_KEYBINDING_COMMANDS].toSorted(),
    );
    for (const [command, entry] of Object.entries(APP_COMMAND_VOICE)) {
      if ("never" in entry) expect(entry.never.length, command).toBeGreaterThan(10);
      else expect(VOICED_APP_COMMANDS, command).toContain(command);
    }
  });

  it("a view runs at once; a send, a closed terminal or a script waits for his yes", () => {
    const judge = (input: Record<string, unknown>) =>
      judgeToolCall({ tool: "app_command", input }, { tainted: false } as never).verdict;
    expect(judge({ command: "usage.open" })).toBe("allow");
    expect(judge({ command: "composer.sendBackground" })).toBe("ask");
    expect(judge({ command: "terminal.close" })).toBe("ask");
    expect(judge({ script: "dev" })).toBe("ask");
    expect(appCommandAsks("sidebar.toggle")).toBeNull();
  });

  it("says what came of it, and never that it ran when nothing took it", () => {
    expect(appCommandLine("usage.open", "ran")).toBe("Opened the usage view.");
    expect(appCommandLine("terminal.split", "idle")).toBe(
      "Nothing open can split the terminal side by side right now.",
    );
    expect(appCommandLine("script.dev.run", "idle")).toBe("No open project has a dev script.");
  });
});

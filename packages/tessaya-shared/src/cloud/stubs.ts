/** Harnesses that can run cloud tasks but have no adapter yet. Each says what a real one needs; adding one is a file. */
import type { CloudProvider, Outcome, ProviderId } from "./types.ts";

const stub = (id: ProviderId, label: string, driver: string, needs: string): CloudProvider => {
  const no = async (): Promise<Outcome<never>> => ({
    ok: false,
    error: `${label} cloud tasks are not set up yet. ${needs}`,
  });
  return {
    id,
    transport: "local",
    label,
    driver,
    capabilities: { resultKind: "pr", cancel: false, usage: false, diff: false, apply: false },
    approval: "local",
    setup: () => ({ state: "not-set-up", why: `${label} cloud tasks have no adapter yet.`, needs }),
    detect: async () => ({
      installed: false,
      signedIn: false,
      identity: null,
      line: `${label}: not available yet.`,
      signInCommand: null,
    }),
    accounts: () => [],
    dispatch: no,
    status: no,
    list: no,
    cancel: no,
    usage: no,
    approve: no,
    deny: no,
  };
};

export const STUBS: ReadonlyArray<CloudProvider> = [
  stub(
    "gemini",
    "Gemini (Jules)",
    "gemini",
    "It needs the Jules command line (jules) signed in, and a way to read a session's state from it.",
  ),
  stub(
    "cursor",
    "Cursor",
    "cursor",
    "It needs a Cursor API key and the background agents API (create, status, follow-up).",
  ),
  stub(
    "opencode",
    "OpenCode",
    "opencode",
    "It needs a hosted OpenCode runner to send tasks to; the CLI itself runs locally only.",
  ),
  stub("grok", "Grok", "grok", "It needs a cloud task API from xAI; none is public yet."),
];

/**
 * A VoiceIntentClient backed by the real grammar (resolveTessayaIntent), the
 * same fast path IntentService runs before any model. Records every call so a
 * test can assert what left the client and what did not.
 */
import { resolveTessayaIntent, type IntentVocabulary } from "@t3tools/tessaya-shared/intentParser";

import type { VoiceIntentClient } from "../src/router.ts";

export const fleet: IntentVocabulary = {
  workSessions: [
    {
      id: "ws-vantageos",
      title: "Niche radar tests",
      projectId: "project-vantageos",
      projectLabel: "VantageOS",
      needsApproval: false,
      updatedAt: "2026-10-26T05:00:00.000Z",
    },
    {
      id: "ws-margin",
      title: "Search ranking",
      projectId: "project-margin",
      projectLabel: "The Margin",
      needsApproval: false,
      updatedAt: "2026-10-26T04:00:00.000Z",
    },
  ],
  projects: [
    { id: "project-vantageos", title: "VantageOS" },
    { id: "project-margin", title: "The Margin" },
  ],
  providers: [
    {
      instanceId: "codex",
      driver: "codex",
      aliases: ["codex"],
      label: "Codex",
      model: "gpt-5",
      available: true,
      signedIn: true,
    },
  ],
  openGates: [],
  hostAliases: [],
  focusedWorkSessionId: null,
};

export interface Call {
  readonly kind: "resolve" | "run" | "sendToSession" | "insertText";
  readonly text: string;
  readonly target: string | null;
}

export const grammarClient = (vocabulary: IntentVocabulary = fleet) => {
  const calls: Call[] = [];
  const read = (text: string, focused: string | null) =>
    resolveTessayaIntent(text, { ...vocabulary, focusedWorkSessionId: focused });
  const client: VoiceIntentClient = {
    resolve: async ({ text, focusedWorkSessionId }) => {
      calls.push({ kind: "resolve", text, target: focusedWorkSessionId });
      return read(text, focusedWorkSessionId);
    },
    run: async ({ text, focusedWorkSessionId }) => {
      calls.push({ kind: "run", text, target: focusedWorkSessionId });
      const resolution = read(text, focusedWorkSessionId);
      return {
        resolution,
        reply:
          resolution.outcome === "resolved" ? resolution.description : resolution.refusal.message,
      };
    },
    sendToSession: async ({ workSessionId, text }) => {
      calls.push({ kind: "sendToSession", text, target: workSessionId });
      return { reply: "" };
    },
    insertText: async ({ text }) => {
      calls.push({ kind: "insertText", text, target: null });
      return { inserted: true };
    },
  };
  return { client, calls };
};

/**
 * "Report this transcript": a plain file he can read and attach to a bug report. It holds the words (heard and written, and
 * every retry), how they were made and where they went; it never holds the recording, and nothing is sent anywhere.
 */
import type { HistoryTurn } from "./history.ts";

const FENCE = "```";
const fence = (text: string): string => `${FENCE}\n${text.replaceAll(FENCE, "'''")}\n${FENCE}`;

export const buildTranscriptReport = (
  turn: Pick<
    HistoryTurn,
    | "id"
    | "at"
    | "kind"
    | "app"
    | "raw"
    | "cleaned"
    | "status"
    | "model"
    | "delivery"
    | "audio"
    | "seconds"
    | "error"
    | "versions"
    | "corrected"
  >,
  meta: { readonly version: string; readonly platform: string },
): string =>
  [
    "# Transcript report",
    "",
    `Tessaya ${meta.version} on ${meta.platform}. Made on this computer; nothing was sent. Read it before you share it.`,
    "",
    `- When: ${turn.at}`,
    `- What: ${turn.kind === "spoken" ? "a spoken turn" : "dictation"}${turn.app === "" ? "" : ` in ${turn.app}`}`,
    `- Tidy-up: ${turn.status}${turn.model === null ? "" : ` by ${turn.model}`}${turn.delivery === null ? "" : `, delivered: ${turn.delivery}`}`,
    `- Length: ${turn.seconds === null ? "unknown" : `${turn.seconds.toFixed(1)} s`}`,
    `- Recording kept: ${turn.audio !== null && turn.audio.trim() !== "" ? "yes (not included in this file)" : "no"}`,
    `- He corrected it afterwards: ${turn.corrected ? "yes" : "no"}`,
    ...(turn.error === null ? [] : [`- Error: ${turn.error}`]),
    "",
    "## As heard",
    "",
    fence(turn.raw),
    "",
    ...(turn.cleaned === null ? [] : ["## Written", "", fence(turn.cleaned), ""]),
    ...(turn.versions.length > 1
      ? [
          "## Versions",
          "",
          ...turn.versions.flatMap((v, i) => [
            `### ${i + 1} (${v.at})`,
            "",
            fence(v.cleaned ?? v.raw),
            "",
          ]),
        ]
      : []),
    "## What was wrong",
    "",
    "(Write here what the words should have been.)",
    "",
  ].join("\n");

/* oxlint-disable t3code/no-low-value-comments, t3code/prefer-effect-fn -- Baton file (D82) */
// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalDateInEffect:off preferSchemaOverJson:off effectFnOpportunity:off
/**
 * Every live Claude Code session as an ordinary T3 thread (D83).
 *
 * T3's official apps (phone, desktop, app.t3.codes) render threads from the server's read model
 * and nothing else, so this is where a session started in a plain terminal, VS Code or Herdr has
 * to become one. Each session in the registry (`~/.claude/sessions/<pid>.json`, D68) gets a thread
 * under the T3 project its directory belongs to, written with the same events upstream's own
 * agent-session import writes, and its transcript is followed so new messages arrive as they are
 * written. The thread's provider is the "Live session" instance: T3's own ACP Registry driver
 * running `scripts/tessaya/live/baton-live-acp.mjs`, so the composer's send becomes a turn that
 * types into the session's Herdr pane (adopting it first when needed).
 *
 * Identity is the Claude conversation id: `baton-live:<session id>`. Account rotation and Herdr
 * adoption both reopen the same conversation id (D69, D74), so the thread stays the same thread.
 * A session T3 already owns (its SDK sessions, or one imported by upstream's importer) is never
 * mirrored a second time.
 *
 * Ordering: runless items sort before every run, so a message written after a composer turn is
 * attached to the thread's latest run and lands after it.
 *
 * D85: pasted images and sent files show (`liveMedia`), each tool call shows as it runs, runs end
 * at once so T3 never queues a send, and the session's working state is a background task on its
 * provider thread, so T3 alerts once when a turn someone asked for has finished.
 *
 * shortcut: polls the registry and each transcript every 2 s rather than watching files; a tick
 * costs a directory read plus one `stat` per live session. Upgrade to fs.watch if ticks show up.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  type ChatAttachment,
  EventId,
  MessageId,
  NodeId,
  RuntimeRequestId,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  type ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  TurnItemId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  DEFAULT_RUNTIME_MODE,
  type OrchestrationProjectShell,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  RunId,
} from "@t3tools/contracts";
import type { ClaudeLiveSession } from "@t3tools/baton-contracts";
import {
  claudeProjectSlug,
  isComposerEcho,
  parseLiveToolSteps,
  parseLiveTranscriptLine,
  splitTranscriptChunk,
  type LiveToolStep,
  type LiveTranscriptImage,
  type LiveTranscriptMessage,
} from "@t3tools/baton-shared/liveTranscript";
import { derive as deriveIds } from "@t3tools/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";

import { BATON_LIVE_INSTANCE } from "./BatonLiveInstance.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";

import {
  chatAttachmentStableKey,
  createDeterministicAttachmentId,
  resolveAttachmentPath,
} from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import { appendResumeLog } from "./ResumeLog.ts";
import { formOverview, pendingAskQuestions } from "./FormQuestions.ts";
import { decideBinding } from "./BindingHealth.ts";
import { BatonWeaveService } from "./BatonWeaveService.ts";
import { resendKept, sessionOfThread, stampKept } from "./UnboundMessages.ts";
import { staleAskIds } from "./StaleAsks.ts";
import { splitPaneRef } from "./HerdrAdapterLive.ts";
// @ts-expect-error -- plain JS shared with the live agent, which runs without a build; typed below
import * as panePrompt from "../../../../scripts/tessaya/live/pane-prompt.mjs";
import { mediaKindFromPath } from "@t3tools/shared/mediaPreview";
import {
  attachMarkdown,
  isUserSentMedia,
  looksLikePicture,
  resolveMedia,
} from "../mentionedMedia.ts";
import { inferImageExtension } from "../imageMime.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { BatonEngine, type BatonEngineShape } from "./BatonEngine.ts";
import { readAllProfileLiveSessions } from "./ClaudeLiveSessions.ts";
import { projectRefFor } from "./ProjectRef.ts";
import { stateFile } from "@t3tools/baton-shared/stateDir";

export const LIVE_INSTANCE_ID = ProviderInstanceId.make(BATON_LIVE_INSTANCE);
const DRIVER = ProviderDriverKind.make("acpRegistry");
const MODEL = "live";
/**
 * Id namespace of live threads. "baton-live" (2026-10-27 rounds 1–2) back-filled older history
 * after newer and so showed it out of order; those threads are deleted at start and rebuilt under
 * this one (they are a mirror of the transcript, which is the record).
 */
const PREFIX = "baton-live4";
/**
 * baton-live2 (round 3 first cut) closed old turns at server start; baton-live3 (round 3) dropped
 * every image and sent file. Both are rebuilt from the transcript.
 */
const RETIRED_PREFIXES = ["baton-live:", "baton-live2:", "baton-live3:"];
const TICK = "2 seconds";
/** How much of an existing transcript a new thread starts with. */
const FIRST_READ_BYTES = 4 * 1024 * 1024;
const FIRST_MESSAGES = 120;
/** How far back a new thread looks for those messages. */
const MAX_BACKFILL_BYTES = 64 * 1024 * 1024;
/** A busy session can write a lot between ticks; one tick reads at most this much. */
const STEP_BYTES = 8 * 1024 * 1024;
/** A turn ends after this long idle: Claude Code can read idle for a moment inside one turn. */
const IDLE_SETTLE_MS = 4_000;
/** The background task that shows a live session working (D85). */
const WORKING_TASK = {
  taskId: "baton-live-turn",
  kind: "background_task" as const,
  description: "Working in its terminal",
};
/** How often a working thread's task is checked against what the runtime last wrote. */
const RECHECK_MS = 10_000;
/** A tool's output shown in the thread is cut to this many characters. */
const MAX_TOOL_OUTPUT_CHARS = 4_000;
/** A sent file bigger than this is named in the thread, not copied. */
const realpathOrNothing = (path: string): ReadonlyArray<string> => {
  try {
    return [NodeFS.realpathSync(path)];
  } catch {
    return [];
  }
};
const MAX_SENT_FILE_BYTES = 20 * 1024 * 1024;
/** A turn shows at most this many tool screenshots; the newest win. */
const MAX_TOOL_SHOTS = 4;

const INLINE_IMAGE_TYPES: Record<string, string> = {
  ".gif": "image/gif",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};
const FILE_TYPES: Record<string, string> = {
  ".html": "text/html",
  ".json": "application/json",
  ".md": "text/markdown",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".txt": "text/plain",
};

/** What the mirror shows of a prompt read off a Herdr pane (D88). */
interface PanePrompt {
  readonly question: string;
  readonly header: string | null;
  readonly context: string;
  readonly options: ReadonlyArray<{ readonly label: string; readonly description: string }>;
  readonly customIndex: number | null;
  readonly key: string;
  /** A permission dialog's own words, behind its plain question. */
  readonly details?: string;
}

export const parsePanePrompt: (screen: string) => PanePrompt | null = panePrompt.parsePanePrompt;
const screenTail: (screen: string) => string = panePrompt.screenTail;

/** The visible screen of a Herdr pane read in-process (no node child per read), or null when Herdr cannot read it. */
const readPane = (paneRef: string, lines: number): Effect.Effect<string | null> => {
  const { session, pane } = splitPaneRef(paneRef);
  const prefix = session === null || session === "default" ? [] : ["--session", session];
  return Effect.callback<string | null>((resume) => {
    NodeChildProcess.execFile(
      "herdr",
      [...prefix, "agent", "read", pane, "--source", "visible", "--lines", String(lines)],
      { timeout: 10_000 },
      (error, stdout) => resume(Effect.succeed(error === null ? stdout : null)),
    );
  });
};

const readPanePrompt = (pane: string): Effect.Effect<PanePrompt | null> =>
  readPane(pane, 80).pipe(
    Effect.map((screen) => (screen === null ? null : parsePanePrompt(screen))),
  );

/** The last lines on a waiting pane; empty when it cannot be read. */
const readPaneScreen = (pane: string): Effect.Effect<string> =>
  readPane(pane, 40).pipe(Effect.map((screen) => (screen === null ? "" : screenTail(screen))));

/**
 * A session that is waiting but whose prompt cannot be read as options (a plain terminal, or a screen the reader does not
 * know) still gets a question in its thread, so the thread never says "waiting" and shows nothing.
 */
export const unreadPrompt = (
  session: { sessionId: string; herdrPane: string | null },
  screen: string,
): PanePrompt =>
  session.herdrPane === null
    ? {
        key: `plain:${session.sessionId}`,
        header: "In the terminal",
        context: "",
        question:
          "Claude Code is waiting on a question in its terminal. It is not running in Herdr, so Tessaya cannot read the question from here.",
        options: [
          {
            label: "Bring it into Herdr",
            description:
              "Restarts it with the same conversation, in Herdr, so the question can be answered here.",
          },
        ],
        customIndex: null,
      }
    : {
        key: `screen:${session.sessionId}:${screen.length}:${screen.slice(-40)}`,
        header: "In the terminal",
        context: "",
        question:
          screen === ""
            ? "Claude Code is waiting on something in its terminal that Tessaya could not read as a question."
            : `Claude Code is waiting in its terminal:\n${screen}`,
        options: [
          {
            label: "I'll answer it in the terminal",
            description: "Open the pane in Herdr and answer it there.",
          },
        ],
        customIndex: null,
      };

/** Longer than the live agent waits for an answered prompt to leave the screen (PROMPT_CLEAR_TRIES). */
const ASK_REOPEN_MS = 20_000;

/**
 * Whether the card for the prompt still on screen stays. One T3 closed (an answer that pressed nothing, a dismiss)
 * comes back once an answer has had time to clear the prompt, so a waiting session never shows no card.
 */
export const keepAsk = (ask: { closedAt: number | null }, pending: boolean, nowMs: number) => {
  if (pending) return true;
  ask.closedAt ??= nowMs;
  return nowMs - ask.closedAt < ASK_REOPEN_MS;
};

/** The T3 question a terminal prompt becomes. T3 sends its answer back as "<question>\n<answer>". */
export const askQuestion = (found: PanePrompt, overview: string) => ({
  id: "answer",
  header: (found.header ?? "Terminal").slice(0, 60),
  question: [overview, found.context, found.question]
    .filter((part) => part.length > 0)
    .join(". ")
    .replace(/[ \t]+/g, " ")
    .slice(-1_400),
  options: found.options.map((option) => ({
    label: option.label,
    description: option.description.length > 0 ? option.description : option.label,
  })),
  ...(found.customIndex === null ? {} : { allowCustomAnswer: true }),
  ...(found.details === undefined ? {} : { details: found.details }),
});

const isStep = (entry: LiveTranscriptMessage | LiveToolStep): entry is LiveToolStep =>
  "kind" in entry;

/** A file name as markdown link text: brackets would end the link. */
const label = (name: string): string => name.replace(/[[\]\\]/g, "");

/** What a message shows beyond its words: T3 attachments and, for sent files, markdown. */
export interface LiveMedia {
  readonly text: string;
  readonly attachments: ReadonlyArray<ChatAttachment>;
}

/**
 * Copies a message's media into T3's attachment store (ids from the bytes, so a second mirror of
 * the same message writes nothing new). Pasted images become the user message's own image
 * attachments, which every T3 client renders. Files the session sent go into the assistant
 * message as markdown, because T3 renders an assistant message's images and file links from its
 * markdown: images inline, anything else as a file link. Only what the transcript names is read:
 * the bytes the user pasted, and the paths the session itself chose to send.
 */
export const liveMedia = (input: {
  readonly attachmentsDir: string;
  readonly threadId: string;
  readonly messageId: string;
  readonly message: LiveTranscriptMessage;
  /** The session's directory: image and video files a reply names are shown when they sit inside it. */
  readonly cwd?: string;
  /** Paths the session's own tool calls used since the last user message. */
  readonly touched?: ReadonlyArray<string>;
  /** Hashes of pictures this thread already shows. */
  readonly shown?: Set<string>;
}): LiveMedia => {
  const { attachmentsDir, threadId, messageId, message } = input;
  const store = (attachment: ChatAttachment, bytes: Uint8Array): string | null => {
    const path = resolveAttachmentPath({ attachmentsDir, attachment });
    if (path === null) return null;
    if (!NodeFS.existsSync(path)) {
      NodeFS.mkdirSync(attachmentsDir, { recursive: true });
      NodeFS.writeFileSync(path, bytes);
    }
    return path;
  };
  const attachments: Array<ChatAttachment> = [];
  const notes: Array<string> = [];
  const links: Array<string> = [];
  const shotSources = new Set<string>();
  (message.images ?? []).forEach((image, index) => {
    if (image.source !== undefined) {
      if (isUserSentMedia(image.source)) return;
      // The block is the file re-encoded, so the file itself is not shown again.
      for (const real of realpathOrNothing(image.source)) shotSources.add(real);
    }
    const bytes = Buffer.from(image.data, "base64");
    const extension = inferImageExtension({ mimeType: image.mimeType });
    const id = createDeterministicAttachmentId(
      threadId,
      chatAttachmentStableKey(messageId, index, bytes),
    );
    if (id === null || bytes.length === 0) return;
    if (bytes.length > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      notes.push(
        `_An image (${Math.round(bytes.length / 1_048_576)} MB) is too big to show here._`,
      );
      return;
    }
    const attachment: ChatAttachment = {
      type: "image",
      id,
      name: `image-${index + 1}${extension}`,
      mimeType: image.mimeType,
      sizeBytes: bytes.length,
    };
    // A reply shows a picture once: by its bytes, whether it came as a tool's image block or as the file the tool read.
    if (message.role === "assistant" && input.shown !== undefined) {
      const hash = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
      if (input.shown.has(hash)) return;
      input.shown.add(hash);
    }
    const copy = store(attachment, bytes);
    if (copy === null) return;
    // A reply's pictures (tool screenshots) ride in its markdown; a user message's are T3 attachments.
    if (message.role === "assistant") links.push(`![${attachment.name}](<${copy}>)`);
    else attachments.push(attachment);
  });
  const sent = message.files ?? [];
  sent.forEach((file, index) => {
    const quiet = false;
    const name = NodePath.basename(file);
    let stat: NodeFS.Stats | null = null;
    try {
      stat = NodeFS.statSync(file);
    } catch {}
    if (stat === null || !stat.isFile()) {
      if (!quiet) notes.push(`_${label(name)} is no longer on disk._`);
      return;
    }
    if (stat.size === 0 || stat.size > MAX_SENT_FILE_BYTES) {
      if (!quiet) {
        notes.push(
          `_${label(name)} (${Math.round(stat.size / 1_048_576)} MB) is not copied here._`,
        );
      }
      return;
    }
    const bytes = NodeFS.readFileSync(file);
    // A file a reply sends is shown once, by its bytes, and one that is not the picture it is named for is not shown at all.
    if (message.role === "assistant" && input.shown !== undefined) {
      const mark = looksLikePicture(name, bytes)
        ? NodeCrypto.createHash("sha256").update(bytes).digest("hex")
        : `bad:${file}:${bytes.length}`;
      if (input.shown.has(mark)) return;
      input.shown.add(mark);
      if (mark.startsWith("bad:")) {
        notes.push(`_${label(name)}: image unavailable (not a picture)_`);
        return;
      }
    }
    const extension = NodePath.extname(name).toLowerCase();
    const id = createDeterministicAttachmentId(
      threadId,
      chatAttachmentStableKey(messageId, index, bytes),
    );
    if (id === null) return;
    const imageType = INLINE_IMAGE_TYPES[extension];
    const attachment: ChatAttachment =
      imageType !== undefined && bytes.length <= PROVIDER_SEND_TURN_MAX_IMAGE_BYTES
        ? { type: "image", id, name, mimeType: imageType, sizeBytes: bytes.length }
        : {
            type: "file",
            id,
            name,
            mimeType: FILE_TYPES[extension] ?? "application/octet-stream",
            sizeBytes: bytes.length,
          };
    const copy = store(attachment, bytes);
    if (copy === null) return;
    links.push(
      attachment.type === "image" || mediaKindFromPath(name) === "video"
        ? `![${label(name)}](<${copy}>)`
        : `[${label(name)}](<${copy}>)`,
    );
  });
  // What a reply names, and what the session touched this turn, shows too: one rule for every provider.
  if (message.role === "assistant" && input.cwd !== undefined) {
    const sentReal = new Set(sent.flatMap((file) => realpathOrNothing(file)));
    links.push(
      ...attachMarkdown({
        attachmentsDir,
        threadId,
        messageId,
        ...(input.shown ? { shown: input.shown } : {}),
        media: resolveMedia({
          text: message.text,
          cwd: input.cwd,
          touched: input.touched ?? [],
          exclude: [attachmentsDir],
        }).filter((m) => !sentReal.has(m.file) && !shotSources.has(m.file)),
      }),
    );
  }
  const text = [message.text, ...links, ...notes].filter((part) => part.length > 0).join("\n\n");
  // Sent files live in the markdown; only a user message carries T3 attachments.
  return { text, attachments: message.role === "user" ? attachments : [] };
};

/** Off by machine with `BATON_LIVE_THREADS=off`. */
export const liveThreadsEnabled = (): boolean => process.env.BATON_LIVE_THREADS !== "off";

export const liveThreadId = (sessionId: string): ThreadId =>
  ThreadId.make(`${PREFIX}:${sessionId}`);

const agentScript = (): string =>
  process.env.BATON_LIVE_ACP ?? stateFile(NodeOS.homedir(), "baton-live-acp.mjs");

/** A Node for the agent: T3 itself is a single executable, so it cannot run a script. */
export const findNode = (): string | null => {
  const home = NodeOS.homedir();
  const nvm = NodePath.join(home, ".nvm", "versions", "node");
  let nvmNodes: Array<string> = [];
  try {
    nvmNodes = NodeFS.readdirSync(nvm)
      .toSorted((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .map((version) => NodePath.join(nvm, version, "bin", "node"));
  } catch {}
  const candidates = [
    process.env.BATON_LIVE_NODE,
    stateFile(home, "node"),
    NodePath.join(home, "bin", "node"),
    ...nvmNodes,
    "/usr/local/bin/node",
    "/usr/bin/node",
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate.length === 0) continue;
    try {
      NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
      return candidate;
    } catch {}
  }
  return null;
};

/** The project a session's directory belongs to: deepest root that contains it, then same repo. */
export const projectForDirectory = (
  cwd: string,
  projects: ReadonlyArray<
    Pick<OrchestrationProjectShell, "id" | "workspaceRoot" | "repositoryIdentity">
  >,
  repositoryKey: string | null,
): ProjectId | null => {
  const inside = projects
    .filter(
      (p) => cwd === p.workspaceRoot || cwd.startsWith(`${p.workspaceRoot.replace(/\/$/, "")}/`),
    )
    .toSorted((a, b) => b.workspaceRoot.length - a.workspaceRoot.length);
  if (inside[0] !== undefined) return inside[0].id;
  if (repositoryKey === null) return null;
  return projects.find((p) => p.repositoryIdentity?.canonicalKey === repositoryKey)?.id ?? null;
};

/** The box, as the official apps' environment list names it: the host's first label. */
const box = (): string => NodeOS.hostname().split(".")[0] ?? NodeOS.hostname();

/**
 * The thread title the official apps show: the session's own name, then the account and box it
 * runs on. T3 renders only the title in its thread lists, so that is where they go.
 */
export const liveThreadTitle = (input: {
  readonly name: string;
  readonly account: string | null;
  readonly box: string;
}): string =>
  [input.name.trim().slice(0, 60) || "Live session", input.account, input.box]
    .filter((part): part is string => part !== null && part.length > 0)
    .join(" · ");

/**
 * The title the mirror wants on a thread, or null to leave it. The mirror only touches titles it
 * wrote itself (they end with this box); a title someone typed or T3 generated is theirs and wins.
 */
export const mirrorTitle = (input: {
  readonly current: string;
  readonly regenerating: boolean;
  readonly sessionName: string | null;
  readonly nameFromUser: boolean;
  readonly followName: string | null;
  readonly account: string | null;
  readonly box: string;
}): string | null => {
  if (input.regenerating || !input.current.endsWith(` · ${input.box}`)) return null;
  // Claude Code derives a fresh name on every restart (rotation, adoption); a thread keeps the
  // name it was first given unless someone names the session.
  const kept = input.current.includes(" · ") ? input.current.split(" · ")[0] : undefined;
  const name = input.nameFromUser
    ? (input.sessionName ?? kept)
    : (kept ?? input.sessionName ?? input.followName ?? undefined);
  const wanted = liveThreadTitle({
    name: name ?? "Live session",
    account: input.account,
    box: input.box,
  });
  return wanted === input.current ? null : wanted;
};

const SESSION_STEP_TIMEOUT = "30 seconds";
const PROMPT_REREAD_MS = 10_000;

/** Ended-session threads wait this long before leaving the list, so a failed read cannot empty it. */
const ENDED_GRACE_MS = 5 * 60_000;
/** And their session must be missing from every read for this long: one bad read or a restart gap is not an end. */
const MISSING_GRACE_MS = 3 * 60_000;

/**
 * Mirrored threads whose session has ended; whether he continued one is a separate check. `missingSince` is the
 * caller's memory across ticks of when each thread's session was first seen missing; this updates it.
 */
export const endedMirrorThreads = (
  shells: ReadonlyArray<Pick<OrchestrationV2ThreadShell, "id" | "updatedAt">>,
  liveSessionIds: ReadonlySet<string>,
  missingSince: Map<ThreadId, number>,
  nowMs: number,
): ReadonlyArray<ThreadId> => {
  const missing = shells.filter(
    (t) =>
      String(t.id).startsWith(`${PREFIX}:`) &&
      !liveSessionIds.has(String(t.id).slice(PREFIX.length + 1)),
  );
  const ids = new Set(missing.map((t) => t.id));
  for (const id of missingSince.keys()) if (!ids.has(id)) missingSince.delete(id);
  for (const id of ids) if (!missingSince.has(id)) missingSince.set(id, nowMs);
  return missing
    .filter(
      (t) =>
        nowMs - (missingSince.get(t.id) ?? nowMs) >= MISSING_GRACE_MS &&
        nowMs - DateTime.toEpochMillis(t.updatedAt) > ENDED_GRACE_MS,
    )
    .map((t) => t.id);
};

/**
 * A thread the mirror archived that is open again was unarchived by him: it is his choice now, so a later archive
 * of it is his too and it must not come back with its session. `open` is the snapshot of unarchived threads.
 */
export const forgetUnarchived = (
  endedArchived: Set<ThreadId>,
  open: ReadonlyArray<Pick<OrchestrationV2ThreadShell, "id">>,
): void => {
  for (const t of open) endedArchived.delete(t.id);
};

/** A message he sent from T3: the mirror's own copies of terminal messages carry its prefix. */
export const sentFromT3 = (
  messages: ReadonlyArray<Pick<OrchestrationV2ConversationMessage, "id" | "role">>,
): boolean => messages.some((m) => m.role === "user" && !String(m.id).startsWith(`${PREFIX}:`));

const TEST_PROJECTS = new Set([
  "baton-prompt-test",
  "baton-media-test",
  "native-copy-1",
  "resume-proof",
]);

/**
 * The one-time clean-up of the thread list: each project keeps the thread of its live session,
 * or its newest thread when nothing is live there; the test projects keep none.
 */
export const sweepVictims = (input: {
  readonly shells: ReadonlyArray<
    Pick<OrchestrationV2ThreadShell, "id" | "projectId" | "updatedAt" | "archivedAt">
  >;
  readonly projects: ReadonlyArray<
    Pick<OrchestrationProjectShell, "id" | "title" | "workspaceRoot" | "repositoryIdentity">
  >;
  readonly liveSessions: ReadonlyArray<Pick<ClaudeLiveSession, "sessionId" | "cwd">>;
}): ReadonlyArray<ThreadId> => {
  const liveIds = new Set(input.liveSessions.map((s) => String(liveThreadId(s.sessionId))));
  const liveProjects = new Set(
    input.liveSessions.map((s) => projectForDirectory(s.cwd, input.projects, null)),
  );
  const testProjects = new Set(
    input.projects
      .filter(
        (p) => TEST_PROJECTS.has(p.title) || TEST_PROJECTS.has(NodePath.basename(p.workspaceRoot)),
      )
      .map((p) => p.id),
  );
  const open = input.shells.filter((t) => t.archivedAt === null);
  const newest = new Map<ProjectId, ThreadId>();
  for (const t of open) {
    const best = open.find((o) => o.id === newest.get(t.projectId));
    if (
      best === undefined ||
      DateTime.toEpochMillis(t.updatedAt) > DateTime.toEpochMillis(best.updatedAt)
    ) {
      newest.set(t.projectId, t.id);
    }
  }
  return open
    .filter((t) => {
      if (testProjects.has(t.projectId)) return true;
      if (liveIds.has(String(t.id))) return false;
      // A project with a live session keeps only that session's thread (made on the next pass).
      return liveProjects.has(t.projectId) || newest.get(t.projectId) !== t.id;
    })
    .map((t) => t.id);
};

/** Claude Code keeps a conversation at `<config>/projects/<slug>/<id>.jsonl`. */
const transcriptPath = (session: ClaudeLiveSession): string | null => {
  const root = NodePath.join(
    session.configDir ?? NodePath.join(NodeOS.homedir(), ".claude"),
    "projects",
  );
  const direct = NodePath.join(root, claudeProjectSlug(session.cwd), `${session.sessionId}.jsonl`);
  if (NodeFS.existsSync(direct)) return direct;
  try {
    for (const dir of NodeFS.readdirSync(root)) {
      const candidate = NodePath.join(root, dir, `${session.sessionId}.jsonl`);
      if (NodeFS.existsSync(candidate)) return candidate;
    }
  } catch {}
  return null;
};

const readRange = (path: string, from: number, to: number): string => {
  const fd = NodeFS.openSync(path, "r");
  try {
    const buffer = Buffer.alloc(Math.max(0, to - from));
    const read = NodeFS.readSync(fd, buffer, 0, buffer.length, from);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    NodeFS.closeSync(fd);
  }
};

const MEDIA_LINE = /^!\[[^\]]*\]\(<([^>]+)>\)$/;

/**
 * Replies in order, each media line dropped when an earlier reply already showed the same file
 * (by content), so threads that repeated one image on every reply read clean. Returns only the
 * replies whose text changed.
 */
export const withoutRepeatedMedia = (
  replies: ReadonlyArray<{ readonly id: string; readonly text: string }>,
  fingerprint: (path: string) => string | null,
): ReadonlyArray<{ readonly id: string; readonly text: string }> => {
  const seen = new Set<string>();
  const changed: Array<{ id: string; text: string }> = [];
  for (const reply of replies) {
    const lines = reply.text.split("\n");
    const kept = lines.filter((line) => {
      const path = MEDIA_LINE.exec(line)?.[1];
      const key = path === undefined ? null : fingerprint(path);
      if (key === null) return true;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    if (kept.length !== lines.length) {
      changed.push({
        id: reply.id,
        text: kept
          .join("\n")
          .replace(/\n{3,}/g, "\n\n")
          .trim(),
      });
    }
  }
  return changed;
};

const MEDIA_TOOL_PATH: Record<string, string> = {
  Read: "file_path",
  Write: "file_path",
  Edit: "file_path",
  MultiEdit: "file_path",
  NotebookEdit: "notebook_path",
};

/**
 * The media a tool call actually handles as a file: Read, Write or Edit of an image or video. A path
 * that only appears in a command or its output (grep, ls, a log) is text, never a file to show.
 */
export const mediaPathsOf = (tool: string, input: unknown): ReadonlyArray<string> => {
  const key = MEDIA_TOOL_PATH[tool];
  const path =
    key !== undefined && typeof input === "object" && input !== null
      ? (input as Record<string, unknown>)[key]
      : undefined;
  if (typeof path !== "string") return [];
  const kind = mediaKindFromPath(path);
  return kind === "image" || kind === "video" ? [path] : [];
};

/** A tool result's images, tagged with the file its call read, so a reply can tell them apart from what the user sent. */
export const toolShots = (
  images: ReadonlyArray<LiveTranscriptImage>,
  call: { readonly name: string; readonly input: unknown } | undefined,
): Array<LiveTranscriptImage> => {
  const source = call === undefined ? undefined : mediaPathsOf(call.name, call.input)[0];
  return images.map((image) => (source === undefined ? image : { ...image, source }));
};

/** What a transcript message shows: a reply takes the screenshots and touched files gathered since the last reply, once. */
export const nextReply = (
  follow: { touched: Set<string>; shots: Array<LiveTranscriptImage> },
  message: LiveTranscriptMessage,
): { readonly message: LiveTranscriptMessage; readonly touched: ReadonlyArray<string> } => {
  if (message.role !== "assistant") return { message, touched: [] };
  const shown =
    follow.shots.length > 0
      ? { ...message, images: [...(message.images ?? []), ...follow.shots] }
      : message;
  follow.shots = [];
  return { message: shown, touched: takeTouched(follow) };
};

/** The files a reply shows are the ones tools touched since the last reply: taken once, so no later reply repeats them. */
export const takeTouched = (follow: { touched: Set<string> }): ReadonlyArray<string> => {
  const taken = [...follow.touched];
  follow.touched = new Set();
  return taken;
};

interface Follow {
  readonly threadId: ThreadId;
  path: string | null;
  offset: number;
  rest: string;
  readonly written: Set<string>;
  /** The session's own name, once a first user message has given it one. */
  name: string | null;
  /** Where assistant messages go: the turn the last user message started (Baton's or T3's). */
  target: RunId | null;
  /** A terminal turn Baton opened that is still running. */
  open: OrchestrationV2Run | null;
  /** Image and video paths the session's own tool calls used since the last user message. */
  touched: Set<string>;
  /** Screenshots tools returned since the last user message; the next reply shows them. */
  shots: Array<LiveTranscriptImage>;
  /** When the newest mirrored message was written: a finished turn ends there, not at "now". */
  lastAt: DateTime.Utc | null;
  /** Since when the session has read idle while a terminal turn is open. */
  idleSince: number | null;
  /** A user message is being worked on (from it until the session has been idle a while). */
  turn: boolean;
  /** What the thread last showed: working or not (null until read). */
  shown: boolean | null;
  checkedAt: number;
  /** The terminal prompt shown in T3 as a question (D88), until it leaves the screen. */
  ask: {
    readonly key: string;
    readonly requestId: RuntimeRequestId;
    readonly itemId: TurnItemId;
    readonly request: OrchestrationV2RuntimeRequest;
    /** When T3 closed it while the same prompt stayed on screen. */
    closedAt: number | null;
  } | null;
  /** The descriptor time and wall time of the last pane read for a question, so an unchanged one is not re-read every tick. */
  promptRead: { readonly updatedAt: string | null; readonly at: number } | null;
  /** Tool calls shown as running, by Claude's tool-use id, until their result arrives. */
  readonly tools: Map<
    string,
    { readonly name: string; readonly input: unknown; readonly at: string }
  >;
}

/**
 * A live thread's Claude Code session holds its own context, so it never takes a T3 context handoff. Each one still
 * ready is marked superseded: delivered to a live session it is either empty or, after a rebind, the whole history,
 * which fails the handoff budget and every turn with it. Returns how many were marked.
 */
export const supersedeLiveHandoffs = (engine: BatonEngineShape, threadId: ThreadId) =>
  Effect.gen(function* () {
    const ready = (yield* engine.contextHandoffs(threadId)).filter((h) => h.status === "ready");
    if (ready.length === 0) return 0;
    const now = yield* DateTime.now;
    yield* engine.writeEvents({
      events: ready.map((handoff) => ({
        id: EventId.make(`${PREFIX}:handoff:${handoff.id}:${DateTime.toEpochMillis(now)}`),
        type: "context-handoff.updated" as const,
        threadId,
        runId: handoff.targetRunId,
        providerInstanceId: LIVE_INSTANCE_ID,
        occurredAt: now,
        payload: { ...handoff, status: "superseded" as const, updatedAt: now },
      })),
    });
    return ready.length;
  }).pipe(Effect.catchCause(() => Effect.succeed(0)));

/** Puts a live thread back on the live instance and/or points it at `sessionId`; the one place a binding is written. */
export const rebindThread = (
  engine: BatonEngineShape,
  input: {
    readonly threadId: ThreadId;
    readonly sessionId: string;
    readonly instance: boolean;
    readonly native: boolean;
    readonly at: number;
  },
) =>
  Effect.gen(function* () {
    if (input.instance) {
      yield* engine.setThreadSelection({
        tag: "live-heal",
        threadId: input.threadId,
        modelSelection: { instanceId: LIVE_INSTANCE_ID, model: MODEL },
      });
    }
    const active = yield* engine.activeProviderThread(input.threadId);
    if (input.native && active !== null) {
      const now = yield* DateTime.now;
      yield* engine.writeEvents({
        events: [
          {
            id: EventId.make(`${PREFIX}:rebind:${input.threadId}:${input.at}`),
            type: "provider-thread.updated",
            threadId: input.threadId,
            driver: DRIVER,
            providerInstanceId: LIVE_INSTANCE_ID,
            occurredAt: now,
            payload: {
              ...active,
              nativeThreadRef: { driver: DRIVER, nativeId: input.sessionId, strength: "strong" },
              updatedAt: now,
            },
          },
        ],
      });
    }
    yield* supersedeLiveHandoffs(engine, input.threadId);
  });

/**
 * A question card belongs to a run: items without one are numbered below every run's, fall outside the window clients
 * load, and the card never shows although its request is pending.
 */
export const askRunId = (
  target: RunId | null,
  runs: ReadonlyArray<{ readonly id: RunId }>,
): RunId | null => target ?? runs.at(-1)?.id ?? null;

const make = Effect.gen(function* () {
  const engine = yield* BatonEngine;
  const weave = yield* BatonWeaveService;
  const settings = yield* ServerSettingsService;
  const { attachmentsDir, stateDir, logsDir } = yield* ServerConfig.ServerConfig;
  // Every mirror decision lands in a file a person can read; the Effect log has no file on a desktop install.
  const seenDecision = new Map<string, string>();
  /** `key` dedupes a record that repeats every tick; a one-off event passes null so the map does not grow. */
  const mirrorLog = (key: string | null, record: Record<string, unknown>) => {
    const text = JSON.stringify(record);
    if (key !== null) {
      if (seenDecision.get(key) === text) return;
      seenDecision.set(key, text);
    }
    appendResumeLog(NodePath.join(logsDir, "baton-mirror.ndjson"), record);
  };

  const follows = new Map<string, Follow>();
  /** Sessions another T3 thread owns, so Baton stays out of them. */
  const owned = new Set<string>();
  /** Ended sessions' threads he has sent a message in: they stay, and are not looked at again. */
  const continued = new Set<ThreadId>();
  const missingSince = new Map<ThreadId, number>();
  // New sessions start one at a time: two in one new folder must not each create its project.
  const starting = yield* Semaphore.make(1);
  /** Threads this run archived because their session ended; one that comes back is unarchived (a thread he archived stays). */
  const endedArchived = new Set<ThreadId>();

  const ensureProviderInstance = Effect.gen(function* () {
    const script = agentScript();
    const node = findNode();
    if (!NodeFS.existsSync(script) || node === null) {
      yield* Effect.logWarning("Tessaya live threads: no agent script or Node, sending is off", {
        script,
        node,
      });
      return;
    }
    const wanted = {
      driver: DRIVER,
      displayName: "Live session",
      enabled: true,
      config: { source: "local", commandPath: node, commandArgs: [script], customModels: [MODEL] },
    };
    const current = (yield* settings.getSettings).providerInstances[LIVE_INSTANCE_ID];
    // @effect-diagnostics-next-line globalJsonInEffect:off - settings values, always serialisable.
    if (JSON.stringify(current) === JSON.stringify(wanted)) return;
    yield* settings.updateProviderInstance({
      operation: "upsert",
      instanceId: LIVE_INSTANCE_ID,
      instance: wanted,
    });
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Tessaya live threads: provider setup failed", cause),
    ),
  );

  const projectFor = (session: ClaudeLiveSession) =>
    Effect.gen(function* () {
      const projects = yield* engine.projects;
      const { key: repositoryRef, label } = yield* projectRefFor(session.cwd);
      const repositoryKey = repositoryRef.startsWith("dir:") ? null : repositoryRef;
      const found = projectForDirectory(session.cwd, projects, repositoryKey);
      if (found !== null) return { projectId: found, projects };
      const created = yield* engine.createProject({
        tag: "live",
        title: label,
        workspaceRoot: session.cwd,
      });
      return { projectId: created, projects: yield* engine.projects };
    });

  const createThread = (session: ClaudeLiveSession, threadId: ThreadId, title: string) =>
    Effect.gen(function* () {
      const { projectId, projects } = yield* projectFor(session);
      if (projectId === null) return;
      const project = projects.find((p) => p.id === projectId);
      const now = yield* DateTime.now;
      const providerThreadId = deriveIds.providerThread({
        driver: DRIVER,
        providerInstanceId: LIVE_INSTANCE_ID,
        nativeThreadId: session.sessionId,
      });
      const root = project?.workspaceRoot ?? session.cwd;
      const appThread: OrchestrationV2AppThread = {
        createdBy: "system",
        creationSource: "server",
        id: threadId,
        projectId,
        title,
        providerInstanceId: LIVE_INSTANCE_ID,
        modelSelection: { instanceId: LIVE_INSTANCE_ID, model: MODEL },
        runtimeMode: DEFAULT_RUNTIME_MODE,
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        branch: null,
        worktreePath: session.cwd === root ? null : session.cwd,
        linkedPullRequest: null,
        branchPullRequest: null,
        activeProviderThreadId: providerThreadId,
        // Runless items are history, the same as upstream's import.
        historyOrigin: "v1_import",
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        unsettledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        activeOrderKey: null,
        lastVisitedAt: null,
        deletedAt: null,
      };
      const providerThread: OrchestrationV2ProviderThread = {
        id: providerThreadId,
        driver: DRIVER,
        providerInstanceId: LIVE_INSTANCE_ID,
        providerSessionId: null,
        appThreadId: threadId,
        ownerNodeId: null,
        nativeThreadRef: { driver: DRIVER, nativeId: session.sessionId, strength: "strong" },
        nativeConversationHeadRef: null,
        status: "idle",
        firstRunOrdinal: null,
        lastRunOrdinal: null,
        handoffIds: [],
        forkedFrom: null,
        pendingBackgroundTasks: [],
        createdAt: now,
        updatedAt: now,
      };
      // No `unlessNativeThreadOwned`: the only other owner of this native id under this instance
      // is a retired mirror thread, which is deleted, not a conversation T3 runs.
      yield* engine.writeEvents({
        events: [
          {
            id: EventId.make(`${PREFIX}:thread:${threadId}:created`),
            type: "thread.created",
            threadId,
            providerInstanceId: LIVE_INSTANCE_ID,
            occurredAt: now,
            payload: appThread,
          },
          {
            id: EventId.make(`${PREFIX}:provider-thread:${providerThreadId}`),
            type: "provider-thread.updated",
            threadId,
            driver: DRIVER,
            providerInstanceId: LIVE_INSTANCE_ID,
            occurredAt: now,
            payload: providerThread,
          },
        ],
      });
    });

  const shownByThread = new Map<string, Set<string>>();
  const shownIn = (threadId: ThreadId) => {
    let shown = shownByThread.get(threadId);
    if (shown === undefined) shownByThread.set(threadId, (shown = new Set()));
    return shown;
  };

  const messageEvents = (
    threadId: ThreadId,
    sessionId: string,
    message: LiveTranscriptMessage,
    runId: RunId | null,
    media?: LiveMedia,
    cwd?: string,
    touched?: ReadonlyArray<string>,
  ): ReadonlyArray<OrchestrationV2DomainEvent> => {
    const key = `${sessionId}:${message.uuid}`;
    const messageId = MessageId.make(`${PREFIX}:${key}`);
    const { text, attachments } =
      media ??
      liveMedia({
        attachmentsDir,
        threadId,
        messageId,
        message,
        ...(cwd ? { cwd } : {}),
        ...(touched ? { touched } : {}),
        shown: shownIn(threadId),
      });
    const at = DateTime.makeUnsafe(message.createdAt);
    const common = {
      id: TurnItemId.make(`${PREFIX}:turn-item:${key}`),
      threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      // The position store replaces this with the next place in the thread.
      ordinal: 1,
      status: "completed" as const,
      title: null,
      startedAt: at,
      completedAt: at,
      updatedAt: at,
    };
    return [
      {
        id: EventId.make(`${PREFIX}:message:${key}`),
        type: "message.updated",
        threadId,
        occurredAt: at,
        payload: {
          createdBy: message.role === "user" ? "user" : "agent",
          creationSource: "server",
          id: messageId,
          threadId,
          runId,
          nodeId: null,
          role: message.role,
          text,
          attachments,
          streaming: false,
          createdAt: at,
          updatedAt: at,
        },
      },
      {
        id: EventId.make(`${PREFIX}:turn-item:${key}`),
        type: "turn-item.updated",
        threadId,
        occurredAt: at,
        payload:
          message.role === "user"
            ? {
                ...common,
                createdBy: "user",
                creationSource: "server",
                type: "user_message",
                messageId,
                inputIntent: "turn_start",
                text,
                attachments,
              }
            : {
                ...common,
                type: "assistant_message",
                messageId,
                text,
                streaming: false,
              },
      },
    ];
  };

  /**
   * A tool step as the turn item upstream's Claude adapter would write for it: `Bash` as a command,
   * anything else as a named tool. A call shows running until its result replaces it in place.
   */
  const toolEvents = (
    follow: Follow,
    sessionId: string,
    step: LiveToolStep,
    runId: RunId | null,
  ): ReadonlyArray<OrchestrationV2DomainEvent> => {
    const call =
      step.kind === "use"
        ? { name: step.name, input: step.input, at: step.createdAt }
        : follow.tools.get(step.id);
    if (call === undefined) return [];
    if (step.kind === "use") follow.tools.set(step.id, call);
    else follow.tools.delete(step.id);
    const done = step.kind === "result";
    const output = done ? step.output.slice(0, MAX_TOOL_OUTPUT_CHARS) : undefined;
    const startedAt = DateTime.makeUnsafe(call.at);
    const at = DateTime.makeUnsafe(step.createdAt);
    const input = (call.input ?? {}) as Record<string, unknown>;
    const id = TurnItemId.make(`${PREFIX}:tool:${sessionId}:${step.id}`);
    const common = {
      id,
      threadId: follow.threadId,
      runId,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: done
        ? step.isError
          ? ("failed" as const)
          : ("completed" as const)
        : ("running" as const),
      title: call.name,
      startedAt,
      completedAt: done ? at : null,
      updatedAt: at,
    };
    return [
      {
        id: EventId.make(`${PREFIX}:tool:${sessionId}:${step.id}:${step.kind}`),
        type: "turn-item.updated",
        threadId: follow.threadId,
        occurredAt: at,
        payload:
          call.name === "Bash" && typeof input["command"] === "string"
            ? {
                ...common,
                type: "command_execution",
                input: input["command"],
                ...(output === undefined ? {} : { output }),
                ...(done && step.isError ? { outputIndicatesFailure: true } : {}),
              }
            : {
                ...common,
                type: "dynamic_tool",
                toolName: call.name,
                input: call.input ?? {},
                ...(output === undefined ? {} : { output }),
              },
      },
    ];
  };

  /** Messages the thread already shows: Baton's own copies, and what T3's composer sent. */
  const threadMessages = (threadId: ThreadId) => engine.threadMessages(threadId, 400);

  const runEvent = (
    type: "run.created" | "run.updated",
    run: OrchestrationV2Run,
  ): OrchestrationV2DomainEvent => ({
    id: EventId.make(`${PREFIX}:${type}:${run.id}:${run.status}:${Date.now()}`),
    type,
    threadId: run.threadId,
    occurredAt: run.completedAt ?? run.startedAt ?? run.requestedAt,
    payload: run,
  });

  const completeRun = (run: OrchestrationV2Run, at: DateTime.Utc): OrchestrationV2Run => ({
    ...run,
    status: "completed",
    completedAt: at,
  });

  /**
   * Transcript messages into the thread. A user message typed in the terminal opens its own turn
   * (a run, so the official apps show it as a turn and the thread as Working while it runs);
   * the copy of a message T3's composer sent is skipped and its replies join that composer turn.
   * Live, a message typed while a terminal turn is still running joins that turn, so the turn
   * ends (and alerts) once, when the session goes idle; history keeps one turn per message.
   */
  const writeMessages = (
    follow: Follow,
    session: ClaudeLiveSession,
    entries: ReadonlyArray<LiveTranscriptMessage | LiveToolStep>,
    history = false,
  ) =>
    Effect.gen(function* () {
      // Tool steps only live: history shows the conversation, not every call it made.
      const fresh = entries.filter((e) => (isStep(e) ? !history : !follow.written.has(e.uuid)));
      if (fresh.length === 0) return;
      const runs = yield* engine.threadRuns(follow.threadId);
      let ordinal = runs.reduce((max, run) => Math.max(max, run.ordinal), 0);
      const latest = runs.reduce<OrchestrationV2Run | null>(
        (best, run) => (best === null || run.ordinal > best.ordinal ? run : best),
        null,
      );
      follow.target ??= latest?.id ?? null;
      const existing = fresh.some((m) => !isStep(m) && m.role === "user")
        ? yield* threadMessages(follow.threadId)
        : [];
      const composerSent = existing.filter(
        (m) => m.role === "user" && !String(m.id).startsWith(`${PREFIX}:`),
      );
      const events: Array<OrchestrationV2DomainEvent> = [];
      // A reply belongs to the newest turn asked for before it: sends typed into a busy session
      // are read by Claude Code together, and its answer follows the last of them.
      const known = [...runs];
      const ownerAt = (iso: string) => {
        const owner = known
          .filter((run) => DateTime.toEpochMillis(run.requestedAt) <= Date.parse(iso))
          .reduce<OrchestrationV2Run | null>(
            (best, run) => (best === null || run.ordinal > best.ordinal ? run : best),
            null,
          );
        if (owner !== null) follow.target = owner.id;
      };
      for (const message of fresh) {
        if (isStep(message)) {
          if (message.kind === "use") {
            for (const path of mediaPathsOf(message.name, message.input)) follow.touched.add(path);
          }
          if (message.kind === "result" && message.images !== undefined) {
            follow.shots.push(...toolShots(message.images, follow.tools.get(message.id)));
            follow.shots.splice(0, Math.max(0, follow.shots.length - MAX_TOOL_SHOTS));
          }
          ownerAt(message.createdAt);
          events.push(...toolEvents(follow, session.sessionId, message, follow.target));
          continue;
        }
        if (message.role === "assistant") ownerAt(message.createdAt);
        follow.written.add(message.uuid);
        if (message.role === "user") {
          follow.touched = new Set();
          follow.shots = [];
        }
        const at = DateTime.makeUnsafe(message.createdAt);
        follow.lastAt = at;
        if (message.role === "user") {
          const echo = composerSent.find(
            (sent) =>
              isComposerEcho(message.text, sent.text, (sent.attachments?.length ?? 0) > 0) &&
              Math.abs(DateTime.toEpochMillis(sent.createdAt) - Date.parse(message.createdAt)) <
                15 * 60_000,
          );
          if (follow.open !== null) {
            events.push(runEvent("run.updated", completeRun(follow.open, at)));
            follow.open = null;
          }
          // Someone asked for something: the session works on it until it is idle again.
          if (!history) {
            follow.turn = true;
            follow.idleSince = null;
          }
          if (echo !== undefined) {
            follow.target = echo.runId ?? latest?.id ?? follow.target;
            continue;
          }
          follow.name ??= message.text.split("\n")[0] ?? null;
          ordinal += 1;
          const run: OrchestrationV2Run = {
            id: RunId.make(`${PREFIX}:run:${session.sessionId}:${message.uuid}`),
            threadId: follow.threadId,
            ordinal,
            providerInstanceId: LIVE_INSTANCE_ID,
            modelSelection: { instanceId: LIVE_INSTANCE_ID, model: MODEL },
            providerThreadId: null,
            userMessageId: MessageId.make(`${PREFIX}:${session.sessionId}:${message.uuid}`),
            rootNodeId: null,
            activeAttemptId: null,
            // Live, the run is the turn's record and ends at once: a running run makes T3 queue
            // every later send. The working state is the provider thread's (see `working`).
            status: history ? "running" : "completed",
            requestedAt: at,
            startedAt: at,
            completedAt: history ? null : at,
            checkpointId: null,
            contextHandoffId: null,
          };
          events.push(runEvent("run.created", run));
          known.push(run);
          if (history) follow.open = run;
          follow.target = run.id;
        }
        const reply = nextReply(follow, message);
        events.push(
          ...messageEvents(
            follow.threadId,
            session.sessionId,
            reply.message,
            follow.target,
            undefined,
            session.cwd,
            reply.touched,
          ),
        );
      }
      if (events.length > 0) yield* engine.writeEvents({ events });
    });

  /**
   * A thread with no turns yet (history mirrored before D83 round 2) gets a finished one around
   * its last user message, so it does not read as waiting on anyone.
   */
  const ensureTurn = (follow: Follow, session: ClaudeLiveSession) =>
    Effect.gen(function* () {
      if ((yield* engine.threadRuns(follow.threadId)).length > 0) return;
      const now = yield* DateTime.now;
      const messages = yield* threadMessages(follow.threadId);
      const lastUser = messages.findLastIndex(
        (m) => m.role === "user" && String(m.id).startsWith(`${PREFIX}:`),
      );
      if (lastUser < 0) return;
      const user = messages[lastUser]!;
      const uuid = String(user.id).slice(String(user.id).lastIndexOf(":") + 1);
      const run: OrchestrationV2Run = {
        id: RunId.make(`${PREFIX}:run:${session.sessionId}:${uuid}`),
        threadId: follow.threadId,
        ordinal: 1,
        providerInstanceId: LIVE_INSTANCE_ID,
        modelSelection: { instanceId: LIVE_INSTANCE_ID, model: MODEL },
        providerThreadId: null,
        userMessageId: user.id,
        rootNodeId: null,
        activeAttemptId: null,
        status: "completed",
        requestedAt: user.createdAt,
        startedAt: user.createdAt,
        completedAt: messages.at(-1)?.createdAt ?? now,
        checkpointId: null,
        contextHandoffId: null,
      };
      // The same messages, now inside the turn (new event ids; message and item ids unchanged).
      const rehomed = messages.slice(lastUser).flatMap((m) =>
        String(m.id).startsWith(`${PREFIX}:`) && (m.role === "user" || m.role === "assistant")
          ? messageEvents(
              follow.threadId,
              session.sessionId,
              {
                uuid: String(m.id).slice(String(m.id).lastIndexOf(":") + 1),
                role: m.role,
                text: m.text,
                createdAt: DateTime.formatIso(m.createdAt),
              },
              run.id,
              { text: m.text, attachments: m.attachments ?? [] },
            ).map((event) => ({ ...event, id: EventId.make(`${event.id}:turn`) }))
          : [],
      );
      yield* engine.writeEvents({ events: [runEvent("run.created", run), ...rehomed] });
      follow.target = run.id;
    });

  /** History's last turn ends at its last message. */
  const closeHistory = (follow: Follow) =>
    Effect.gen(function* () {
      if (follow.open === null) return;
      const done = completeRun(follow.open, follow.lastAt ?? (yield* DateTime.now));
      follow.open = null;
      yield* engine.writeEvents({ events: [runEvent("run.updated", done)] });
    });

  /**
   * Working, the way T3 shows a turn whose agent still has work out: a background task on the
   * provider thread, from a user message until the session has been idle a few seconds. Its
   * runs are already finished, so T3 never queues a send behind it, and T3 sends one "completed"
   * alert when the task clears. Work with no user message (a background agent's report) is not
   * a turn and does not alert. Re-asserted every few seconds: the agent's own runtime rewrites
   * the provider thread when a composer send goes through.
   */
  const working = (follow: Follow, session: ClaudeLiveSession) =>
    Effect.gen(function* () {
      // A question waiting on its answer is part of the turn, not the end of it (D88).
      const busy = session.status === "busy" || session.status === "waiting";
      if (busy) follow.idleSince = null;
      else if (follow.turn) {
        follow.idleSince ??= Date.now();
        if (Date.now() - follow.idleSince >= IDLE_SETTLE_MS) follow.turn = false;
      }
      const want = follow.turn;
      if (want === follow.shown && (!want || Date.now() - follow.checkedAt < RECHECK_MS)) return;
      follow.checkedAt = Date.now();
      const provider = yield* engine.activeProviderThread(follow.threadId);
      if (provider === null) return;
      const others = (provider.pendingBackgroundTasks ?? []).filter(
        (task) => task.taskId !== WORKING_TASK.taskId,
      );
      const has = others.length !== (provider.pendingBackgroundTasks ?? []).length;
      // A changed state is always written: the read can lag the last write, and a skipped clear
      // would leave the thread working (and its alert unsent) for good. A recheck writes only
      // when the task is missing.
      const changed = want !== follow.shown;
      follow.shown = want;
      if (!changed && has === want) return;
      const now = yield* DateTime.now;
      yield* engine.writeEvents({
        events: [
          {
            id: EventId.make(`${PREFIX}:working:${follow.threadId}:${want}:${Date.now()}`),
            type: "provider-thread.updated",
            threadId: follow.threadId,
            driver: provider.driver,
            providerInstanceId: provider.providerInstanceId,
            occurredAt: now,
            payload: {
              ...provider,
              pendingBackgroundTasks: want ? [...others, WORKING_TASK] : others,
              updatedAt: now,
            },
          },
        ],
      });
      if (!want) yield* engine.resumeQueue({ tag: "live", threadId: follow.threadId });
    });

  /**
   * Question cards of earlier presentations (one per card and per server start) stay pending in the projection and keep
   * the thread's Input tag on. Expire every pending mirror ask of the thread except the one on screen now.
   */
  const sweptAsks = new Set<string>();
  const expireOtherAsks = (follow: Follow, keepId: string | null) =>
    Effect.gen(function* () {
      const pending = yield* engine.pendingRuntimeRequests(follow.threadId);
      const stale = new Set(staleAskIds(pending, `${PREFIX}:ask:`, keepId));
      if (stale.size === 0) return;
      const now = yield* DateTime.now;
      for (const request of pending.filter((r) => stale.has(r.id))) {
        const item = yield* engine.turnItem(follow.threadId, TurnItemId.make(String(request.id)));
        yield* engine.writeEvents({
          events: [
            {
              id: EventId.make(`${request.id}:expired`),
              type: "runtime-request.updated",
              threadId: follow.threadId,
              occurredAt: now,
              payload: { ...request, status: "expired", resolvedAt: now },
            },
            ...(item === null
              ? []
              : [
                  {
                    id: EventId.make(`${request.id}:closed`),
                    type: "turn-item.updated" as const,
                    threadId: follow.threadId,
                    occurredAt: now,
                    payload: {
                      ...item,
                      status: "completed" as const,
                      completedAt: now,
                      updatedAt: now,
                    },
                  },
                ]),
          ],
        });
      }
      mirrorLog(`expired:${follow.threadId}:${[...stale].join(",")}`, {
        event: "asks-expired",
        thread: String(follow.threadId),
        requests: [...stale],
      });
    });

  /**
   * D88: a question or approval showing in a waiting session's pane becomes a T3 question with
   * its options as buttons. T3 sends the answer back as a message ("message" response mode), and
   * the agent turns it into the keystrokes. The question closes when it leaves the screen.
   */
  const relayPrompt = (follow: Follow, session: ClaudeLiveSession) =>
    Effect.gen(function* () {
      // Reading a pane spawns node and herdr: while the question shown is still up and the descriptor has not
      // changed, read again only every PROMPT_REREAD_MS (a multi-part form can move on without a descriptor write).
      const nowMs = Date.now();
      if (
        session.status === "waiting" &&
        follow.ask !== null &&
        follow.promptRead !== null &&
        follow.promptRead.updatedAt === session.updatedAt &&
        nowMs - follow.promptRead.at < PROMPT_REREAD_MS
      )
        return;
      follow.promptRead =
        session.status === "waiting" ? { updatedAt: session.updatedAt, at: nowMs } : null;
      const read =
        session.status === "waiting" && session.herdrPane !== null
          ? yield* readPanePrompt(session.herdrPane)
          : null;
      // Waiting with nothing readable to show is still a question in the thread (not "waiting" and silence).
      const found =
        read !== null && read.options.length > 0
          ? read
          : session.status === "waiting"
            ? unreadPrompt(
                session,
                session.herdrPane === null ? "" : yield* readPaneScreen(session.herdrPane),
              )
            : null;
      mirrorLog(`prompt:${session.sessionId}`, {
        event: "prompt",
        sessionId: session.sessionId,
        status: session.status,
        pane: session.herdrPane,
        readable: read !== null && read.options.length > 0,
        shown: found?.key ?? null,
      });
      if (
        follow.ask !== null &&
        follow.ask.key === found?.key &&
        keepAsk(
          follow.ask,
          (yield* engine.runtimeRequestStatus(follow.threadId, follow.ask.requestId)) === "pending",
          nowMs,
        )
      )
        return;
      const now = yield* DateTime.now;
      if (follow.ask !== null) {
        const open = follow.ask;
        follow.ask = null;
        // Answered in T3, the request is resolved already; answered in the terminal, it expires.
        if ((yield* engine.runtimeRequestStatus(follow.threadId, open.requestId)) === "pending") {
          const item = yield* engine.turnItem(follow.threadId, open.itemId);
          yield* engine.writeEvents({
            events: [
              {
                id: EventId.make(`${open.requestId}:expired`),
                type: "runtime-request.updated",
                threadId: follow.threadId,
                occurredAt: now,
                payload: { ...open.request, status: "expired", resolvedAt: now },
              },
              ...(item === null
                ? []
                : [
                    {
                      id: EventId.make(`${open.itemId}:closed`),
                      type: "turn-item.updated" as const,
                      threadId: follow.threadId,
                      occurredAt: now,
                      payload: {
                        ...item,
                        status: "completed" as const,
                        completedAt: now,
                        updatedAt: now,
                      },
                    },
                  ]),
            ],
          });
        }
      }
      // Once per thread per server start, and whenever the card on screen changes: older pending cards go.
      if (!sweptAsks.has(String(follow.threadId))) {
        sweptAsks.add(String(follow.threadId));
        yield* expireOtherAsks(follow, null);
      }
      if (found === null || found.options.length === 0) return;
      const stamp = Date.now();
      const requestId = RuntimeRequestId.make(`${PREFIX}:ask:${session.sessionId}:${stamp}`);
      const itemId = TurnItemId.make(`${PREFIX}:ask:${session.sessionId}:${stamp}`);
      const nodeId = NodeId.make(`${PREFIX}:ask:${session.sessionId}:${stamp}`);
      // A tabbed form shows its other questions too, from the transcript's exact text; the pane question stays last
      // because T3 sends the answer back keyed by it.
      const overview =
        found.header !== null && follow.path !== null
          ? formOverview(
              pendingAskQuestions(
                (() => {
                  try {
                    const size = NodeFS.statSync(follow.path).size;
                    return readRange(follow.path, Math.max(0, size - 300_000), size);
                  } catch {
                    return "";
                  }
                })(),
              ),
            ).slice(0, 900)
          : "";
      const request = {
        id: requestId,
        nodeId,
        providerTurnId: null,
        nativeRequestRef: null,
        kind: "user_input" as const,
        status: "pending" as const,
        responseCapability: { type: "message" as const },
        createdAt: now,
        resolvedAt: null,
      };
      yield* expireOtherAsks(follow, String(requestId));
      follow.ask = { key: found.key, requestId, itemId, request, closedAt: null };
      const askRun = askRunId(follow.target, yield* engine.threadRuns(follow.threadId));
      yield* engine.writeEvents({
        events: [
          {
            id: EventId.make(`${requestId}:item`),
            type: "turn-item.updated",
            threadId: follow.threadId,
            occurredAt: now,
            payload: {
              id: itemId,
              threadId: follow.threadId,
              runId: askRun,
              nodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "waiting",
              title: found.header ?? "In the terminal",
              startedAt: now,
              completedAt: null,
              updatedAt: now,
              type: "user_input_request",
              requestId,
              responseMode: "message",
              questions: [askQuestion(found, overview)],
            },
          },
          {
            id: EventId.make(`${requestId}:pending`),
            type: "runtime-request.updated",
            threadId: follow.threadId,
            occurredAt: now,
            payload: request,
          },
        ],
      });
    });

  /** Keep the session's own title, with its account and box; T3's auto-title does not stick. */
  const retitle = (follow: Follow, session: ClaudeLiveSession) =>
    Effect.gen(function* () {
      const shell = yield* engine.threadShell(follow.threadId);
      if (shell === null) return;
      const wanted = mirrorTitle({
        current: shell.title,
        regenerating: shell.titleRegeneration != null,
        sessionName: session.name,
        nameFromUser: session.nameSource === "user",
        followName: follow.name,
        account: session.account,
        box: box(),
      });
      if (wanted !== null) {
        yield* engine.renameThread({ tag: "live", threadId: follow.threadId, title: wanted });
      }
    });

  const startFollowing = (session: ClaudeLiveSession) =>
    Effect.gen(function* () {
      const threadId = liveThreadId(session.sessionId);
      const path = transcriptPath(session);
      const size = path === null ? 0 : NodeFS.statSync(path).size;
      // Long tool-heavy sessions hold few messages per megabyte: read back until there are enough.
      let from = size;
      let history: Array<LiveTranscriptMessage> = [];
      while (
        path !== null &&
        from > 0 &&
        history.length < FIRST_MESSAGES &&
        size - from < MAX_BACKFILL_BYTES
      ) {
        from = Math.max(0, from - FIRST_READ_BYTES);
        const chunk = readRange(path, from, size);
        // A read from the middle of the file starts mid-record; the first line is dropped.
        const lines = splitTranscriptChunk(chunk).lines.slice(from > 0 ? 1 : 0);
        history = lines.flatMap((line) => parseLiveTranscriptLine(line) ?? []);
      }
      history = history.slice(-FIRST_MESSAGES);
      const shell = yield* engine.threadShell(threadId);
      if (shell !== null && shell.archivedAt !== null && endedArchived.delete(threadId)) {
        yield* engine.unarchiveThread({ tag: "live", threadId });
        mirrorLog(`unarchived:${threadId}`, { event: "unarchived-back", thread: String(threadId) });
      }
      if (shell === null) {
        const firstUser = history.find((m) => m.role === "user")?.text.split("\n")[0];
        yield* createThread(
          session,
          threadId,
          liveThreadTitle({
            name: session.name ?? firstUser ?? "Live session",
            account: session.account,
            box: box(),
          }),
        );
        if ((yield* engine.threadShell(threadId)) === null) {
          owned.add(session.sessionId); // another thread holds this native session
          return;
        }
      }
      const mirrored = (yield* threadMessages(threadId)).filter((m) =>
        String(m.id).startsWith(`${PREFIX}:`),
      );
      const known = new Set(
        mirrored.map((m) => String(m.id).slice(String(m.id).lastIndexOf(":") + 1)),
      );
      // Threads that repeated one image on every reply are cleaned once, here.
      const cleaned = withoutRepeatedMedia(
        mirrored
          .filter((m) => m.role === "assistant")
          .map((m) => ({ id: String(m.id), text: m.text })),
        (path) => {
          try {
            return NodeCrypto.createHash("sha256").update(NodeFS.readFileSync(path)).digest("hex");
          } catch {
            return null;
          }
        },
      );
      if (cleaned.length > 0) {
        yield* engine.writeEvents({
          events: cleaned.flatMap((fix) => {
            const old = mirrored.find((m) => String(m.id) === fix.id)!;
            return messageEvents(
              threadId,
              session.sessionId,
              {
                uuid: fix.id.slice(fix.id.lastIndexOf(":") + 1),
                role: "assistant",
                text: fix.text,
                createdAt: DateTime.formatIso(old.createdAt),
              },
              old.runId ?? null,
              { text: fix.text, attachments: old.attachments ?? [] },
            ).map((event) => ({ ...event, id: EventId.make(`${event.id}:dedupe`) }));
          }),
        });
      }
      // An existing thread only takes what is newer than its newest message: anything older
      // written now would sort after it.
      const newest = mirrored.reduce(
        (max, m) => Math.max(max, DateTime.toEpochMillis(m.createdAt)),
        Number.NEGATIVE_INFINITY,
      );
      if (shell !== null) history = history.filter((m) => Date.parse(m.createdAt) > newest);
      const follow: Follow = {
        threadId,
        path,
        offset: size,
        rest: "",
        written: known,
        name: history.find((m) => m.role === "user")?.text.split("\n")[0] ?? null,
        target: null,
        open: null,
        touched: new Set<string>(),
        shots: [],
        lastAt: null,
        idleSince: null,
        // A session busy when Baton starts is taken to be working on something.
        turn: session.status === "busy",
        shown: null,
        checkedAt: 0,
        ask: null,
        promptRead: null,
        tools: new Map(),
      };
      follows.set(session.sessionId, follow);
      // A running session is never filed away for age. Settling it by hand is the per-thread mute
      // (T3's relay sends no alert for a settled thread), so Baton leaves that alone.
      yield* engine.keepActive({ tag: "live", threadId, settled: false });
      // What the thread lacks from the transcript's tail: all of it the first time, and after a
      // restart whatever arrived while the server was down. History turns are finished turns.
      yield* writeMessages(follow, session, history, true);
      yield* closeHistory(follow);
      yield* ensureTurn(follow, session);
      yield* working(follow, session);
    });

  const step = (session: ClaudeLiveSession, follow: Follow) =>
    Effect.gen(function* () {
      follow.path ??= transcriptPath(session);
      if (follow.path === null) return;
      const size = NodeFS.statSync(follow.path).size;
      if (size < follow.offset) {
        follow.offset = 0; // rewritten: read it again; uuids keep it idempotent
        follow.rest = "";
      }
      if (size === follow.offset) return;
      const to = Math.min(size, follow.offset + STEP_BYTES);
      const { lines, rest } = splitTranscriptChunk(
        follow.rest + readRange(follow.path, follow.offset, to),
      );
      follow.offset = to;
      follow.rest = rest;
      yield* writeMessages(
        follow,
        session,
        lines.flatMap((line) => [
          ...parseLiveToolSteps(line),
          ...[parseLiveTranscriptLine(line)].filter((m) => m !== null),
        ]),
      );
    });

  /** Delete the retired namespace's threads once, so each session has one thread. */
  const retireOld = Effect.gen(function* () {
    for (const shell of yield* engine.threadShells) {
      if (RETIRED_PREFIXES.some((prefix) => String(shell.id).startsWith(prefix))) {
        yield* engine.deleteThread({ tag: "live", threadId: shell.id });
      }
    }
  });

  /**
   * Every 30 s, per followed session: if the thread is not bound to the session it mirrors (moved to a handoff provider,
   * or left without its session) and that session is running, bind it again and say so in baton-mirror.ndjson.
   */
  const lastHeal = new Map<string, number>();
  const healBinding = (follow: Follow, session: ClaudeLiveSession) =>
    Effect.gen(function* () {
      const nowMs = Date.now();
      if (nowMs - (lastHeal.get(session.sessionId) ?? 0) < 30_000) return;
      lastHeal.set(session.sessionId, nowMs);
      const shell = yield* engine.threadShell(follow.threadId);
      if (shell === null) return;
      const active = yield* engine.activeProviderThread(follow.threadId);
      const action = decideBinding({
        threadId: String(follow.threadId),
        sessionId: session.sessionId,
        session: { status: session.status, pane: session.herdrPane },
        thread: {
          instanceId: String(shell.providerInstanceId),
          nativeId: active?.nativeThreadRef?.nativeId ?? null,
          running: shell.activeRunId !== null && shell.activeRunId !== undefined,
        },
      });
      if (action.kind === "ok" || action.kind === "no-session" || action.kind === "wait") return;
      yield* rebindThread(engine, {
        threadId: follow.threadId,
        sessionId: session.sessionId,
        instance: action.kind === "rebind-instance",
        native: action.kind === "rebind-native",
        at: nowMs,
      });
      mirrorLog(null, {
        event: "rebound",
        sessionId: session.sessionId,
        thread: String(follow.threadId),
        action: action.kind,
        pane: session.herdrPane,
      });
    });

  /** Kept unbound messages go back through their thread once it is on its running session again. */
  const retryKept = (live: ReadonlyArray<ClaudeLiveSession>) =>
    Effect.gen(function* () {
      for (const threadId of new Set(
        (yield* weave.unbound).flatMap((row) => (row.thread === null ? [] : [row.thread])),
      )) {
        const sessionId = sessionOfThread(threadId);
        const session = live.find((s) => s.sessionId === sessionId);
        if (sessionId === null || session === undefined || session.herdrPane === null) continue;
        const shell = yield* engine.threadShell(ThreadId.make(threadId));
        if (shell === null) continue;
        const native = (yield* engine.activeProviderThread(shell.id))?.nativeThreadRef?.nativeId;
        const bound = shell.providerInstanceId === LIVE_INSTANCE_ID && native === sessionId;
        const result = yield* resendKept(engine, weave, { threadId, bound });
        if (result.sent > 0)
          mirrorLog(null, {
            event: "kept-resent",
            thread: threadId,
          });
      }
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Tessaya live threads: kept retry failed", cause),
      ),
    );

  const tick = Effect.gen(function* () {
    const live = yield* readAllProfileLiveSessions();
    // Before any heal rewrites a thread's native id, so kept messages still find their thread.
    yield* stampKept(engine, weave).pipe(Effect.ignoreCause);
    mirrorLog("live-set", {
      event: "live-sessions",
      sessions: live
        .map((s) => `${s.sessionId}:${s.status ?? "?"}:${s.herdrPane ?? "no-pane"}`)
        .sort(),
    });
    for (const s of live) {
      mirrorLog(`decision:${s.sessionId}`, {
        event: "decision",
        sessionId: s.sessionId,
        thread: String(liveThreadId(s.sessionId)),
        decision: owned.has(s.sessionId)
          ? "skip-owned"
          : follows.has(s.sessionId)
            ? "following"
            : "starting",
        status: s.status,
        pane: s.herdrPane,
      });
    }
    const fresh = live.filter((s) => !follows.has(s.sessionId) && !owned.has(s.sessionId));
    if (fresh.length > 0) {
      // A session upstream's importer copied is a snapshot, not the live conversation: the live
      // thread replaces it, and an import nobody continued (no turns) is archived (reversible).
      // An import someone continued in T3 is T3's own thread now, so Baton stays out of it.
      const shells = yield* engine.threadShells;
      for (const session of fresh) {
        const imported = shells.find(
          (t) =>
            String(t.id).startsWith("import:") && String(t.id).endsWith(`:${session.sessionId}`),
        );
        if (imported === undefined) continue;
        if (imported.latestRunId !== null) owned.add(session.sessionId);
        else yield* engine.archiveThread({ tag: "live", threadId: imported.id });
      }
    }
    // A thread whose session has ended leaves the list (archived, reversible) unless he sent a
    // message from T3: then it is his conversation now.
    const liveIds = new Set(live.map((s) => s.sessionId));
    const open = yield* engine.threadShells;
    forgetUnarchived(endedArchived, open);
    for (const id of endedMirrorThreads(open, liveIds, missingSince, Date.now())) {
      if (continued.has(id)) continue;
      if (sentFromT3(yield* threadMessages(id))) continued.add(id);
      else if (yield* engine.archiveThread({ tag: "live", threadId: id })) {
        endedArchived.add(id);
        mirrorLog(`archived:${id}`, { event: "archived-ended", thread: String(id) });
      }
    }
    for (const [sessionId, follow] of follows) {
      if (!liveIds.has(sessionId) && !continued.has(follow.threadId)) follows.delete(sessionId);
    }
    yield* Effect.forEach(
      live.filter((s) => !owned.has(s.sessionId)),
      (session) => {
        const follow = follows.get(session.sessionId);
        return (
          follow === undefined
            ? starting.withPermits(1)(startFollowing(session))
            : step(session, follow).pipe(
                Effect.andThen(working(follow, session)),
                Effect.andThen(relayPrompt(follow, session)),
                Effect.andThen(healBinding(follow, session)),
                Effect.andThen(retitle(follow, session)),
              )
        ).pipe(
          // One hung pane read must not hold up every other session's mirror.
          Effect.timeout(SESSION_STEP_TIMEOUT),
          Effect.catchCause((cause) =>
            Effect.logWarning("Tessaya live threads: a session could not be mirrored", {
              sessionId: session.sessionId,
              cause,
            }).pipe(
              Effect.tap(() =>
                Effect.sync(() =>
                  mirrorLog(`failed:${session.sessionId}`, {
                    event: "mirror-failed",
                    sessionId: session.sessionId,
                    cause: String(cause).slice(0, 600),
                  }),
                ),
              ),
              // Start over from the thread's own state next tick rather than guess.
              Effect.tap(() => Effect.sync(() => follows.delete(session.sessionId))),
            ),
          ),
        );
      },
      { discard: true, concurrency: 4 },
    );
    yield* retryKept(live);
  });

  /** Once per install (a marker in the state dir), so threads he unarchives later stay. */
  const sweep = Effect.gen(function* () {
    const marker = NodePath.join(stateDir, "baton-thread-sweep.done");
    if (NodeFS.existsSync(marker)) return;
    const shells = yield* engine.threadShells;
    const victims = sweepVictims({
      shells,
      projects: yield* engine.projects,
      liveSessions: yield* readAllProfileLiveSessions(),
    });
    let archived = 0;
    for (const threadId of victims) {
      if (yield* engine.archiveThread({ tag: "sweep", threadId })) archived += 1;
    }
    yield* Effect.logInfo(`thread sweep: open ${shells.length} -> ${shells.length - archived}`);
    if (archived === victims.length) NodeFS.writeFileSync(marker, new Date().toISOString());
  });

  if (!liveThreadsEnabled()) return;
  yield* ensureProviderInstance;
  yield* sweep.pipe(
    Effect.catchCause((cause) => Effect.logWarning("Tessaya thread sweep failed", cause)),
  );
  yield* retireOld.pipe(
    Effect.catchCause((cause) => Effect.logWarning("Tessaya live threads: retiring failed", cause)),
  );
  // Once per start: handoffs left ready on live threads by earlier rebinds (they fail every turn's budget).
  for (const shell of yield* engine.threadShells) {
    if (shell.providerInstanceId !== LIVE_INSTANCE_ID) continue;
    const cleared = yield* supersedeLiveHandoffs(engine, shell.id);
    if (cleared > 0)
      mirrorLog(null, { event: "handoffs-superseded", thread: String(shell.id), count: cleared });
  }
  yield* tick.pipe(
    Effect.catchCause((cause) => Effect.logWarning("Tessaya live threads: tick failed", cause)),
    Effect.repeat(Schedule.spaced(TICK)),
    Effect.forkScoped,
  );
});

export const layer = Layer.effectDiscard(make);

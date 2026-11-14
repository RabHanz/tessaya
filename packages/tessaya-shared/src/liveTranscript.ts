/* oxlint-disable t3code/no-low-value-comments -- Baton file (D82) */
// @effect-diagnostics globalDate:off
/**
 * Reading a live Claude Code transcript as conversation messages (D83).
 *
 * The same rule upstream's agent-session import uses (`AgentSessionScanner`): user and assistant
 * records that are not side chains, meta or compact summaries, keeping their text blocks, the
 * images a user pasted, and the files the session sent with `SendUserFile`. A tool result is a
 * `user` record with no text or image block of its own, so it is not a message. Each record carries
 * Claude Code's own `uuid`, which is what makes mirroring it twice a no-op.
 *
 * @module baton/liveTranscript
 */

/** An image the user pasted, as Claude Code recorded it (base64). */
export interface LiveTranscriptImage {
  readonly mimeType: string;
  readonly data: string;
  /** For a tool's image block: the file the call read, when it read one. */
  readonly source?: string;
}

export interface LiveTranscriptMessage {
  readonly uuid: string;
  readonly role: "user" | "assistant";
  readonly text: string;
  readonly createdAt: string;
  /** User records: pasted images. */
  readonly images?: ReadonlyArray<LiveTranscriptImage>;
  /** Assistant records: the paths the session sent to the user (`SendUserFile`). */
  readonly files?: ReadonlyArray<string>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const imagesOf = (content: unknown): Array<LiveTranscriptImage> =>
  Array.isArray(content)
    ? content.flatMap((block) => {
        if (!isRecord(block) || block["type"] !== "image" || !isRecord(block["source"])) return [];
        const source = block["source"];
        const mimeType = source["media_type"];
        const data = source["data"];
        return source["type"] === "base64" &&
          typeof mimeType === "string" &&
          mimeType.startsWith("image/") &&
          typeof data === "string" &&
          data.length > 0
          ? [{ mimeType, data }]
          : [];
      })
    : [];

/** `SendUserFile` calls: the files and the caption the session showed the user. */
const sentFilesOf = (content: unknown): { files: Array<string>; caption: string } => {
  const files: Array<string> = [];
  const captions: Array<string> = [];
  if (Array.isArray(content)) {
    for (const block of content) {
      if (!isRecord(block) || block["type"] !== "tool_use" || block["name"] !== "SendUserFile")
        continue;
      const input = isRecord(block["input"]) ? block["input"] : {};
      const listed = Array.isArray(input["files"]) ? input["files"] : [];
      files.push(...listed.filter((f): f is string => typeof f === "string" && f.length > 0));
      if (typeof input["caption"] === "string" && input["caption"].trim().length > 0)
        captions.push(input["caption"].trim());
    }
  }
  return { files, caption: captions.join("\n") };
};

/** Claude Code's project folder for a directory: every non-alphanumeric becomes `-`. */
export const claudeProjectSlug = (cwd: string): string => cwd.replace(/[^A-Za-z0-9]/g, "-");

const textOf = (content: unknown): string => {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      typeof block === "object" &&
      block !== null &&
      (block as { type?: unknown }).type === "text" &&
      typeof (block as { text?: unknown }).text === "string"
        ? [((block as { text: string }).text ?? "").trim()]
        : [],
    )
    .filter((text) => text.length > 0)
    .join("\n");
};

/**
 * A T3 inbox or attachment path as a short label: the file's own name, or "image, 11:13" for the
 * old generated names (a timestamp, the thread id and a uuid). The full path stays on disk.
 */
export const labelAttachmentPaths = (text: string): string =>
  text
    .replace(/(?:^|\n)He attached (?:image|file) [^\n]*:\n(?=@\/)/g, "\n")
    .replace(/@\/\S*\/(?:\.baton\/inbox|attachments)\/(\S+)/g, (_, rest: string) => {
      const name = rest.slice(rest.lastIndexOf("/") + 1);
      const old = /^\d{4}-\d\d-\d\dT(\d\d)-(\d\d)-\d\d-\d+Z-.*?(\.[A-Za-z0-9]+)?$/.exec(name);
      if (old === null) return `\u{1F4CE} ${name}`;
      const image = /^\.(png|jpe?g|gif|webp|heic)$/i.test(old[3] ?? "");
      return `\u{1F4CE} ${image ? "image" : "file"}, ${old[1]}:${old[2]}`;
    })
    .trim();

/**
 * What T3's own send path wraps around a user's words on the way into the terminal: a pasted-content
 * tag, an `[Image: name; ref=...]` marker, the `<t3_context>` block and trailing `@/path` lines.
 * The user's own words are what is left.
 */
export const stripT3Wrappers = (text: string): string =>
  text
    .replace(/<t3_context\b[\s\S]*?(?:<\/t3_context>|$)/g, "")
    .replace(/<\/?pasted_content\b[^>]*>/g, "")
    .replace(/\[Image:[^\]]*\]/g, "")
    // The composer records a pasted image as a markdown token; the transcript carries the picture as a block, not text.
    .replace(/!\[[^\]]*\]\(t3-context:\/\/[^)\s]*\)/g, "")
    .replace(/\n?He attached (?:image|file) [^\n]*:\s*@\/\S+/g, "")
    .replace(/(?:\s+@\/\S+)+\s*$/, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

const CLAUDE_INTERNAL_USER_TEXT =
  /^<(task-notification|local-command-[a-z]+|command-(name|message|args)|system-reminder|bash-(input|stdout|stderr)|user-memory-input)>/;

/** One transcript line, or null when it is not a message a person would read. */
export const parseLiveTranscriptLine = (line: string): LiveTranscriptMessage | null => {
  if (line.trim().length === 0) return null;
  let record: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return null;
    record = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  const type = record["type"];
  if (type !== "user" && type !== "assistant") return null;
  if (record["isSidechain"] === true || record["isMeta"] === true) return null;
  if (record["isCompactSummary"] === true) return null;
  const uuid = record["uuid"];
  if (typeof uuid !== "string" || uuid.length === 0) return null;
  const message = record["message"];
  const content = isRecord(message) ? message["content"] : undefined;
  const images = type === "user" ? imagesOf(content) : [];
  const sent = type === "assistant" ? sentFilesOf(content) : { files: [], caption: "" };
  const raw = textOf(content);
  const words = labelAttachmentPaths(type === "user" ? stripT3Wrappers(raw) : raw);
  const text = words.length > 0 ? words : sent.caption;
  if (text.length === 0 && images.length === 0 && sent.files.length === 0) return null;
  // Claude Code's own plumbing recorded as user turns: background-task notices, slash-command
  // echoes, local command output, reminders. Not something a person typed.
  if (type === "user" && CLAUDE_INTERNAL_USER_TEXT.test(text)) return null;
  const timestamp = record["timestamp"];
  return {
    uuid,
    role: type,
    text,
    createdAt:
      typeof timestamp === "string" && !Number.isNaN(Date.parse(timestamp))
        ? new Date(timestamp).toISOString()
        : new Date(0).toISOString(),
    ...(images.length > 0 ? { images } : {}),
    ...(sent.files.length > 0 ? { files: sent.files } : {}),
  };
};

/**
 * Split a chunk read from the transcript into whole lines and the unfinished tail. Claude Code
 * appends one JSON record per line; a read can land mid-record, and that part waits for the next.
 */
export const splitTranscriptChunk = (
  chunk: string,
): { readonly lines: ReadonlyArray<string>; readonly rest: string } => {
  const end = chunk.lastIndexOf("\n");
  if (end < 0) return { lines: [], rest: chunk };
  return { lines: chunk.slice(0, end).split("\n"), rest: chunk.slice(end + 1) };
};

const normalize = (text: string): string => text.replace(/\s+/g, " ").trim();

/**
 * Whether a transcript user message is the one a T3 composer already put in the thread. Baton's
 * agent types the composer text and may add `@path` lines for attachments, so the transcript
 * copy starts with what T3 recorded.
 */
export const isComposerEcho = (
  transcriptText: string,
  composerText: string,
  /** The composer message carried pictures: with no words either side, the pictures are what match. */
  composerHasPictures = false,
): boolean => {
  const sent = normalize(stripT3Wrappers(composerText));
  const heard = normalize(stripT3Wrappers(transcriptText));
  return sent.length > 0 ? heard.startsWith(sent) : composerHasPictures && heard.length === 0;
};

/** A tool call the session made, or its result, as Claude Code wrote it (D85). */
export type LiveToolStep =
  | {
      readonly kind: "use";
      readonly id: string;
      readonly name: string;
      readonly input: unknown;
      readonly createdAt: string;
    }
  | {
      readonly kind: "result";
      readonly id: string;
      readonly output: string;
      readonly isError: boolean;
      readonly createdAt: string;
      /** Screenshots a tool returned inline (an MCP browser or screen tool), base64. */
      readonly images?: ReadonlyArray<LiveTranscriptImage>;
    };

const resultText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((block) =>
            isRecord(block) && block["type"] === "text" && typeof block["text"] === "string"
              ? block["text"]
              : isRecord(block) && block["type"] === "image"
                ? "[image]"
                : "",
          )
          .filter((text) => text.length > 0)
          .join("\n")
      : "";

/**
 * The tool steps in one transcript line. Claude Code writes each call when the model emits it and
 * each result when the tool returns, so these arrive while a turn is still running. `SendUserFile`
 * is left out: it is shown as the message that carries the files.
 */
export const parseLiveToolSteps = (line: string): ReadonlyArray<LiveToolStep> => {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return [];
  }
  if (!isRecord(record) || record["isSidechain"] === true) return [];
  const type = record["type"];
  const message = record["message"];
  const content = isRecord(message) ? message["content"] : undefined;
  if (!Array.isArray(content)) return [];
  const timestamp = record["timestamp"];
  const createdAt =
    typeof timestamp === "string" && !Number.isNaN(Date.parse(timestamp))
      ? new Date(timestamp).toISOString()
      : new Date().toISOString();
  return content.flatMap((block): Array<LiveToolStep> => {
    if (!isRecord(block) || typeof (block["id"] ?? block["tool_use_id"]) !== "string") return [];
    if (type === "assistant" && block["type"] === "tool_use" && typeof block["name"] === "string") {
      if (block["name"] === "SendUserFile") return [];
      return [
        {
          kind: "use",
          id: block["id"] as string,
          name: block["name"],
          input: block["input"],
          createdAt,
        },
      ];
    }
    if (type === "user" && block["type"] === "tool_result") {
      const images = imagesOf(block["content"]);
      return [
        {
          kind: "result",
          id: block["tool_use_id"] as string,
          output: resultText(block["content"]),
          isError: block["is_error"] === true,
          createdAt,
          ...(images.length > 0 ? { images } : {}),
        },
      ];
    }
    return [];
  });
};

/**
 * The usage limit a terminal session last stopped on, from its transcript's tail: Claude writes the 429 as an assistant
 * line with `isApiErrorMessage` ("You've hit your weekly limit · resets …"). Null once anything later was said.
 */
export const liveLimitHit = (
  tail: string,
): { readonly text: string; readonly at: string } | null => {
  const lines = tail.split("\n");
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(lines[i]!) as Record<string, unknown>;
    } catch {
      continue; // the tail's first line is usually cut
    }
    if (entry["type"] !== "assistant" && entry["type"] !== "user") continue;
    if (entry["isApiErrorMessage"] !== true) return null;
    const content = (entry["message"] as { content?: unknown } | undefined)?.content;
    const text = Array.isArray(content)
      ? content
          .map((part) => (part as { text?: unknown }).text)
          .filter((part): part is string => typeof part === "string")
          .join(" ")
      : "";
    const limited =
      entry["error"] === "rate_limit" ||
      entry["apiErrorStatus"] === 429 ||
      /\b(usage|weekly|session) limit\b|hit your (\w+ )?limit/i.test(text);
    return limited
      ? { text: text.trim() || "Usage limit reached.", at: String(entry["timestamp"] ?? "") }
      : null;
  }
  return null;
};

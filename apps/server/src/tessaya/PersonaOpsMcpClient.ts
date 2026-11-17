// @effect-diagnostics globalJsonInEffect:off preferSchemaOverJson:off globalFetch:off
/**
 * One MCP Streamable HTTP connection to the ops system, as one worker: every request carries the worker's token and id
 * in headers. The session opens on the first call and is reused; one the server has forgotten (404) is reopened once,
 * and any other failure throws so the caller drops the connection and the next call opens a new one. Nothing here logs
 * the token.
 */

export interface PersonaOpsEndpoint {
  readonly url: string;
  /** The header that names the calling worker. */
  readonly workerHeader: string;
}

/** A `tools/call` answer: the ops system's JSON (its data on success, its error object on a refusal). */
export interface PersonaOpsToolResult {
  readonly isError: boolean;
  readonly data: unknown;
}

const PROTOCOL_VERSION = "2025-06-18";
const CALL_TIMEOUT_MS = 30_000;

interface RpcMessage {
  readonly id?: unknown;
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

/** The JSON-RPC answer to `id`: a JSON body, or the event carrying it in a server-sent stream. */
const answerOf = (contentType: string, body: string, id: number): RpcMessage | null => {
  const messages: unknown[] = contentType.includes("text/event-stream")
    ? body.split(/\r?\n\r?\n/).flatMap((event) => {
        const data = event
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\n");
        try {
          return data === "" ? [] : [JSON.parse(data)];
        } catch {
          return [];
        }
      })
    : [JSON.parse(body)];
  const found = messages.flat().find((m) => (m as RpcMessage | null)?.id === id);
  return (found as RpcMessage | undefined) ?? null;
};

export class PersonaOpsConnection {
  private session: Promise<{ id: string | null; version: string }> | null = null;
  private nextId = 1;

  private readonly endpoint: PersonaOpsEndpoint;
  private readonly workerId: string;
  private readonly token: string;

  constructor(endpoint: PersonaOpsEndpoint, workerId: string, token: string) {
    this.endpoint = endpoint;
    this.workerId = workerId;
    this.token = token;
  }

  get open(): boolean {
    return this.session !== null;
  }

  async callTool(
    name: string,
    args: Readonly<Record<string, unknown>>,
  ): Promise<PersonaOpsToolResult> {
    let answer = await this.request("tools/call", { name, arguments: args });
    if (answer === "gone") {
      this.session = null;
      answer = await this.request("tools/call", { name, arguments: args });
      if (answer === "gone") throw new Error("The ops system keeps forgetting the session.");
    }
    // A JSON-RPC error (an unknown tool, bad arguments) is the ops system's answer, not a broken connection.
    if (answer.error !== undefined)
      return {
        isError: true,
        data: { code: answer.error.code ?? null, message: answer.error.message ?? "refused" },
      };
    const result = (answer.result ?? {}) as {
      readonly content?: ReadonlyArray<{ readonly type: string; readonly text?: string }>;
      readonly structuredContent?: unknown;
      readonly isError?: boolean;
    };
    const text = result.content?.find((c) => c.type === "text")?.text;
    let data: unknown = result.structuredContent;
    if (data === undefined && text !== undefined) {
      try {
        data = JSON.parse(text);
      } catch {
        data = { message: text };
      }
    }
    return { isError: result.isError === true, data: data ?? null };
  }

  close(): void {
    this.session = null;
  }

  private post(
    body: object,
    session: { id: string | null; version: string } | null,
  ): Promise<Response> {
    return fetch(this.endpoint.url, {
      method: "POST",
      headers: {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        authorization: `Bearer ${this.token}`,
        [this.endpoint.workerHeader]: this.workerId,
        ...(session === null ? {} : { "mcp-protocol-version": session.version }),
        ...(session?.id == null ? {} : { "mcp-session-id": session.id }),
      },
      body: JSON.stringify({ jsonrpc: "2.0", ...body }),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    }).catch((e: unknown) => {
      throw new Error(
        e instanceof Error && e.name === "TimeoutError"
          ? "The ops system did not answer in time."
          : `The ops system could not be reached (${e instanceof Error ? e.message : String(e)})`,
      );
    });
  }

  /** The server's own words for a refused request, never echoing what was sent. */
  private static async refusal(response: Response): Promise<Error> {
    const body = (await response.text().catch(() => "")).trim();
    let message = body;
    try {
      const parsed = JSON.parse(body) as {
        error?: { message?: string } | string;
        message?: string;
      };
      message =
        (typeof parsed.error === "object" ? parsed.error.message : parsed.error) ??
        parsed.message ??
        body;
    } catch {
      // not JSON: keep the text
    }
    return new Error(
      `The ops system refused the connection (HTTP ${response.status}${message === "" ? "" : `: ${message.slice(0, 200)}`})`,
    );
  }

  private connect(): Promise<{ id: string | null; version: string }> {
    if (this.session !== null) return this.session;
    const id = this.nextId++;
    const opening = (async () => {
      const response = await this.post(
        {
          id,
          method: "initialize",
          params: {
            protocolVersion: PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: "tessaya-brain", version: "1" },
          },
        },
        null,
      );
      if (!response.ok) throw await PersonaOpsConnection.refusal(response);
      const answer = answerOf(
        response.headers.get("content-type") ?? "",
        await response.text(),
        id,
      );
      if (answer === null || answer.error !== undefined)
        throw new Error(answer?.error?.message ?? "The ops system did not finish the handshake.");
      const session = {
        id: response.headers.get("mcp-session-id"),
        version:
          (answer.result as { protocolVersion?: string } | undefined)?.protocolVersion ??
          PROTOCOL_VERSION,
      };
      const initialized = await this.post({ method: "notifications/initialized" }, session);
      await initialized.body?.cancel();
      return session;
    })();
    this.session = opening;
    opening.catch(() => {
      if (this.session === opening) this.session = null;
    });
    return opening;
  }

  private async request(method: string, params: object): Promise<RpcMessage | "gone"> {
    const session = await this.connect();
    const id = this.nextId++;
    const response = await this.post({ id, method, params }, session);
    if (response.status === 404 && session.id !== null) return "gone";
    if (!response.ok) throw await PersonaOpsConnection.refusal(response);
    const answer = answerOf(response.headers.get("content-type") ?? "", await response.text(), id);
    if (answer === null) throw new Error("The ops system answered something else.");
    return answer;
  }
}

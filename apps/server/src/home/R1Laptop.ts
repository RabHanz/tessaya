/**
 * The R1 asking his laptop: his words go to a linked environment's Tessaya through its /mcp `tessaya_ask`, as a
 * device's words, so she reads his agents quietly and asks him there before she looks at the screen or acts.
 * shortcut: the first linked server whose Tessaya takes the ask wins; with two desktops linked, pick by name.
 */
import { BAR_NOT_CONNECTED } from "@t3tools/baton-shared/phoneRelay";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as PeerLinks from "../peer/PeerLinks.ts";
import * as PeerMcpClient from "../peer/PeerMcpClient.ts";

const AskResult = Schema.Struct({
  id: Schema.NullOr(Schema.String),
  status: Schema.String,
  line: Schema.String,
});

const NOT_LINKED = "your laptop isn't linked to this server, so I can't see it.";
const OFFLINE = "your laptop isn't answering right now.";
const NOT_OPEN = "Tessaya isn't open on your laptop, so I can't see it.";
const STILL_WAITING = "I've asked your laptop. It's still on it, or waiting for your yes there.";
/** The R1 turn is spoken: past this the room hears where it stands rather than silence. */
const WAIT_MS = 30_000;
const POLL_MS = 2_000;

interface LaptopOutcome {
  readonly ok: boolean;
  /** "told": `line` is the laptop's own answer, to be spoken as it is. */
  readonly status: "told" | "failed";
  readonly line: string;
}

const failed = (line: string): LaptopOutcome => ({ ok: false, status: "failed", line });

export const askLaptop = Effect.fn("R1Laptop.ask")(function* (question: string) {
  const links = yield* Effect.serviceOption(PeerLinks.PeerLinks);
  const mcp = yield* Effect.serviceOption(PeerMcpClient.PeerMcpClient);
  if (links._tag === "None" || mcp._tag === "None" || !(yield* links.value.enabled))
    return failed(NOT_LINKED);
  const linked = (yield* links.value.list.pipe(Effect.orElseSucceed(() => []))).filter(
    (l) => l.status !== "expired",
  );
  if (linked.length === 0) return failed(NOT_LINKED);
  const text = `Asked aloud at his desk device at home; answer in one or two spoken sentences: ${question}`;
  let why = OFFLINE;
  for (const link of linked) {
    const call = (tool: string, args: Record<string, unknown>) =>
      mcp.value
        .call({
          environmentId: link.environmentId,
          tool,
          arguments: args,
          limits: { runtimeMode: "approval-required", interactionMode: "default" },
          success: AskResult,
        })
        .pipe(Effect.timeout("15 seconds"), Effect.result);
    const asked = yield* call("tessaya_ask", { text });
    if (asked._tag === "Failure") {
      // A link refused for its access says why; anything else is a laptop that is away.
      const error = asked.failure;
      if ("code" in error && error.code === "capability_denied") why = error.message;
      continue;
    }
    if (asked.success.id === null) {
      why = asked.success.line === BAR_NOT_CONNECTED ? NOT_OPEN : asked.success.line;
      continue;
    }
    for (let waited = 0; ; waited += POLL_MS) {
      const now = yield* call("tessaya_ask_status", { id: asked.success.id });
      if (now._tag === "Success") {
        if (now.success.status === "answered")
          return { ok: true, status: "told", line: now.success.line } satisfies LaptopOutcome;
        if (["failed", "expired", "unknown"].includes(now.success.status))
          return failed(now.success.line);
      }
      if (waited >= WAIT_MS)
        return { ok: true, status: "told", line: STILL_WAITING } satisfies LaptopOutcome;
      yield* Effect.sleep(POLL_MS);
    }
  }
  return failed(why);
});

// @effect-diagnostics globalConsole:off
/** D69 live proof: restart one Herdr-hosted Claude session in place, same conversation. */
import * as Effect from "effect/Effect";

import { respawnClaudeInPane } from "../src/tessaya/HerdrRespawn.ts";

const [paneRef, sessionId] = process.argv.slice(2);
if (paneRef === undefined || sessionId === undefined)
  throw new Error("usage: <paneRef> <sessionId>");
console.log(await Effect.runPromise(respawnClaudeInPane({ paneRef, sessionId })));

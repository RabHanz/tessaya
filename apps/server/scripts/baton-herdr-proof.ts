/* oxlint-disable t3code/no-low-value-comments -- Baton file predating upstream's rule (D82) */
/**
 * Phase 8's exit criterion, taken against a real Herdr.
 *
 * > A Claude/Codex/Hermes CLI running persistently in Herdr can appear in the
 * > Baton fleet and be surfaced/controlled with declared capability limits.
 *
 * Everything here is real except the database, which is in memory so the proof
 * leaves nothing behind: the live `HerdrAdapterLive` shelling out to the
 * installed `herdr` binary, the real `AdoptedSessionService`, real work session
 * ids, real capability gates. Nothing is stubbed and nothing is registered by
 * hand — the session it adopts is whatever Herdr reports.
 *
 * Run it where Herdr is installed and a server is up:
 *
 *     node apps/server/scripts/baton-herdr-proof.ts
 *
 * On a machine without Herdr it prints the refusal by name and exits 0: that is
 * a correct answer, and the one this phase could prove before the binary
 * existed.
 */
import { WorkSessionId, type AdoptedSessionId } from "@t3tools/tessaya-contracts";
import { describeAdoptedSession, HERDR_CAPABILITIES } from "@t3tools/tessaya-shared/adoptedSession";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import {
  AdoptedSessionService,
  layer as adoptedSessionLayer,
} from "../src/tessaya/AdoptedSessionService.ts";
import { layer as herdrAdapterLayer } from "../src/tessaya/HerdrAdapterLive.ts";
import { layerMemory as SqlitePersistenceMemory } from "../src/tessaya/TessayaDatabase.ts";

const line = (text = ""): void => {
  process.stdout.write(`${text}\n`);
};

const workSessionId = WorkSessionId.make("ws-herdr-proof");

const programme = Effect.gen(function* () {
  const adopted = yield* AdoptedSessionService;

  line("=== 1. discover: what does the real runtime report? ===");
  const discovery = yield* adopted.discover;
  line(`available=${discovery.available} candidates=${discovery.candidates.length}`);
  if (!discovery.available) {
    line(`  reason: ${discovery.reason}`);
    line("");
    line("That is the refusal by name. Nothing further can be proven here.");
    return;
  }
  for (const candidate of discovery.candidates) {
    line(
      `  ${candidate.location.workspace}/${candidate.location.pane}  ` +
        `state=${candidate.state ?? "UNMAPPED"} runtimeState=${candidate.runtimeState} ` +
        `agent=${candidate.agentKind ?? "none"}  ${candidate.label}`,
    );
  }

  // The busiest candidate, because a terminal doing something is the one worth
  // proving. Falls back to the first.
  const target =
    discovery.candidates.find((candidate) => candidate.state === "monitoring") ??
    discovery.candidates.find((candidate) => candidate.state === "working") ??
    discovery.candidates[0];
  if (target === undefined) {
    line("no candidates to adopt");
    return;
  }

  line("");
  line("=== 2. adopt it, and attach it to a work session ===");
  const session = yield* adopted.register({
    id: `herdr:${target.location.pane}` as AdoptedSessionId,
    runtime: "herdr",
    label: target.label,
    location: target.location,
    agentKind: target.agentKind,
    runtimeState: target.runtimeState,
    foreground: target.foreground ?? null,
    workSessionId,
    capabilities: HERDR_CAPABILITIES,
  });
  line(`adopted ${session.id}`);
  line(`  state=${session.state}  workSession=${session.workSessionId ?? "none"}`);
  line(`  ${describeAdoptedSession({ ...session, host: session.location.host })}`);

  line("");
  line("=== 3. the fleet for that work session ===");
  const fleet = yield* adopted.forWorkSession(workSessionId);
  for (const entry of fleet) {
    line(`  ${entry.label}: ${entry.state}  (adopted from ${entry.runtime})`);
  }

  line("");
  line("=== 4. declared capability limits ===");
  for (const [capability, allowed] of Object.entries(session.capabilities)) {
    line(`  ${allowed ? "may  " : "MAY NOT"} ${capability}`);
  }

  line("");
  line("=== 5. read its output, gated on showTerminal ===");
  const output = yield* adopted.readOutput({ id: session.id, lines: 6 });
  line(`available=${output.available}${output.detail === "" ? "" : ` detail=${output.detail}`}`);
  for (const text of output.output.trimEnd().split("\n").slice(-6)) {
    line(`  | ${text}`);
  }

  line("");
  line("=== 6. a capability the runtime did not claim is refused by name ===");
  const released = yield* adopted.detach(session.id);
  line(`released at ${released.detachedAt ?? "?"}`);
  const afterRelease = yield* Effect.result(
    adopted.sendInput({ id: session.id, text: "status", submit: false }),
  );
  if (afterRelease._tag === "Failure") {
    line("sendInput after release: refused");
    line(`  ${String(afterRelease.failure)}`);
  } else {
    line(`sendInput after release: delivered=${afterRelease.success.delivered}`);
    line(`  ${afterRelease.success.detail}`);
  }
});

const layer = adoptedSessionLayer.pipe(
  Layer.provide(herdrAdapterLayer),
  Layer.provide(SqlitePersistenceMemory),
);

await Effect.runPromise(programme.pipe(Effect.provide(layer)));

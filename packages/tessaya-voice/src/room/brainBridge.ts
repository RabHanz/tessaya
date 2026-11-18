/**
 * The room loop's two links to a brain on another host (`R1_HUB_URL` set): her reports copied from her hub to the
 * brain's, and the brain's turn acts taken from its hub, in order on one connection. One copy for the loop and the
 * topology gate (topologyGate.ts), so the gate tests what the loop runs.
 */
import { connectMqtt } from "@t3tools/tessaya-shared/mqtt";

import { fromBrainHub, relayToBrain, toBrainHub } from "./roomVoice.ts";

export const connectBrainBridge = (input: {
  /** Her own hub, and the loop's login there. */
  readonly hub: string;
  readonly hubLogin: { readonly user?: string; readonly pass?: string };
  /** The hub of the server that runs her turns. */
  readonly brain: string;
  readonly brainLogin: { readonly user: string; readonly pass?: string };
  readonly clientSuffix: string;
  /** Whether a Tessel is online on her hub: only then does this loop take the brain's acts for her. */
  readonly here: (device: string) => boolean;
  /** One of the brain's acts for a Tessel here, as if it was heard on her hub. */
  readonly deliver: (topic: string, payload: Buffer) => void;
  readonly log: (line: string) => void;
}) => {
  const brainHub = connectMqtt({
    url: input.brain,
    clientId: `tessaya-room-bridge-${input.clientSuffix}`,
    ...input.brainLogin,
    subscribe: [
      "freya/r1/+/voice/intent/eye",
      "freya/r1/+/voice/intent/rest",
      "freya/r1/+/voice/stepup",
      "freya/r1/+/voice/say",
      "freya/r1/+/voice/ask",
      "freya/r1/+/voice/persona",
    ],
    onMessage: (t, p) => {
      const to = /^freya\/r1\/([^/]+)\/(.+)$/.exec(t);
      if (to !== null && fromBrainHub(to[2]!, input.here(to[1]!))) input.deliver(t, p);
    },
    log: input.log,
  });
  const relay = connectMqtt({
    url: input.hub,
    clientId: `tessaya-room-relay-${input.clientSuffix}`,
    ...input.hubLogin,
    subscribe: ["freya/r1/+/state/#", "freya/r1/+/event/#"],
    onMessage: (t, p) => {
      const tail = /^freya\/r1\/[^/]+\/(.+)$/.exec(t)?.[1];
      const how = tail === undefined ? null : relayToBrain(tail);
      if (how !== null) brainHub.publish(t, p, how === "retain");
    },
    log: input.log,
  });
  return {
    /** What the loop itself publishes on her hub that the brain waits on (a step-up's ack). */
    answer: (topic: string, payload: Uint8Array | string) => {
      const tail = /^freya\/r1\/[^/]+\/(.+)$/.exec(topic)?.[1];
      if (tail !== undefined && toBrainHub(tail)) brainHub.publish(topic, payload);
    },
    connected: () => brainHub.connected() && relay.connected(),
    close: () => {
      brainHub.close();
      relay.close();
    },
  };
};

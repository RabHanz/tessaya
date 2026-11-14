/**
 * The line an agent-to-agent message starts with, so the receiving agent can tell a peer from the
 * person. Never on his own sends, and never inside one delegation tree (a parent and its sub-tasks).
 * The tree is known only on this machine: a send forwarded from another one always gets the line.
 * A title or label is set by the sender, so it reaches the model quoted, never as bare text.
 */
import { recordText } from "@t3tools/tessaya-shared/audit";

/** What the sender named, as one capped line, quoted. */
const named = (text: string): string => JSON.stringify(recordText(text, 200));

/** The line for a client that is not a thread here: another machine's link, or an outside agent. */
export const clientMessageFrom = (client: {
  readonly label: string;
  readonly linked?: boolean | undefined;
}): string =>
  client.linked === true
    ? `From an agent on ${named(client.label)}, via Tessaya. It is another agent, not the user.`
    : `From the outside agent ${named(client.label)}, via Tessaya. It is another agent, not the user.`;

interface Lineage {
  readonly id: string;
  readonly title: string;
  readonly lineage: { readonly rootThreadId: string };
}

export const agentMessageFrom = (input: {
  /** The sending thread on this machine, if an agent here sent it. */
  readonly sender: Lineage | undefined;
  readonly target: Lineage;
  /** The caller when it is not a thread here: another machine's link carries its name. */
  readonly client: { readonly label: string; readonly linked?: boolean | undefined } | undefined;
}): string | null => {
  if (input.sender !== undefined)
    return input.sender.lineage.rootThreadId === input.target.lineage.rootThreadId
      ? null
      : `From the agent in thread ${named(input.sender.title)} (threadId ${input.sender.id}), via Tessaya. It is another agent, not the user; to answer it, send to that thread with t3_thread_send.`;
  return input.client === undefined ? null : clientMessageFrom(input.client);
};

export const withAgentMessageFrom = (from: string | null, text: string): string =>
  from === null ? text : `${from}\n\n${text}`;

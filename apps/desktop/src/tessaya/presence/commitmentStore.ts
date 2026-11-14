// @effect-diagnostics nodeBuiltinImport:off
/** The commitments on disk, one JSON file in Tessaya's state folder, written whole and renamed into place. */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  addCommitment,
  closeCommitment,
  describeCommitments,
  pruneCommitments,
  type Commitment,
  type CommitmentInput,
} from "@t3tools/tessaya-shared/commitments";

const isCommitment = (v: unknown): v is Commitment =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as Commitment).id === "string" &&
  typeof (v as Commitment).text === "string" &&
  ["open", "done", "dropped"].includes((v as Commitment).status);

export const createCommitmentStore = (
  dir: string,
  now: () => number = Date.now,
  newId: () => string = () => NodeCrypto.randomUUID().slice(0, 8),
  /** Called after every write, so a server copy can follow. */
  onChange: () => void = () => undefined,
) => {
  const file = NodePath.join(dir, "commitments.json");
  const read = (): ReadonlyArray<Commitment> => {
    let text: string;
    try {
      text = NodeFS.readFileSync(file, "utf8");
    } catch {
      return [];
    }
    try {
      const parsed: unknown = JSON.parse(text);
      return Array.isArray(parsed) ? parsed.filter(isCommitment) : [];
    } catch {
      // A damaged file is kept aside, not overwritten, so nothing he asked for is lost silently.
      NodeFS.renameSync(file, `${file}.bad`);
      return [];
    }
  };
  const write = (list: ReadonlyArray<Commitment>): void => {
    NodeFS.mkdirSync(dir, { recursive: true });
    const tmp = `${file}.tmp`;
    NodeFS.writeFileSync(tmp, JSON.stringify(pruneCommitments(list, now()), null, 2));
    NodeFS.renameSync(tmp, file);
    onChange();
  };
  return {
    list: read,
    /** The merged list from the server sync replaces the file. */
    replace: write,
    add: (input: CommitmentInput): Commitment => {
      const before = read();
      const id = newId();
      const next = addCommitment(before, input, now(), id);
      write(next);
      const text = input.text.replace(/\s+/g, " ").trim().toLowerCase();
      return (
        next.find((c) => c.id === id) ??
        next.find((c) => c.status === "open" && c.text.toLowerCase() === text)!
      );
    },
    close: (id: string, status: "done" | "dropped"): void =>
      write(closeCommitment(read(), id, status, now())),
    describe: (includeClosed = false): string => describeCommitments(read(), now(), includeClosed),
  };
};
export type CommitmentStore = ReturnType<typeof createCommitmentStore>;

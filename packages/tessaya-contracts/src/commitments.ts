/**
 * The commitments ledger over the wire (D149): what he asked Tessaya to keep track of, shared by
 * his devices. The rules live in `@t3tools/tessaya-shared/commitments`; the server only keeps rows and
 * never lets an open copy reopen a closed one.
 */
import * as Schema from "effect/Schema";

export const BATON_COMMITMENT_WS_METHODS = {
  list: "baton.commitments.list",
  upsert: "baton.commitments.upsert",
} as const;

export const TessayaCommitment = Schema.Struct({
  id: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  text: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(300)),
  owner: Schema.Literals(["tessaya", "you"]),
  due: Schema.NullOr(Schema.Number),
  status: Schema.Literals(["open", "done", "dropped"]),
  source: Schema.Literals(["voice", "assistant", "offer"]),
  createdAt: Schema.Number,
  updatedAt: Schema.optionalKey(Schema.Number),
  closedAt: Schema.optionalKey(Schema.Number),
  ref: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
});
export type TessayaCommitment = typeof TessayaCommitment.Type;

export const TessayaCommitmentListResult = Schema.Struct({
  items: Schema.Array(TessayaCommitment),
});
export const TessayaCommitmentUpsertInput = Schema.Struct({
  items: Schema.Array(TessayaCommitment).check(Schema.isMaxLength(500)),
});
export const TessayaCommitmentUpsertResult = Schema.Struct({ applied: Schema.Number });
export const TessayaCommitmentListInput = Schema.Struct({});

export class TessayaCommitmentError extends Schema.TaggedError<TessayaCommitmentError>()(
  "BatonCommitmentError",
  { reason: Schema.String },
) {
  override get message(): string {
    return this.reason;
  }
}

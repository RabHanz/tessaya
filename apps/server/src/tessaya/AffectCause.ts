import * as Context from "effect/Context";

/**
 * The event an affect change comes from (a turn, a desk touch, a Tessel being handled), set by whoever notes it. Each
 * change to a person's relationship is kept against it, so "that wasn't me" moves it (`TessayaMood.reassign`).
 * `assumed`: the person was assumed (the desk's owner for a touch there), not identified.
 */
export const AffectCause = Context.Reference<{
  readonly ref: string;
  readonly vessel?: string;
  readonly assumed?: boolean;
} | null>("t3/tessaya/AffectCause", { defaultValue: () => null });

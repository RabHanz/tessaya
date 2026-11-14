import * as Schema from "effect/Schema";
import * as SchemaTransformation from "effect/SchemaTransformation";

/**
 * Rename R1: a stored or wire literal also decodes from its Tessaya spelling, to the old one this build still
 * writes and compares, so what the next build writes (or a rollback reads) still decodes.
 */
export const alsoReads = <const Old extends string, const New extends string>(
  old: Old,
  renamed: New,
) =>
  Schema.Literals([old, renamed]).pipe(
    Schema.decodeTo(
      Schema.Literal(old),
      SchemaTransformation.transform<Old, Old | New>({
        decode: () => old,
        encode: (value) => value,
      }),
    ),
  );

export type TessayaSpelling<Old extends string> = Old extends `${"fabric" | "baton"}.${infer Rest}`
  ? `tessaya.${Rest}`
  : never;

export const tessayaSpelling = <const Old extends string>(old: Old) =>
  old.replace(/^(fabric|baton)\./, "tessaya.") as TessayaSpelling<Old>;

/** An event `kind` (`fabric.x.y`) that also decodes from `tessaya.x.y`. */
export const renamedKind = <const Old extends `${"fabric" | "baton"}.${string}`>(old: Old) =>
  alsoReads(old, tessayaSpelling(old));

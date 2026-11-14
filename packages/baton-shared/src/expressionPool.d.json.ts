// Its 400 KB literal type is never inferred: inferring it degraded checks far away (main red, 14 Nov).
declare const pool: Readonly<
  Record<string, Readonly<Record<string, ReadonlyArray<{ readonly text: string }>>>>
>;
export default pool;

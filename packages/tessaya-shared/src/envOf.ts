/**
 * A setting by its `TESSAYA_` name, else its old `BATON_` one; `env` defaults to this process's (Node only). Drop the old
 * names once no systemd unit, workflow or `.env` on any box sets them.
 */
export const envOf = (
  name: string,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined => env[`TESSAYA_${name}`] ?? env[`BATON_${name}`];

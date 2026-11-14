/**
 * The room loop's settings are renamed `TESSEL_*`; the old `R1_*` names still work, and the new one wins when both are
 * set. Drop the old names once every voice host's env file and the server's loop plan say `TESSEL_`.
 */
export const adoptTesselNames = (env: Record<string, string | undefined>): void => {
  for (const [key, value] of Object.entries(env))
    if (key.startsWith("TESSEL_") && value !== undefined)
      env[`R1_${key.slice("TESSEL_".length)}`] = value;
};

type Env = Record<string, string | undefined>;

/** TESSAYA_X wins over BATON_X: copies it over the BATON_ name that the code still reads. Returns the BATON_ names still set alone. */
export function adoptTessayaEnv(
  env: Env,
  note: (message: string) => void = console.warn,
): string[] {
  const legacy: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (key.startsWith("TESSAYA_") && value !== undefined) env[`BATON_${key.slice(8)}`] = value;
  }
  for (const key of Object.keys(env)) {
    if (key.startsWith("BATON_") && env[`TESSAYA_${key.slice(6)}`] === undefined) legacy.push(key);
  }
  if (legacy.length > 0 && env["TESSAYA_ENV_NOTED"] === undefined) {
    env["TESSAYA_ENV_NOTED"] = "1";
    note(
      `tessaya: still reading old env names: ${legacy.join(" ")} (set the TESSAYA_ name instead; the old one keeps working)`,
    );
  }
  return legacy;
}

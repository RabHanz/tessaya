import type { CastBody, TessayaPersona } from "@t3tools/tessaya-contracts";

/** Who a Tessel answers as (the persona Cast says it wears, else the lead) and that persona's voice, in one line. */
export const deviceVoiceLine = (
  personas: ReadonlyArray<TessayaPersona>,
  bodies: ReadonlyArray<Pick<CastBody, "id" | "wearing">>,
  deviceId: string,
): string | null => {
  const wearing = bodies.find((b) => b.id === deviceId)?.wearing ?? null;
  const persona =
    personas.find((p) => p.id === wearing) ?? personas.find((p) => p.lead) ?? personas[0];
  if (persona === undefined) return null;
  const voice =
    persona.cloneVoice !== undefined
      ? "your saved clone"
      : `the voice ${persona.cloudVoice ?? persona.voice}`;
  return `${persona.name}, speaking with ${voice}.`;
};

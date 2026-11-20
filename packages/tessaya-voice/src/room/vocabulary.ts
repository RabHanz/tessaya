import { parseVocabulary, type VocabularyEntry } from "@t3tools/tessaya-shared/vocabulary";

/** How often the room asks her server for his dictionary again; retained MQTT can replace this later. */
export const VOCABULARY_EVERY_MS = 5 * 60_000;

/**
 * His one dictionary, and the words he writes himself, from her server on the R1's device key (`GET …/vocabulary`, ONE-EAR-AUDIT §7a), so the room
 * spells his words the way dictation does. Null when the server is older or unreachable: the loop keeps what it has.
 */
export const servedVocabulary = async (
  url: string,
  key: string,
  get: typeof fetch = fetch,
): Promise<{
  readonly entries: ReadonlyArray<VocabularyEntry>;
  /** Words he writes himself, which the name rule leaves alone; empty from a server older than the list. */
  readonly ordinary: ReadonlySet<string>;
} | null> => {
  try {
    const res = await get(url.replace(/\/chat\/completions$/, "/vocabulary"), {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { entries?: unknown; ordinary?: unknown } | null;
    if (!Array.isArray(body?.entries)) return null;
    const ordinary = Array.isArray(body.ordinary)
      ? body.ordinary.filter((w): w is string => typeof w === "string")
      : [];
    return { entries: parseVocabulary(body.entries), ordinary: new Set(ordinary) };
  } catch {
    return null;
  }
};

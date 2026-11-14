// @effect-diagnostics nodeBuiltinImport:off globalFetch:off
/**
 * Her trained wake words on the desktop (SPINE-UNIFY §10, P3c): every persona's word that her home server trained and
 * signed is fetched as the desktop's model, checked against her signature (an unsigned or altered model is refused,
 * never written) and added to his wake words. His own threshold for a word he already has stays his.
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { fetchSignedWake, type WakeWordView } from "@t3tools/baton-shared/wakeModels";

import { wakeModelFile, type WakeWordSetting } from "./desktopVoiceCore.ts";

/** This machine's server with the desktop's token: it answers from her home server when there is one. */
export interface WakeServer {
  readonly server: string;
  readonly authorization: string;
}

const SIGNED_FILE = "wake-signed.json";

const readSigned = (dir: string): Record<string, number> => {
  try {
    const v = JSON.parse(NodeFS.readFileSync(NodePath.join(dir, SIGNED_FILE), "utf8")) as unknown;
    return typeof v === "object" && v !== null ? (v as Record<string, number>) : {};
  } catch {
    return {};
  }
};

/** Her wake record (every persona's word), or null when her server did not answer. */
export const wakeStatus = async (
  at: WakeServer,
  get: typeof fetch = fetch,
): Promise<ReadonlyArray<WakeWordView> | null> => {
  const r = await get(new URL("/api/tessaya/wake/status", at.server), {
    headers: { authorization: at.authorization },
  }).catch(() => null);
  const body = r?.ok === true ? ((await r.json().catch(() => null)) as unknown) : null;
  return Array.isArray(body) ? (body as ReadonlyArray<WakeWordView>) : null;
};

/**
 * Fetches each trained, signed word's desktop model into `dir`. Returns his wake words with any new word added (null
 * when unchanged), whether a model file changed (the wake loop must reload), and the words refused.
 */
export const syncWakeModels = async (input: {
  readonly at: WakeServer;
  readonly dir: string;
  readonly status: ReadonlyArray<WakeWordView>;
  readonly words: ReadonlyArray<WakeWordSetting>;
  readonly fetch?: typeof fetch;
}): Promise<{
  readonly words: ReadonlyArray<WakeWordSetting> | null;
  readonly reload: boolean;
  readonly refused: ReadonlyArray<string>;
}> => {
  const signed = readSigned(input.dir);
  const added: WakeWordSetting[] = [];
  const refused: string[] = [];
  let reload = false;
  for (const w of input.status) {
    if (w.shipped || w.current === null) continue;
    const got = await fetchSignedWake({
      ...input.at,
      word: w.word,
      target: "desktop",
      have: signed[w.word] ?? null,
      ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    }).catch(() => null);
    // Only the openWakeWord family loads here; any other format waits for the desktop to learn it.
    if (got === null || (got !== "current" && got.format !== "openwakeword-onnx")) {
      refused.push(w.word);
      continue;
    }
    if (got !== "current") {
      NodeFS.mkdirSync(input.dir, { recursive: true });
      const file = NodePath.join(input.dir, wakeModelFile(w.word));
      NodeFS.writeFileSync(`${file}.tmp`, got.bytes);
      NodeFS.renameSync(`${file}.tmp`, file);
      signed[w.word] = got.version;
      reload = true;
    }
    if (!input.words.some((x) => x.word.toLowerCase() === w.word))
      added.push({
        word: w.word.charAt(0).toUpperCase() + w.word.slice(1),
        enabled: true,
        threshold: got === "current" ? 0.95 : got.threshold,
      });
  }
  if (reload)
    NodeFS.writeFileSync(NodePath.join(input.dir, SIGNED_FILE), `${JSON.stringify(signed)}\n`);
  return { words: added.length === 0 ? null : [...input.words, ...added], reload, refused };
};

/** One persona's word as Settings says it: whether it wakes her, the version, and why the last try failed. */
export const wakeLine = (w: WakeWordView): string => {
  const last = w.versions.at(-1);
  const current = w.versions.find((v) => v.version === w.current);
  const state = w.cancelled
    ? "training stopped"
    : w.model === "training"
      ? "training now"
      : w.current !== null
        ? `version ${w.current}${current?.provisional === true ? " (provisional)" : ""}`
        : w.shipped
          ? "built in"
          : "no model yet";
  return last !== undefined && last.status !== "trained" && last.reason !== null
    ? `${state}; version ${last.version} ${last.status}: ${last.reason}`
    : state;
};

/** The version a rollback goes to: the newest kept, signed version before the current one. */
export const rollbackTarget = (w: WakeWordView): number | null =>
  w.versions
    .filter((v) => v.signed && w.current !== null && v.version < w.current)
    .map((v) => v.version)
    .at(-1) ?? null;

/** A change to one word (rollback, cancel, retrain): null when done, else why not. */
export const wakeChange = async (at: WakeServer, path: string, body: unknown) => {
  const r = await fetch(new URL(`/api/tessaya/wake/${path}`, at.server), {
    method: "POST",
    headers: { authorization: at.authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (r.ok) return null;
  const said = (await r.json().catch(() => ({}))) as { message?: unknown };
  return typeof said.message === "string" ? said.message : "That did not work.";
};

/** A member's read lines for wake training; her server keeps them only while their switch is on. */
export const sendEnrolment = (at: WakeServer, personId: string, clips: ReadonlyArray<Int16Array>) =>
  fetch(new URL("/api/tessaya/wake/enrolment", at.server), {
    method: "POST",
    headers: { authorization: at.authorization, "content-type": "application/json" },
    body: JSON.stringify(enrolmentBody(personId, clips)),
  });

/** Base64 enrolment clips under the server's limit (4 MB a request), most first. */
const enrolmentBody = (personId: string, clips: ReadonlyArray<Int16Array>) => {
  const out: string[] = [];
  let size = 0;
  for (const c of clips.slice(0, 20)) {
    const b64 = Buffer.from(c.buffer, c.byteOffset, c.byteLength).toString("base64");
    if (size + b64.length > 3_500_000) break;
    size += b64.length;
    out.push(b64);
  }
  return { personId, clips: out };
};

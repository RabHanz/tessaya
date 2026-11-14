// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * A member's shared voice profile from her server (`voice/profile`, retained) is this R1's base for them; this R1
 * refines its own copy a little from turns it was sure of, near the base and never uploaded. A newer version restarts it.
 * @module baton-voice/room/profileSync
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { SpeakerProfile } from "../speaker.ts";

/** A shared profile as her server sends it (the centroid as in speakers.json: base64 of float32). */
export interface SharedProfile {
  readonly id: string;
  readonly name: string;
  readonly kind: "owner" | "saved";
  readonly model: string;
  readonly centroid: string;
  readonly samples: number;
  readonly version: number;
  readonly updatedAt: string;
}

interface Store {
  readonly list: () => ReadonlyArray<SpeakerProfile>;
  readonly save: (profile: SpeakerProfile) => void;
  readonly remove: (id: string) => void;
}

/** How far one sure turn moves this R1's copy toward it. */
const NUDGE = 0.02;
/** This R1's copy stays at least this close (cosine) to the shared base. */
const MIN_BASE_COSINE = 0.97;

const unit = (v: Float32Array): Float32Array => {
  let n = 0;
  for (const x of v) n += x * x;
  const len = Math.sqrt(n) || 1;
  return Float32Array.from(v, (x) => x / len);
};
const cosine = (a: Float32Array, b: Float32Array) => {
  let d = 0;
  for (let i = 0; i < a.length; i += 1) d += a[i]! * b[i]!;
  return d;
};
const decode = (b64: string): Float32Array | null => {
  const bytes = Buffer.from(b64, "base64");
  if (bytes.length === 0 || bytes.length % 4 !== 0) return null;
  const v = new Float32Array(new Uint8Array(bytes).buffer);
  return v.every(Number.isFinite) ? v : null;
};
const encode = (v: Float32Array) =>
  Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");

export const parseShared = (payload: string): SharedProfile | null => {
  try {
    const p = JSON.parse(payload) as Partial<SharedProfile>;
    return typeof p.id === "string" &&
      p.id !== "" &&
      typeof p.name === "string" &&
      (p.kind === "owner" || p.kind === "saved") &&
      typeof p.model === "string" &&
      typeof p.centroid === "string" &&
      typeof p.version === "number" &&
      decode(p.centroid) !== null
      ? (p as SharedProfile)
      : null;
  } catch {
    return null;
  }
};

export const createProfileSync = (input: {
  readonly store: Store;
  /** Where the shared bases and their versions are kept (beside speakers.json). */
  readonly file: string;
  readonly model: string;
  readonly log: (line: string) => void;
}) => {
  const read = (): Record<string, { version: number; base: string }> => {
    try {
      return JSON.parse(NodeFS.readFileSync(input.file, "utf8")) as Record<
        string,
        { version: number; base: string }
      >;
    } catch {
      return {};
    }
  };
  const write = (bases: Record<string, { version: number; base: string }>) => {
    NodeFS.mkdirSync(NodePath.dirname(input.file), { recursive: true });
    NodeFS.writeFileSync(`${input.file}.tmp`, JSON.stringify(bases), { mode: 0o600 });
    NodeFS.renameSync(`${input.file}.tmp`, input.file);
  };
  let refining = true;

  return {
    /** A shared profile from her server: a newer version becomes this member's base here, and their copy restarts. */
    shared: (p: SharedProfile): boolean => {
      if (p.model !== input.model) {
        input.log(`voice profile ${p.id}: another model (${p.model}), not compared`);
        return false;
      }
      const bases = read();
      if ((bases[p.id]?.version ?? -1) >= p.version) return false;
      const centroid = unit(decode(p.centroid)!);
      // His own enrolment made here becomes his shared profile: two profiles of one voice nearly tie and read as a guest.
      if (p.kind === "owner" && p.id !== "owner") input.store.remove("owner");
      input.store.save({
        id: p.id,
        name: p.name,
        kind: p.kind,
        model: p.model,
        centroid,
        samples: p.samples,
        sources: ["spoken"],
        enrolledAt: p.updatedAt,
      });
      write({ ...bases, [p.id]: { version: p.version, base: encode(centroid) } });
      input.log(`voice profile ${p.id}: version ${p.version} from her server`);
      return true;
    },
    /** The member is gone (an empty retained message, or voice/forget). */
    clear: (id: string) => {
      const bases = read();
      delete bases[id];
      write(bases);
      input.store.remove(id);
    },
    /**
     * A turn this R1 was sure was theirs (verified, a clip of 4 s or more, well above the act cut-off): their copy here
     * moves 2% toward it, unless that would take it too far from the shared base. Never uploaded.
     */
    refine: (id: string, vector: Float32Array) => {
      if (!refining) return;
      const base = read()[id];
      const profile = input.store.list().find((p) => p.id === id);
      if (base === undefined || profile === undefined || profile.centroid.length !== vector.length)
        return;
      const b = decode(base.base);
      if (b === null) return;
      const v = unit(vector);
      const next = unit(Float32Array.from(profile.centroid, (x, i) => x + NUDGE * (v[i]! - x)));
      if (cosine(next, b) < MIN_BASE_COSINE) return;
      input.store.save({
        ...profile,
        centroid: next,
        sources: [...new Set([...profile.sources, "adapted" as const])],
      });
    },
    /** This R1's refinement switch (on by default). */
    setRefining: (on: boolean) => {
      refining = on;
    },
    refining: () => refining,
    /** The profiles made on this R1 itself (an enrolment here), not taken from her server. */
    localOnly: (): ReadonlyArray<SpeakerProfile> => {
      const bases = read();
      return input.store.list().filter((p) => bases[p.id] === undefined);
    },
  };
};

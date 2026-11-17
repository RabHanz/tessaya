// @effect-diagnostics nodeBuiltinImport:off globalDate:off
/**
 * A member's shared voice profile from her server (`voice/profile`, retained) is this R1's base for them; this R1
 * refines its own copy a little from turns it was sure of, near the base and never uploaded. A newer version restarts it.
 * @module baton-voice/room/profileSync
 */
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { cosine, enrol, unitOrNull, type SpeakerProfile } from "../speaker.ts";
import { vectorFromBase64, vectorToBase64 } from "../speakerStore.ts";

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

/**
 * A room profile: a member's voice as this R1's own mic hears it, the centroid of the turns it was sure of (`learn`). Each
 * rebuild is a new version with what made it, kept beside the earlier ones, so it can be read back or undone (`reset`).
 */
export interface RoomSample {
  readonly at: number;
  readonly how: string;
  readonly score: number;
  readonly ms: number;
  readonly vector: string;
}
interface RoomProfile {
  readonly version: number;
  readonly centroid: string | null;
  readonly samples: ReadonlyArray<RoomSample>;
  readonly versions: ReadonlyArray<{
    readonly version: number;
    readonly at: number;
    readonly samples: number;
    readonly kept: number;
    readonly toBase: number;
    readonly centroid: string;
  }>;
}
/** Samples kept per member (newest), and how many make a first room profile. */
const ROOM_KEEP = 150;
const ROOM_MIN = 12;
/**
 * A room profile this unlike the enrolled one is not adopted: drift or someone else's turns. His Tumble room centroid
 * (14-17 Nov) sits at 0.83 to his enrolled profile, his newest 150 clips (his bedroom) at 0.74; other voices <= 0.35.
 */
const ROOM_MIN_BASE = 0.6;
const ROOM_HISTORY = 10;

/** Length 1, or as it is when it has none (all zeros), which then never scores as anyone. */
const unit = (v: Float32Array): Float32Array => unitOrNull(v) ?? v;

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
      vectorFromBase64(p.centroid) !== null
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
  const roomFile = NodePath.join(NodePath.dirname(input.file), "room.json");
  // Read once: every turn is scored against it, and only this R1 writes it.
  let rooms: Record<string, RoomProfile> | null = null;
  const readRoom = (): Record<string, RoomProfile> => {
    if (rooms !== null) return { ...rooms };
    try {
      rooms = JSON.parse(NodeFS.readFileSync(roomFile, "utf8")) as Record<string, RoomProfile>;
    } catch {
      rooms = {};
    }
    return { ...rooms };
  };
  const writeRoom = (next: Record<string, RoomProfile>) => {
    rooms = next;
    NodeFS.mkdirSync(NodePath.dirname(roomFile), { recursive: true });
    NodeFS.writeFileSync(`${roomFile}.tmp`, JSON.stringify(next), { mode: 0o600 });
    NodeFS.renameSync(`${roomFile}.tmp`, roomFile);
  };

  return {
    /** This member's room centroid on this R1, when it has one. */
    room: (id: string): Float32Array | undefined => {
      const c = readRoom()[id]?.centroid;
      return c == null ? undefined : (vectorFromBase64(c) ?? undefined);
    },
    /**
     * A turn this R1 was sure was theirs (`teaches` in speaker.ts) joins their room samples; their room profile is rebuilt
     * from the newest, outliers dropped, and adopted only near their enrolled profile. Never uploaded.
     */
    learn: (id: string, vector: Float32Array, sample: Omit<RoomSample, "vector">) => {
      if (!refining) return;
      const profile = input.store.list().find((p) => p.id === id);
      const v = unitOrNull(vector);
      if (profile === undefined || v === null || v.length !== profile.centroid.length) return;
      const all = readRoom();
      const was = all[id] ?? { version: 0, centroid: null, samples: [], versions: [] };
      const samples = [...was.samples, { ...sample, vector: vectorToBase64(v) }].slice(-ROOM_KEEP);
      const made =
        samples.length < ROOM_MIN
          ? null
          : enrol(samples.flatMap((s) => vectorFromBase64(s.vector) ?? []));
      const toBase = made === null ? Number.NaN : cosine(made.centroid, profile.centroid);
      if (made !== null && !(toBase >= ROOM_MIN_BASE))
        input.log(`room profile ${id}: not adopted (${toBase.toFixed(2)} to the enrolled one)`);
      const adopt = made !== null && toBase >= ROOM_MIN_BASE;
      const centroid = adopt ? vectorToBase64(made.centroid) : was.centroid;
      const version = adopt ? was.version + 1 : was.version;
      all[id] = {
        version,
        centroid,
        samples,
        versions: adopt
          ? [
              ...was.versions,
              {
                version,
                at: sample.at,
                samples: samples.length,
                kept: made.kept,
                toBase: Math.round(toBase * 1000) / 1000,
                centroid: centroid!,
              },
            ].slice(-ROOM_HISTORY)
          : was.versions,
      };
      writeRoom(all);
    },
    /** A shared profile from her server: a newer version becomes this member's base here, and their copy restarts. */
    shared: (p: SharedProfile): boolean => {
      if (p.model !== input.model) {
        input.log(`voice profile ${p.id}: another model (${p.model}), not compared`);
        return false;
      }
      const bases = read();
      if ((bases[p.id]?.version ?? -1) >= p.version) return false;
      const centroid = unit(vectorFromBase64(p.centroid)!);
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
      write({ ...bases, [p.id]: { version: p.version, base: vectorToBase64(centroid) } });
      input.log(`voice profile ${p.id}: version ${p.version} from her server`);
      return true;
    },
    /** The member is gone (an empty retained message, or voice/forget). */
    clear: (id: string) => {
      const bases = read();
      delete bases[id];
      write(bases);
      const all = readRoom();
      delete all[id];
      writeRoom(all);
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
      const b = vectorFromBase64(base.base);
      if (b === null) return;
      const v = unitOrNull(vector);
      if (v === null) return;
      const next = unit(Float32Array.from(profile.centroid, (x, i) => x + NUDGE * (v[i]! - x)));
      // A NaN score (a zero or damaged vector) must never pass as close.
      if (!(cosine(next, b) >= MIN_BASE_COSINE)) return;
      input.store.save({
        ...profile,
        centroid: next,
        sources: [...new Set([...profile.sources, "adapted" as const])],
      });
    },
    /** This R1's copies back to their shared bases, refinements and room profiles dropped (`voice/refine {"reset":true}`). */
    reset: () => {
      writeRoom({});
      const bases = read();
      for (const profile of input.store.list()) {
        const base = bases[profile.id];
        const b = base === undefined ? null : vectorFromBase64(base.base);
        if (b !== null)
          input.store.save({
            ...profile,
            centroid: b,
            sources: profile.sources.filter((s) => s !== "adapted"),
          });
      }
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

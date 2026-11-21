// @effect-diagnostics globalDate:off
/**
 * Is every machine on the same page (M-146, Director 21 Nov)? Each machine and device sends a fingerprint (its build,
 * the brain it talks to, its login, a digest of each store it keeps); the brain compares them with its own and names
 * each divergence in plain words, as health findings the pulse raises once per episode. Pure.
 */
import type { FleetFingerprint, FleetStore, HealthFinding } from "@t3tools/tessaya-contracts";

/** A fingerprint older than this is not news about now: only "it has gone quiet" is said of it. */
export const FLEET_STALE_MS = 10 * 60_000;
/** A rolling deploy leaves machines on two builds for a while; past this, the skew is real. */
export const DEPLOY_WINDOW_MS = 30 * 60_000;
export const CLOCK_SKEW_MS = 3_000;

/** The stores that must equal the brain's copy, as she says them. Any other store is that machine's own. */
export const SHARED_STORES: Readonly<Record<string, string>> = {
  voiceProfiles: "your voice profile",
  consent: "your standing yeses",
  dictionary: "your dictionary",
  memberPreferences: "everyone's preferences",
};

/** 32-bit FNV-1a: the same digest on the server, the room loop and a phone, with no crypto module. */
const fnv = (text: string) => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
};

/** A store's digest from one line per entry, in any order. */
export const storeOf = (entries: ReadonlyArray<string>, summary?: string): FleetStore => ({
  digest: fnv(entries.toSorted().join("\n")),
  count: entries.length,
  ...(summary === undefined ? {} : { summary }),
});

/** The digest of a credential or other secret, so two machines' logins compare without either leaving its box. */
export const secretDigest = (secret: string) => fnv(`tessaya-fleet:${secret}`);

/** The kinds built from this repo's commits, so their commit must be the brain's. */
const SAME_BUILD = new Set(["server", "loop"]);

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const hostOf = (target: string) =>
  (target.startsWith("[") ? target.slice(0, target.indexOf("]") + 1) : target.split(":")[0]!)
    .trim()
    .toLowerCase();

/**
 * Whether `fp` sends to `home`, by home's environment id, or its host, IPs and names; a loopback target is right only on home's
 * own host, which is how a standby loop on the laptop came to run Tumble's turns on the laptop.
 */
export const talksToHome = (fp: FleetFingerprint, home: FleetFingerprint): boolean => {
  if (fp.id === home.id) return true;
  if (fp.brain === null) return false;
  if (fp.brain.startsWith("env:")) return fp.brain === `env:${home.id}`;
  const host = hostOf(fp.brain.replace(/^url:/, ""));
  if (LOOPBACK.has(host)) return fp.host.toLowerCase() === home.host.toLowerCase();
  const known = new Set([home.host, ...(home.addresses ?? [])].map((a) => a.toLowerCase()));
  return known.has(host) || known.has(host.split(".")[0]!);
};

const ago = (now: number, at: number) => {
  const min = Math.max(1, Math.round((now - at) / 60_000));
  return min < 90 ? `${min} min ago` : `${Math.round(min / 60)} h ago`;
};

const contents = (s: FleetStore) =>
  s.summary ?? (s.count === 0 ? "empty" : `${s.count} ${s.count === 1 ? "entry" : "entries"}`);

const finding = (
  key: string,
  severity: HealthFinding["severity"],
  says: string,
  evidence: ReadonlyArray<string>,
  fix: string | null,
): HealthFinding => ({ key: `fleet:${key}`, severity, says, evidence, fix, symptoms: [] });

/** Every way the fleet disagrees with `home` (the brain's own fingerprint, first in `fleet`), worst first. */
export const fleetFindings = (
  fleet: ReadonlyArray<FleetFingerprint>,
  now: number,
): Array<HealthFinding> => {
  const home = fleet[0];
  if (home === undefined) return [];
  const out: Array<HealthFinding> = [];
  const fresh: Array<FleetFingerprint> = [home];
  for (const fp of fleet.slice(1)) {
    const seen = fp.receivedAt ?? fp.sentAt;
    if (now - seen > FLEET_STALE_MS) {
      out.push(
        finding(
          `quiet:${fp.id}`,
          "minor",
          `${fp.name} has not reported since ${ago(now, seen)}`,
          [`last fingerprint ${ago(now, seen)}`],
          null,
        ),
      );
      continue;
    }
    fresh.push(fp);
    if (!talksToHome(fp, home))
      out.push(
        finding(
          `brain:${fp.id}`,
          "degraded",
          fp.brain === null
            ? `${fp.name} thinks it is my brain, so what happens there never reaches me`
            : `${fp.name} talks to ${fp.brain.replace(/^(url|env):/, "")} as its brain, not to me`,
          [`its brain: ${fp.brain ?? "itself"}`, `mine: ${home.host}`],
          `point ${fp.name} at this server`,
        ),
      );
    // a Tessel's firmware or a phone's app has its own release line, so only this repo's builds are held to mine
    const sameBuild = SAME_BUILD.has(fp.kind);
    if (sameBuild && fp.commit === null)
      out.push(
        finding(
          `commit:${fp.id}`,
          "minor",
          `${fp.name} does not say which build it runs`,
          [`version ${fp.version}`],
          null,
        ),
      );
    else if (
      sameBuild &&
      fp.commit !== null &&
      home.commit !== null &&
      fp.commit !== home.commit &&
      now - Math.max(fp.startedAt, home.startedAt) > DEPLOY_WINDOW_MS
    )
      out.push(
        finding(
          `version:${fp.id}`,
          "degraded",
          `${fp.name} runs a different build from mine`,
          [
            `${fp.name}: ${fp.version} (${fp.commit.slice(0, 10)})`,
            `mine: ${home.version} (${home.commit.slice(0, 10)})`,
          ],
          `update ${fp.name}, or me`,
        ),
      );
    for (const [store, says] of Object.entries(SHARED_STORES)) {
      const mine = home.stores[store];
      const theirs = fp.stores[store];
      if (mine === undefined || theirs === undefined || mine.digest === theirs.digest) continue;
      out.push(
        finding(
          `store:${fp.id}:${store}`,
          "degraded",
          `${fp.name} keeps a different copy of ${says} from mine`,
          [`${fp.name}: ${contents(theirs)}`, `mine: ${contents(mine)}`],
          `bring ${fp.name}'s copy of ${says} in line with mine`,
        ),
      );
    }
    if (fp.receivedAt !== undefined && Math.abs(fp.receivedAt - fp.sentAt) > CLOCK_SKEW_MS)
      out.push(
        finding(
          `clock:${fp.id}`,
          "degraded",
          `${fp.name}'s clock is ${Math.round(Math.abs(fp.receivedAt - fp.sentAt) / 1000)} seconds ${fp.sentAt > fp.receivedAt ? "fast" : "slow"}`,
          [
            `sent at ${new Date(fp.sentAt).toISOString()}, arrived ${new Date(fp.receivedAt).toISOString()}`,
          ],
          `turn on time sync on ${fp.name}`,
        ),
      );
  }
  // One credential under two names: one machine's login label is stale, so usage lands on the wrong account.
  const byLogin = new Map<string, Array<FleetFingerprint>>();
  for (const fp of fresh)
    if (fp.account !== null)
      byLogin.set(fp.account.digest, [...(byLogin.get(fp.account.digest) ?? []), fp]);
  for (const [digest, fps] of byLogin) {
    const labels = new Set(fps.map((f) => f.account!.label));
    if (labels.size < 2) continue;
    out.push(
      finding(
        `account:${digest}`,
        "degraded",
        `one login goes by different names: ${fps.map((f) => `${f.account!.label} on ${f.name}`).join(", ")}`,
        [`the same credential on ${fps.length} machines`],
        "sign in again on the machine whose name is wrong",
      ),
    );
  }
  const rank = { ok: 0, minor: 1, degraded: 2, down: 3 } as const;
  return out.toSorted((a, b) => rank[b.severity] - rank[a.severity]);
};

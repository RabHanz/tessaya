/**
 * Self-update safety: a version that does not get as far as being healthy on two starts in a row is
 * remembered as bad, so it is not offered or installed again, and he is told which version last
 * worked. Pure; the desktop keeps the record in a small file.
 */
export interface GuardFile {
  /** The version of the latest start, how many starts in a row did not become healthy, and whether this one did. */
  readonly current: {
    readonly version: string;
    readonly tries: number;
    readonly healthy: boolean;
  } | null;
  /** The last version that became healthy. */
  readonly lastGood: string | null;
  /** Versions that failed to start twice. */
  readonly bad: ReadonlyArray<string>;
}

export const EMPTY_GUARD: GuardFile = { current: null, lastGood: null, bad: [] };

export const STARTS_BEFORE_BAD = 2;

export interface StartVerdict {
  readonly file: GuardFile;
  /** True when this start is the second in a row that did not get healthy: a bad version. */
  readonly failing: boolean;
  /** The version to go back to, when there is one that is not this one. */
  readonly goBackTo: string | null;
}

/**
 * `previousEndedBadly`: the run before this one was killed or crashed (the lifecycle log knows). A
 * clean quit before the healthy mark is just a short session, not a failed start.
 */
export const beginStart = (
  file: GuardFile,
  version: string,
  previousEndedBadly: boolean,
): StartVerdict => {
  const same = file.current?.version === version && !file.current.healthy && previousEndedBadly;
  const tries = same ? file.current!.tries + 1 : 1;
  const failing = tries >= STARTS_BEFORE_BAD;
  // A version that was healthy before is never marked bad by one slow start.
  const wasGood = file.lastGood === version;
  const bad =
    failing && !wasGood && !file.bad.includes(version) ? [...file.bad, version] : file.bad;
  return {
    file: { ...file, current: { version, tries, healthy: false }, bad },
    failing: failing && !wasGood,
    goBackTo: file.lastGood !== null && file.lastGood !== version ? file.lastGood : null,
  };
};

export const markHealthy = (file: GuardFile): GuardFile =>
  file.current === null
    ? file
    : {
        current: { ...file.current, tries: 0, healthy: true },
        lastGood: file.current.version,
        bad: file.bad.filter((v) => v !== file.current!.version),
      };

export const isBad = (file: GuardFile, version: string): boolean => file.bad.includes(version);

export const failedStartMessage = (version: string, goBackTo: string | null): string =>
  goBackTo === null
    ? `Tessaya ${version} did not start properly twice in a row. It will not install this version again by itself.`
    : `Tessaya ${version} did not start properly twice in a row. It will not install this version again by itself. The last version that worked was ${goBackTo}; you can reinstall it from the releases page.`;

/** Transcribing an audio file (the file picker or a drop on the window): which files, how it is split, what it is called. Pure. */
export const WAV_EXTENSIONS = [".wav"] as const;
/** Other formats go through ffmpeg when it is installed. */
export const OTHER_EXTENSIONS = [
  ".mp3",
  ".m4a",
  ".mp4",
  ".ogg",
  ".opus",
  ".flac",
  ".aac",
  ".webm",
  ".wma",
  ".mov",
] as const;
export const ACCEPTED_EXTENSIONS: ReadonlyArray<string> = [...WAV_EXTENSIONS, ...OTHER_EXTENSIONS];

/** Four hours at most: a longer file is refused rather than left running. */
export const MAX_SECONDS = 4 * 3_600;
export const CHUNK_SECONDS = 60;

export const extensionOf = (name: string): string => {
  const at = name.lastIndexOf(".");
  return at < 0 ? "" : name.slice(at).toLowerCase();
};

export const isWavFile = (name: string): boolean => extensionOf(name) === ".wav";
export const isAcceptedAudio = (name: string): boolean =>
  ACCEPTED_EXTENSIONS.includes(extensionOf(name));

/** Sample ranges of at most `seconds` each, covering the whole recording. */
export const chunkRanges = (
  samples: number,
  rate: number,
  seconds = CHUNK_SECONDS,
): ReadonlyArray<readonly [number, number]> => {
  const size = Math.max(1, Math.floor(rate * seconds));
  const out: Array<readonly [number, number]> = [];
  for (let at = 0; at < samples; at += size) out.push([at, Math.min(samples, at + size)]);
  return out;
};

export const baseName = (path: string): string => path.split(/[\\/]/).at(-1) ?? path;

/** The note's first line. */
export const transcriptTitle = (path: string): string => `Transcript of ${baseName(path)}`;

export const ffmpegArgs = (input: string, output: string): ReadonlyArray<string> => [
  "-y",
  "-v",
  "error",
  "-i",
  input,
  "-vn",
  "-ar",
  "16000",
  "-ac",
  "1",
  "-f",
  "wav",
  output,
];

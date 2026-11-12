/**
 * What a session's images and videos may be shown from. One rule for the live-session mirror and the
 * native ingestor, pure so it can be tested without a disk: the caller resolves real paths and sizes.
 */
import { mediaKindFromPath } from "./mediaPreview.ts";

export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_VIDEO_BYTES = 100 * 1024 * 1024;

const SECRET_DIRS = [
  "/.ssh/",
  "/.aws/",
  "/.gnupg/",
  "/.azure/",
  "/.kube/",
  "/.docker/",
  "/.config/gcloud/",
  "/.config/gh/",
  "/.git/",
  "/node_modules/",
  "/.t3/userdata/secrets/",
  "/.mozilla/",
  "/.config/google-chrome/",
  "/.config/chromium/",
  "/google/chrome/user data/",
  "/microsoft/edge/user data/",
  "/application support/google/chrome/",
];
const SECRET_NAME =
  /^(?:\.env(?:\..*)?|id_(?:rsa|ed25519|ecdsa|dsa).*|credentials?.*|.*\.(?:pem|key|p12|pfx|kdbx)(?:\..*)?)$|secret|token|passw(?:or)?d/i;

/** Why a path may never be shown, from its REAL path (a symlink cannot hide one). */
export const deniedReason = (realPath: string): string | null => {
  const path = `${realPath.replace(/\\/g, "/").toLowerCase()}`;
  if (SECRET_DIRS.some((dir) => `${path}/`.includes(dir))) return "a folder that holds secrets";
  if (/\/\.claude[^/]*\//.test(path)) return "an assistant's own profile";
  if (/\/\.config\/[^/]*(?:token|credential|secret)[^/]*\//.test(path))
    return "a folder that holds secrets";
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (SECRET_NAME.test(name)) return "a file named like a secret";
  return null;
};

const within = (child: string, root: string): boolean => {
  const a = child.replace(/\\/g, "/");
  const b = root.replace(/\\/g, "/").replace(/\/+$/, "");
  return b === "" ? false : a === b || a.startsWith(`${b}/`);
};

export type MediaVerdict =
  | { readonly verdict: "attach"; readonly kind: "image" | "video" }
  /** Too big to copy: said in the text, with its size. */
  | { readonly verdict: "link"; readonly kind: "image" | "video"; readonly size: number }
  | { readonly verdict: "skip"; readonly reason: string };

/**
 * `roots` are real directories the thread owns (its cwd, worktree, scratch and tmp folders, the
 * attachment store). `touched`: the session itself wrote, read or ran something with this path this
 * turn, which opens any other place too, but never a denied one.
 */
export const judgeMedia = (input: {
  readonly real: string;
  readonly size: number;
  readonly touched: boolean;
  readonly roots: ReadonlyArray<string>;
}): MediaVerdict => {
  const kind = mediaKindFromPath(input.real);
  if (kind !== "image" && kind !== "video")
    return { verdict: "skip", reason: "not an image or video" };
  const denied = deniedReason(input.real);
  if (denied !== null) return { verdict: "skip", reason: denied };
  if (!input.touched && !input.roots.some((root) => within(input.real, root))) {
    return { verdict: "skip", reason: "outside the folders this thread owns" };
  }
  if (input.size <= 0) return { verdict: "skip", reason: "empty" };
  const limit = kind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  return input.size > limit
    ? { verdict: "link", kind, size: input.size }
    : { verdict: "attach", kind };
};

const MEDIA_PATH =
  /(?:~\/|\/|\.{1,2}\/|[\w@-][\w.@-]*\/)[^\s"'`<>|;&()]*\.[A-Za-z0-9]{2,5}\b|[\w@-][\w.@-]*\.[A-Za-z0-9]{2,5}\b/g;
// Matches never span these, so splitting on them first changes no result.
const TOKEN_BREAK = /[\s"'`<>|;&()]+/;
const MAX_TOKEN = 512;
const SCAN_CHARS = 256 * 1024;

/** Media paths found anywhere in a tool call's input (any nested string) or its output text. */
export const pathsInto = (
  value: unknown,
  found: Set<string> = new Set(),
  depth = 0,
): Set<string> => {
  if (depth > 6) return found;
  if (typeof value === "string") {
    // The pattern backtracks quadratically on a long run, so it only ever sees short tokens.
    // shortcut: paths after the first SCAN_CHARS of one string are not found.
    for (const token of value.slice(0, SCAN_CHARS).split(TOKEN_BREAK)) {
      if (token.length > MAX_TOKEN || !token.includes(".")) continue;
      for (const match of token.matchAll(MEDIA_PATH)) {
        const kind = mediaKindFromPath(match[0]);
        if (kind === "image" || kind === "video") found.add(match[0]);
      }
    }
  } else if (Array.isArray(value)) value.forEach((v) => pathsInto(v, found, depth + 1));
  else if (typeof value === "object" && value !== null) {
    Object.values(value).forEach((v) => pathsInto(v, found, depth + 1));
  }
  return found;
};

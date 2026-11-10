import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";

// One console line per unexplained drop; the desktop copies lines with this prefix to
// logs/draft-image-drops.ndjson. Ids, keys and code paths only: never image data or prompt text.
export const DRAFT_IMAGE_DROP_LOG_PREFIX = "baton:draft-image-drop ";

interface DropDraft {
  readonly prompt: string;
  readonly images: ReadonlyArray<{ readonly id: string }>;
}
type Drafts = Readonly<Record<string, DropDraft>>;

export interface DraftImageDrop {
  readonly key: string;
  readonly imageId: string;
  readonly chip: boolean;
}

const chipIds = (draft: DropDraft | undefined) =>
  new Set<string>(
    draft ? collectComposerContextReferences(draft.prompt).map((entry) => entry.contextId) : [],
  );

/**
 * Images that left a draft without going anywhere else while their chip stayed. A remove or a
 * send, here or in another window, takes the chip with it.
 */
export function findDraftImageDrops(before: Drafts, after: Drafts): DraftImageDrop[] {
  const stillHeld = new Set(
    Object.values(after).flatMap((draft) => draft.images.map((image) => image.id)),
  );
  return Object.entries(before).flatMap(([key, draft]) => {
    const chips = chipIds(after[key]);
    return draft.images.flatMap((image) => {
      if (stillHeld.has(image.id)) return [];
      return chips.has(`image_${image.id}`) ? [{ key, imageId: image.id, chip: true }] : [];
    });
  });
}

const attachedAt = new Map<string, number>();
let quietSource: string | null = null;

const shortStack = () =>
  (new Error().stack ?? "")
    .split("\n")
    .slice(3, 9)
    .map((line) =>
      line
        .trim()
        .replace(/^at /, "")
        .replace(/\(.*\)$/, "")
        .trim(),
    )
    .filter((name) => name.length > 0 && !name.startsWith("http"))
    .join(" < ");

export function logDraftImageDrops(
  drops: ReadonlyArray<DraftImageDrop>,
  path: string,
  log: (line: string) => void = (line) => console.warn(line),
): void {
  const now = Date.now();
  const stack = path === "setter" ? shortStack() : undefined;
  for (const drop of drops) {
    const since = attachedAt.get(drop.imageId);
    log(
      DRAFT_IMAGE_DROP_LOG_PREFIX +
        JSON.stringify({
          at: new Date(now).toISOString(),
          key: drop.key,
          imageId: drop.imageId,
          chip: drop.chip ? "yes" : "no",
          path,
          ...(stack ? { stack } : {}),
          sinceAttachMs: since === undefined ? null : now - since,
        }),
    );
  }
}

/** Runs a change whose drops its caller reports itself, comparing before and after as a whole. */
export function withDraftChangeSource<A>(source: string, run: () => A): A {
  const previous = quietSource;
  quietSource = source;
  try {
    return run();
  } finally {
    quietSource = previous;
  }
}

/** Watches every draft change for images that vanish while their chip stays. */
export function watchDraftImageDrops(
  store: {
    getState(): { draftsByThreadKey: Drafts };
    subscribe(
      listener: (
        state: { draftsByThreadKey: Drafts },
        previous: { draftsByThreadKey: Drafts },
      ) => void,
    ): () => void;
  },
  log?: (line: string) => void,
): () => void {
  const noteAttached = (drafts: Drafts) => {
    const now = Date.now();
    for (const draft of Object.values(drafts)) {
      for (const image of draft.images)
        if (!attachedAt.has(image.id)) attachedAt.set(image.id, now);
    }
  };
  noteAttached(store.getState().draftsByThreadKey);
  return store.subscribe((state, previous) => {
    if (state.draftsByThreadKey === previous.draftsByThreadKey) return;
    noteAttached(state.draftsByThreadKey);
    if (quietSource !== null) return;
    logDraftImageDrops(
      findDraftImageDrops(previous.draftsByThreadKey, state.draftsByThreadKey),
      "setter",
      log,
    );
    const held = new Set(
      Object.values(state.draftsByThreadKey).flatMap((draft) => draft.images.map(({ id }) => id)),
    );
    for (const id of attachedAt.keys()) if (!held.has(id)) attachedAt.delete(id);
  });
}

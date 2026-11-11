import type { ComposerImageAttachment, ComposerImageBackup } from "./composerDraftStore";
import { logDraftImageDrops, watchDraftImageDrops } from "./composerImageDropLog";

// Draft images also go to localStorage as data URLs, but that write can miss: one JSON blob
// for every draft hits the quota, or a reload lands before the async serialization. IndexedDB
// holds the bytes so a reload (including the one a server deploy forces) can put them back.
const DATABASE_NAME = "t3code:composer-images";
const DATABASE_VERSION = 1;
const STORE_NAME = "images";
let database: Promise<IDBDatabase> | undefined;

function openDatabase() {
  return (database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME);
      }
    });
    request.addEventListener("success", () => resolve(request.result));
    request.addEventListener("error", () => reject(request.error));
    request.addEventListener("blocked", () => reject(new Error("Draft image backup is blocked.")));
  }));
}

async function withStore<A>(
  mode: IDBTransactionMode,
  use: (store: IDBObjectStore) => IDBRequest<A> | void,
) {
  const transaction = (await openDatabase()).transaction(STORE_NAME, mode);
  const request = use(transaction.objectStore(STORE_NAME));
  await new Promise<void>((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve());
    transaction.addEventListener("abort", () => reject(transaction.error));
    transaction.addEventListener("error", () => reject(transaction.error));
  });
  return request?.result;
}

interface DraftImageStore {
  getState(): {
    draftsByThreadKey: Record<
      string,
      { prompt: string; images: ReadonlyArray<ComposerImageAttachment> }
    >;
  };
  subscribe(
    listener: (
      state: ReturnType<DraftImageStore["getState"]>,
      previous: ReturnType<DraftImageStore["getState"]>,
    ) => void,
  ): () => void;
}

const backupKey = (threadKey: string, imageId: string) => `${threadKey}\u0000${imageId}`;

// Sent and removed images are written here synchronously, so a reload that beats the async
// IndexedDB delete cannot bring them back.
const TOMBSTONES_KEY = "t3code:composer-image-tombstones";
const MAX_TOMBSTONES = 200;

function readTombstones(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(TOMBSTONES_KEY) ?? "[]");
    return Array.isArray(parsed) ? parsed.filter((key) => typeof key === "string") : [];
  } catch {
    return [];
  }
}

function writeTombstones(keys: ReadonlyArray<string>) {
  try {
    localStorage.setItem(TOMBSTONES_KEY, JSON.stringify(keys.slice(-MAX_TOMBSTONES)));
  } catch {
    // Storage full or blocked: the async delete is then the only guard.
  }
}

function removeBackup(key: string) {
  void withStore("readwrite", (images) => images.delete(key)).then(
    () => writeTombstones(readTombstones().filter((tombstone) => tombstone !== key)),
    () => undefined,
  );
}

/** Mirrors every draft image into IndexedDB and restores the ones a reload dropped. */
export function startComposerImageBackup(
  store: DraftImageStore,
  restore: (
    backups: ReadonlyArray<ComposerImageBackup>,
    removed: (backup: ComposerImageBackup) => boolean,
  ) => ReadonlyArray<ComposerImageBackup>,
): void {
  watchDraftImageDrops(store);
  if (typeof indexedDB === "undefined" || typeof localStorage === "undefined") return;
  const tracked = new Set<string>();
  const sync = (state: ReturnType<DraftImageStore["getState"]>) => {
    const current = new Set<string>();
    for (const [threadKey, draft] of Object.entries(state.draftsByThreadKey)) {
      for (const image of draft.images) {
        const key = backupKey(threadKey, image.id);
        current.add(key);
        if (tracked.has(key)) continue;
        tracked.add(key);
        const backup: ComposerImageBackup = {
          threadKey,
          id: image.id,
          name: image.name,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          ...(image.source ? { source: image.source } : {}),
          blob: image.file,
        };
        void withStore("readwrite", (images) => images.put(backup, key)).catch(() => undefined);
      }
    }
    const gone = [...tracked].filter((key) => !current.has(key));
    if (gone.length === 0) return;
    writeTombstones([...readTombstones().filter((key) => !gone.includes(key)), ...gone]);
    for (const key of gone) {
      tracked.delete(key);
      removeBackup(key);
    }
  };
  // Tracking starts before the backups load, so a removal in the meantime is tombstoned.
  sync(store.getState());
  store.subscribe((state, previous) => {
    if (state.draftsByThreadKey !== previous.draftsByThreadKey) sync(state);
  });
  void (async () => {
    const stored: unknown[] =
      (await withStore("readonly", (images) => images.getAll()).catch(() => undefined)) ?? [];
    const backups = stored.filter(
      (backup): backup is ComposerImageBackup =>
        typeof backup === "object" &&
        backup !== null &&
        "blob" in backup &&
        backup.blob instanceof Blob &&
        "threadKey" in backup &&
        typeof backup.threadKey === "string",
    );
    const tombstones = new Set(readTombstones());
    const removed = (candidate: ComposerImageBackup) =>
      tombstones.has(backupKey(candidate.threadKey, candidate.id));
    const stale = restore(backups, removed);
    // Backed up, never sent or removed, yet its draft did not survive the reload.
    logDraftImageDrops(
      stale
        .filter((backup) => !removed(backup))
        .map((backup) => ({ key: backup.threadKey, imageId: backup.id, chip: false })),
      "reload",
    );
    for (const backup of stale) {
      removeBackup(backupKey(backup.threadKey, backup.id));
    }
    // Tombstones whose backups are already gone have done their job.
    const stillStored = new Set(backups.map((backup) => backupKey(backup.threadKey, backup.id)));
    writeTombstones(readTombstones().filter((key) => !tombstones.has(key) || stillStored.has(key)));
  })();
}

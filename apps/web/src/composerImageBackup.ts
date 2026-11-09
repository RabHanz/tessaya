import type { ComposerImageAttachment, ComposerImageBackup } from "./composerDraftStore";

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
    draftsByThreadKey: Record<string, { images: ReadonlyArray<ComposerImageAttachment> }>;
  };
  subscribe(
    listener: (
      state: ReturnType<DraftImageStore["getState"]>,
      previous: ReturnType<DraftImageStore["getState"]>,
    ) => void,
  ): () => void;
}

const backupKey = (threadKey: string, imageId: string) => `${threadKey}\u0000${imageId}`;

/** Mirrors every draft image into IndexedDB and restores the ones a reload dropped. */
export function startComposerImageBackup(
  store: DraftImageStore,
  restore: (backups: ReadonlyArray<ComposerImageBackup>) => ReadonlyArray<ComposerImageBackup>,
): void {
  if (typeof indexedDB === "undefined") return;
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
    const stale = new Set(restore(backups));
    for (const backup of stale) {
      const key = backupKey(backup.threadKey, backup.id);
      void withStore("readwrite", (images) => images.delete(key)).catch(() => undefined);
    }
    const backedUp = new Set(
      backups
        .filter((backup) => !stale.has(backup))
        .map((backup) => backupKey(backup.threadKey, backup.id)),
    );
    const sync = (state: ReturnType<DraftImageStore["getState"]>) => {
      const current = new Set<string>();
      for (const [threadKey, draft] of Object.entries(state.draftsByThreadKey)) {
        for (const image of draft.images) {
          const key = backupKey(threadKey, image.id);
          current.add(key);
          if (backedUp.has(key)) continue;
          backedUp.add(key);
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
      for (const key of backedUp) {
        if (current.has(key)) continue;
        backedUp.delete(key);
        void withStore("readwrite", (images) => images.delete(key)).catch(() => undefined);
      }
    };
    sync(store.getState());
    store.subscribe((state, previous) => {
      if (state.draftsByThreadKey !== previous.draftsByThreadKey) sync(state);
    });
  })();
}

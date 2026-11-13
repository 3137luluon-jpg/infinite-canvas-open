import localforage from "localforage";

type RevisionRecord = { state: "pending" } | { state: "ready"; revision: string };
type RevisionStore = {
    getItem: (key: string) => Promise<RevisionRecord | null>;
    setItem: (key: string, value: RevisionRecord) => Promise<unknown>;
};
export type MediaRevisionLock = <T>(name: string, task: () => Promise<T>) => Promise<T>;

/** A disposable sidecar: media values and keys retain their existing storage format. */
export function createMediaBackupRevisionTracker({ store, lock, newRevision = () => crypto.randomUUID() }: { store: RevisionStore; lock?: MediaRevisionLock; newRevision?: () => string }) {
    const locked = <T>(key: string, task: () => Promise<T>) => (lock ? lock(`canvas-media-backup:${key}`, task) : task());
    return {
        async getRevision(key: string, loadStored: () => Promise<unknown>): Promise<string | null> {
            // Without cross-context locking, tokens cannot certify a stable source.
            if (!lock) return null;
            try {
                return await locked(key, async () => {
                    const previous = await store.getItem(key);
                    if (previous?.state === "ready" && typeof previous.revision === "string" && previous.revision) return previous.revision;
                    // A failed/interrupted mutation must never be mistaken for untracked legacy data.
                    if (previous) return null;
                    const stored = await loadStored();
                    // Remote URLs can change without a local write. Never cache their content by key.
                    if (!(stored instanceof Blob)) return null;
                    const revision = newRevision();
                    await store.setItem(key, { state: "ready", revision });
                    return revision;
                });
            } catch {
                // An unavailable sidecar disables the fast path, not the complete backup.
                return null;
            }
        },
        async mutate<T>(key: string, mutation: () => Promise<T>, trackBlob = true): Promise<T> {
            return locked(key, async () => {
                // Fail before changing media if the old token cannot be invalidated durably.
                await store.setItem(key, { state: "pending" });
                const result = await mutation();
                // Leave a tombstone after delete/remote writes, failures, or without Web Locks.
                if (lock && trackBlob) await store.setItem(key, { state: "ready", revision: newRevision() });
                return result;
            });
        },
    };
}

const revisions = localforage.createInstance({ name: "infinite-canvas-media-backup-index", storeName: "source_revisions" });
const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
const tracker = createMediaBackupRevisionTracker({
    store: { getItem: (key) => revisions.getItem<RevisionRecord>(key), setItem: (key, value) => revisions.setItem(key, value) },
    lock: locks ? async (name, task) => await locks.request(name, task) : undefined,
});

export const getMediaBackupRevision = tracker.getRevision;
export const withMediaBackupMutation = tracker.mutate;

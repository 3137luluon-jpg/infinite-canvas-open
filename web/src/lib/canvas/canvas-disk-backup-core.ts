import type { CanvasProject } from "../../stores/canvas/use-canvas-store.ts";
import type { CanvasExportFile } from "../../types/canvas-export.ts";

export type BackupStat = { size: number; lastModified: number };
export type BackupIO = {
    read: (path: string) => Promise<Blob | null>;
    write: (path: string, blob: Blob) => Promise<void>;
    stat?: (path: string) => Promise<BackupStat | null>;
};
export type BackupOptions = { sourceRevision?: (key: string) => Promise<string | null> };
export type BackupMetrics = { durationMs: number; sourceLoads: number; sourceBytes: number; hashBytes: number; mediaWrites: number; mediaWrittenBytes: number; skippedAssets: number };
type BackupAsset = { storageKey: string; path: string; mimeType: string; bytes: number };
type IndexEntry = { revision: string; hash: string; asset: BackupAsset; stat: BackupStat };
const INDEX_PATH = "index.json";
function sameStat(a: BackupStat | null, b: BackupStat) {
    return !!a && a.size === b.size && a.lastModified === b.lastModified;
}
async function readIndex(io: BackupIO): Promise<Map<string, IndexEntry>> {
    try {
        const file = await io.read(INDEX_PATH);
        if (!file) return new Map();
        const index = JSON.parse(await file.text());
        if (index.version !== 1 || !Array.isArray(index.entries)) return new Map();
        const entries = new Map<string, IndexEntry>();
        for (const item of index.entries) {
            if (
                typeof item?.revision !== "string" ||
                !item.revision ||
                !/^[a-f0-9]{64}$/.test(item.hash) ||
                typeof item.asset?.storageKey !== "string" ||
                item.asset.path !== `assets/${item.hash}.bin` ||
                typeof item.asset.mimeType !== "string" ||
                !Number.isSafeInteger(item.asset.bytes) ||
                item.asset.bytes < 0 ||
                item.stat?.size !== item.asset.bytes ||
                !Number.isFinite(item.stat?.lastModified)
            )
                continue;
            entries.set(item.asset.storageKey, item);
        }
        return entries;
    } catch {
        // The index is a disposable accelerator, never the authority for recovery.
        return new Map();
    }
}
export type DiskSnapshot = CanvasExportFile & { backupVersion: 1; complete: boolean; missing: string[]; checksums: Record<string, string> };
export function shouldWriteBackup(previous: { fingerprint: string; complete: boolean; at: number } | undefined, fingerprint: string, now: number, force = false) {
    return force || !previous || previous.fingerprint !== fingerprint || (!previous.complete && now - previous.at >= 30 * 60 * 1000);
}
export function collectBackupKeys(value: unknown, keys = new Set<string>()): Set<string> {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey) keys.add(value.storageKey);
    if (!("storageKey" in value && value.storageKey) && "content" in value && typeof value.content === "string" && /^(blob:|https?:\/\/)/.test(value.content)) keys.add(`unbacked-url:${value.content}`);
    Object.values(value).forEach((item) => collectBackupKeys(item, keys));
    return keys;
}
export async function blobHash(blob: Blob) {
    return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())), (n) => n.toString(16).padStart(2, "0")).join("");
}
export async function writeDiskSnapshot(projects: CanvasProject[], io: BackupIO, load: (key: string) => Promise<Blob | null>, options: BackupOptions = {}) {
    if (!projects.length) throw new Error("没有画布可备份；保留原有历史版本");
    const started = performance.now();
    const metrics: BackupMetrics = { durationMs: 0, sourceLoads: 0, sourceBytes: 0, hashBytes: 0, mediaWrites: 0, mediaWrittenBytes: 0, skippedAssets: 0 };
    const hashBlob = (blob: Blob) => {
        metrics.hashBytes += blob.size;
        return blobHash(blob);
    };
    const writeVerified = async (path: string, blob: Blob, expectedHash?: string) => {
        const hash = expectedHash ?? (await hashBlob(blob));
        await io.write(path, blob);
        const read = await io.read(path);
        if (!read || read.size !== blob.size || (await hashBlob(read)) !== hash) throw new Error(`硬盘回读校验失败：${path}`);
    };
    const snapshot: DiskSnapshot = JSON.parse(
        JSON.stringify({
            app: "infinite-canvas",
            version: 3,
            exportedAt: new Date().toISOString(),
            projects: projects.map((project) => ({ project, files: [] })),
            backupVersion: 1,
            complete: false,
            missing: [...collectBackupKeys(projects)],
            checksums: {},
        }),
    );
    const id = `${snapshot.exportedAt.replace(/[:.]/g, "-")}-${crypto.randomUUID()}`;
    // Keep a standalone structure rescue before any potentially failing media work.
    await writeVerified(`snapshots/structure-${id}.json`, new Blob([JSON.stringify(snapshot)]));
    const indexEnabled = !!(options.sourceRevision && io.stat);
    const previous = indexEnabled ? await readIndex(io) : new Map<string, IndexEntry>();
    const next = new Map<string, IndexEntry>();
    const assets = new Map<string, BackupAsset>();
    const keys = [...snapshot.missing];
    const missing: string[] = [];
    const writes = new Map<string, Promise<void>>();
    const revisions = new Map<string, string>();
    let cursor = 0;
    const workers = await Promise.allSettled(
        Array.from({ length: Math.min(4, keys.length) }, async () => {
            while (cursor < keys.length) {
                const key = keys[cursor++];
                const revision = indexEnabled ? await options.sourceRevision!(key) : null;
                const cached = previous.get(key);
                if (revision && cached?.revision === revision && sameStat(await io.stat!(cached.asset.path), cached.stat)) {
                    // Recheck after the disk await: a write can invalidate the journal meanwhile.
                    if ((await options.sourceRevision!(key)) !== revision) throw new Error(`备份期间素材发生变化，请重试：${key}`);
                    assets.set(key, cached.asset);
                    snapshot.checksums[cached.asset.path] = cached.hash;
                    next.set(key, cached);
                    revisions.set(key, revision);
                    metrics.skippedAssets++;
                    continue;
                }
                let blob: Blob | null = null;
                let timer: ReturnType<typeof setTimeout> | undefined;
                try {
                    metrics.sourceLoads++;
                    blob = await Promise.race([
                        load(key),
                        new Promise<null>((resolve) => {
                            timer = setTimeout(() => resolve(null), 15000);
                        }),
                    ]);
                } catch {
                    /* Missing media must never discard the structure. */
                } finally {
                    if (timer) clearTimeout(timer);
                }
                if (!blob) {
                    missing.push(key);
                    continue;
                }
                metrics.sourceBytes += blob.size;
                const hash = await hashBlob(blob);
                const path = `assets/${hash}.bin`;
                if (!writes.has(path))
                    writes.set(
                        path,
                        (async () => {
                            const existing = await io.read(path);
                            if (!existing || existing.size !== blob.size || (await hashBlob(existing)) !== hash) {
                                await writeVerified(path, blob!, hash);
                                metrics.mediaWrites++;
                                metrics.mediaWrittenBytes += blob!.size;
                            }
                        })(),
                    );
                await writes.get(path);
                const asset = { storageKey: key, path, mimeType: blob.type || "application/octet-stream", bytes: blob.size };
                assets.set(key, asset);
                snapshot.checksums[path] = hash;
                if (revision) {
                    if ((await options.sourceRevision!(key)) !== revision) throw new Error(`备份期间素材发生变化，请重试：${key}`);
                    revisions.set(key, revision);
                    const stat = await io.stat!(path);
                    if (stat && stat.size === blob.size) next.set(key, { revision, hash, asset, stat });
                }
            }
        }),
    );
    const failure = workers.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    // A mutation after one worker finished must not publish an apparently consistent version.
    for (const [key, revision] of revisions) {
        if ((await options.sourceRevision!(key)) !== revision) throw new Error(`备份期间素材发生变化，请重试：${key}`);
    }
    for (const item of snapshot.projects) item.files = [...collectBackupKeys(item.project)].flatMap((key) => (assets.has(key) ? [assets.get(key)!] : []));
    snapshot.missing = missing.sort();
    snapshot.complete = !missing.length;
    const path = `snapshots/snapshot-${id}.json`;
    await writeVerified(path, new Blob([JSON.stringify(snapshot)]));
    let cacheWarning: string | undefined;
    if (indexEnabled) {
        try {
            // No history or assets are deleted. A cache write failure cannot invalidate the snapshot.
            await writeVerified(INDEX_PATH, new Blob([JSON.stringify({ version: 1, updatedAt: snapshot.exportedAt, entries: [...next.values()] })]));
        } catch {
            cacheWarning = "快照已保存，但增量索引未写入；下次将重新校验媒体";
        }
    }
    metrics.durationMs = performance.now() - started;
    return { path, snapshot, metrics, cacheWarning };
}
export async function readDiskSnapshot(io: BackupIO, path: string) {
    if (!/^snapshots\/(?:snapshot|structure)-[\w.-]+\.json$/.test(path)) throw new Error("备份路径无效");
    const file = await io.read(path);
    if (!file) throw new Error("找不到备份文件");
    const data = JSON.parse(await file.text()) as DiskSnapshot;
    if (data.app !== "infinite-canvas" || data.version !== 3 || data.backupVersion !== 1 || !Array.isArray(data.projects) || !data.checksums || !Array.isArray(data.missing)) throw new Error("不支持的备份格式");
    const blobs = new Map<string, Blob>();
    for (const item of data.projects) {
        if (!item.project?.id || !Array.isArray(item.project.nodes) || !Array.isArray(item.project.connections) || !Array.isArray(item.files)) throw new Error("画布结构损坏");
        for (const asset of item.files) {
            if (!/^assets\/[a-f0-9]{64}\.bin$/.test(asset.path) || typeof asset.storageKey !== "string") throw new Error("媒体路径无效");
            const blob = await io.read(asset.path);
            if (!blob || blob.size !== asset.bytes || (await blobHash(blob)) !== data.checksums[asset.path]) throw new Error(`媒体缺失或校验失败：${asset.storageKey}。请另选历史版本；未导入任何项目。`);
            blobs.set(asset.storageKey, blob.slice(0, blob.size, asset.mimeType));
        }
    }
    const actualMissing = [...collectBackupKeys(data.projects.map((item) => item.project))].filter((key) => !blobs.has(key)).sort();
    if (JSON.stringify(actualMissing) !== JSON.stringify([...data.missing].sort()) || data.complete !== (actualMissing.length === 0)) throw new Error("备份完整性标记不符，停止恢复");
    return { data, blobs };
}

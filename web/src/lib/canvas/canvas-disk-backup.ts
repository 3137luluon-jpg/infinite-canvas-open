import { backupRequest, remoteRecoveryIO } from "./canvas-backup-http";
import { getImageBlob, setImageBlob } from "@/services/image-storage";
import { getMediaBlob, setMediaBlob } from "@/services/file-storage";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { blobHash, collectBackupKeys, readDiskSnapshot, type BackupIO, type BackupMetrics } from "./canvas-disk-backup-core";

let rootLabel = "本地统一备份目录";
type BackupStatus = { label: string; message: string; verifiedAt?: string; complete: boolean };

const listeners = new Set<() => void>();
type BackupResult = {
    id: string;
    ok: boolean;
    directoryName: string;
    projectTitle?: string;
    root?: string;
    available?: number;
    path?: string;
    complete?: boolean;
    missing?: number;
    exportedAt?: string;
    error?: string;
    projectId?: string;
    cacheWarning?: string;
    metrics?: BackupMetrics;
};
let state: {
    busy: boolean;
    pending: boolean;
    destinations: BackupStatus[];
    settingsLoaded?: boolean;
    taskId?: string;
    phase?: "running" | "success" | "incomplete" | "failed";
    result?: BackupResult;
    savedProjects?: ReturnType<typeof useCanvasStore.getState>["projects"];
    error?: string;
} = { busy: false, pending: false, destinations: [] };
let activeBackup: Promise<BackupResult> | undefined;
let activeScope: string | undefined;
let backupWorker: Worker | undefined;
const workerRequests = new Map<string, { resolve: (result: BackupResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
function failWorker(error: Error) {
    backupWorker?.terminate();
    backupWorker = undefined;
    for (const request of workerRequests.values()) {
        clearTimeout(request.timer);
        request.reject(error);
    }
    workerRequests.clear();
}
function getBackupWorker() {
    if (backupWorker) return backupWorker;
    const worker = new Worker(new URL("./canvas-disk-backup.worker.ts", import.meta.url), { type: "module" });
    backupWorker = worker;
    worker.onmessage = (event: MessageEvent<BackupResult>) => {
        const result = event.data,
            request = workerRequests.get(result.id);
        if (!request) return;
        workerRequests.delete(result.id);
        clearTimeout(request.timer);
        if (result.ok) request.resolve(result);
        else request.reject(Error(result.error || "后台备份失败"));
    };
    worker.onerror = () => {
        if (backupWorker === worker) failWorker(Error("备份后台任务异常，历史版本保留"));
    };
    return worker;
}
function workerTask(op: "backup" | "ensure" | "media", projects: ReturnType<typeof useCanvasStore.getState>["projects"], projectId?: string, id = crypto.randomUUID()): Promise<BackupResult> {
    return new Promise((resolve, reject) => {
        const worker = getBackupWorker();
        const timer = setTimeout(() => failWorker(Error("备份超过安全时限，已停止；历史版本保留，请检查目录与媒体状态")), 10 * 60 * 1000);
        workerRequests.set(id, { resolve, reject, timer });
        try {
            worker.postMessage({ id, op, projects, projectId });
        } catch (error) {
            clearTimeout(timer);
            workerRequests.delete(id);
            reject(error);
        }
    });
}
const directoryTasks = new Map<string, Promise<boolean>>();
export async function syncProjectDiskMedia(projectId: string) {
    const project = useCanvasStore.getState().openProject(projectId);
    if (!project) throw Error("画布尚未加载");
    const result = await workerTask("media", [project], projectId);
    if (!result.root) throw Error("无法读取画布资产目录");
    const separator = result.root.includes("\\") ? "\\" : "/";
    return {
        root: result.root,
        path: `${result.root}${separator}${result.directoryName}`,
        available: result.available ?? 0,
        missing: result.missing ?? 0,
    };
}
export function watchProjectDiskMedia(projectId: string) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;
    let lastKeys = "";
    let attempts = 0;
    let running = false;
    const schedule = () => {
        clearTimeout(timer);
        timer = setTimeout(async () => {
            const project = useCanvasStore.getState().openProject(projectId);
            if (!project || running || stopped) return;
            const keys = JSON.stringify([...collectBackupKeys(project)].sort());
            if (keys === lastKeys) return;
            running = true;
            try {
                const result = await syncProjectDiskMedia(projectId);
                lastKeys = keys;
                attempts = 0;
                if (result.missing) console.warn(`[画布资产目录] ${result.missing} 项素材暂时无法落盘`);
            } catch (error) {
                if (++attempts >= 3) {
                    console.warn("[画布资产目录] 自动同步失败，可在资产目录中重试", error);
                    return;
                }
            } finally {
                running = false;
            }
            if (!stopped) schedule();
        }, 1000);
    };
    const unsubscribe = useCanvasStore.subscribe((next, previous) => {
        const project = next.openProject(projectId);
        const before = previous.projects.find((item) => item.id === projectId);
        if (project && (project.nodes !== before?.nodes || project.chatSessions !== before?.chatSessions)) {
            attempts = 0;
            schedule();
        }
    });
    schedule();
    return () => {
        stopped = true;
        clearTimeout(timer);
        unsubscribe();
    };
}
export function ensureProjectBackup(projectId: string): Promise<boolean> {
    if (directoryTasks.has(projectId)) return directoryTasks.get(projectId)!;
    const task = (async () => {
        await loadBackupSettings();
        while (true) {
            const project = useCanvasStore.getState().projects.find((p) => p.id === projectId);
            if (!project) return false;
            const result = await workerTask("ensure", [project], projectId);
            const current = useCanvasStore.getState().projects.find((p) => p.id === projectId);
            if (!current) return false;
            if (current.title !== project.title) continue;
            // The numbered backup folder only supplies a name for an untitled canvas.
            if (!current.title && result.projectTitle) useCanvasStore.getState().renameProject(projectId, result.projectTitle);
            return true;
        }
    })().finally(() => directoryTasks.delete(projectId));
    directoryTasks.set(projectId, task);
    return task;
}
let loaded: Promise<void> | undefined;
export const subscribeBackup = (fn: () => void) => {
    listeners.add(fn);
    return () => {
        listeners.delete(fn);
    };
};
export const getBackupState = () => state;
function publish() {
    state = { ...state, destinations: [...state.destinations] };
    listeners.forEach((fn) => fn());
}
export function markBackupPending() {
    {
        state.pending = true;
        publish();
    }
}
export function loadBackupSettings() {
    return (loaded ||= (async () => {
        try {
            getBackupWorker();
        } catch {
            /* An explicit task reports startup failure. */
        }
        try {
            const status = await backupRequest<{ root: string; ready: boolean }>("/status");
            rootLabel = status.root;
            state.destinations[0] = { label: rootLabel, message: status.ready ? "统一目录已就绪" : "目录不可用，未写入其他目录", complete: false };
        } catch (error) {
            state.destinations[0] = { label: rootLabel, message: error instanceof Error ? error.message : String(error), complete: false };
        }
        state.settingsLoaded = true;
        publish();
    })());
}
/** Retained caller compatibility; no picker and no legacy-handle write fallback. */
export async function chooseBackupDirectory(_slot: number) {
    await backupRequest("/status");
}
export async function reauthorizeBackups() {
    await backupRequest("/status");
}
export async function backupIO(handle: FileSystemDirectoryHandle): Promise<BackupIO> {
    const base = await handle.getDirectoryHandle("无限画布备份", { create: true });
    async function parent(path: string, create: boolean) {
        const parts = path.split("/");
        if (parts.some((p) => !p || p === "." || p === ".." || /[\\:]/.test(p))) throw new Error("备份路径无效");
        let dir = base;
        for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create });
        return { dir, name: parts.at(-1)! };
    }
    return {
        async read(path) {
            try {
                const { dir, name } = await parent(path, false);
                return await (await dir.getFileHandle(name)).getFile();
            } catch (error) {
                if (error instanceof DOMException && error.name === "NotFoundError") return null;
                throw error;
            }
        },
        async write(path, blob) {
            const { dir, name } = await parent(path, true);
            const writer = await (await dir.getFileHandle(name, { create: true })).createWritable();
            try {
                await writer.write(blob);
                await writer.close();
            } catch (error) {
                await writer.abort().catch(() => undefined);
                throw error;
            }
        },
    };
}
export function runDiskBackup(_force = false, projectId?: string): Promise<BackupResult> {
    if (activeBackup) return activeScope === projectId ? activeBackup : Promise.reject(Error("另一个备份范围正在执行，请完成后重试"));
    activeScope = projectId;
    const id = crypto.randomUUID();
    state = { ...state, busy: true, taskId: id, phase: "running", error: undefined, result: undefined };
    publish();
    activeBackup = (async () => {
        await loadBackupSettings();
        if (!useCanvasStore.getState().hydrated) throw Error("画布尚未加载完成，请稍后备份");

        if (projectId) await ensureProjectBackup(projectId);
        const current = useCanvasStore.getState().projects;
        const projects = projectId ? current.filter((p) => p.id === projectId) : current;
        if (!projects.length) throw Error("没有画布可备份");
        state.destinations[0] = { label: rootLabel, message: "后台增量备份中…", complete: false };
        publish();
        const result = await workerTask("backup", projects, projectId, id);
        state.phase = result.complete ? "success" : "incomplete";
        state.result = result;
        state.savedProjects = projects;
        state.destinations[0] = {
            label: result.directoryName,
            message: result.complete ? result.cacheWarning || `备份完成，跳过 ${result.metrics?.skippedAssets || 0} 份未变素材` : `结构已保存，缺少 ${result.missing} 项媒体（不完整）`,
            verifiedAt: result.exportedAt,
            complete: !!result.complete,
        };
        if (useCanvasStore.getState().projects === current) state.pending = false;
        return result;
    })()
        .catch((error) => {
            state.phase = "failed";
            state.error = error instanceof Error ? error.message : String(error);
            state.destinations[0] = { label: rootLabel, message: `备份失败：${state.error}`, complete: false };
            throw error;
        })
        .finally(() => {
            activeBackup = undefined;
            state.busy = false;
            publish();
        });
    return activeBackup;
}
export type RecoverySource = { io: BackupIO; files: string[] };
export type RecoveryCatalogEntry = { sourceId: string; label: string; files: string[] };
export const listRecoverySources = async () => (await backupRequest<{ sources: RecoveryCatalogEntry[] }>("/recovery")).sources;
export const serverRecoverySource = (entry: RecoveryCatalogEntry): RecoverySource => ({ io: remoteRecoveryIO(entry.sourceId), files: entry.files });
export function startBackupRequestListener(projectIds: () => string[]) {
    const clientId = crypto.randomUUID();
    let stopped = false,
        running = false;
    const tick = async () => {
        if (stopped || running || getBackupState().busy) return;
        const ids = projectIds();
        if (!ids.length) return;
        running = true;
        try {
            const claim = await backupRequest<{ task: null | { id: string; projectId: string } }>("/requests/claim", { clientId, projectIds: ids });
            if (claim.task) {
                let response: unknown;
                try {
                    const result = await runDiskBackup(true, claim.task.projectId);
                    response = { clientId, ok: !!result.complete, result };
                } catch (error) {
                    response = { clientId, ok: false, error: error instanceof Error ? error.message : String(error) };
                }
                await backupRequest(`/requests/${claim.task.id}/result`, response);
            }
        } catch {
            /* No automatic resubmission; the server supplies a terminal request timeout. */
        } finally {
            running = false;
        }
    };
    const timer = setInterval(() => void tick(), 1500);
    void tick();
    return () => {
        stopped = true;
        clearInterval(timer);
    };
}
export async function chooseRecoverySource(): Promise<RecoverySource> {
    if (!window.showDirectoryPicker) throw new Error("浏览器不支持目录恢复");
    const handle = await window.showDirectoryPicker({ mode: "read", id: "canvas-backup-restore" });
    // The user selects the same parent directory used for backup. Never create anything during discovery.
    const base = handle.name === "无限画布备份" ? handle : await handle.getDirectoryHandle("无限画布备份");
    const snapshots = await base.getDirectoryHandle("snapshots").catch(() => {
        throw Error("此目录没有全库快照；当前画布备份请选择对应的“编号_日期_画布名称”项目目录");
    });
    const files: string[] = [];
    for await (const [name, entry] of (snapshots as unknown as { entries(): AsyncIterableIterator<[string, FileSystemHandle]> }).entries()) {
        if (entry.kind === "file" && /^(snapshot|structure)-[\w.-]+\.json$/.test(name)) files.push(`snapshots/${name}`);
    }
    const io: BackupIO = {
        write: async () => {
            throw new Error("恢复来源为只读");
        },
        read: async (path) => {
            if (!/^(snapshots\/[\w.-]+\.json|assets\/[a-f0-9]{64}\.bin)$/.test(path)) throw new Error("备份路径无效");
            const [dir, name] = path.split("/");
            return (await (await base.getDirectoryHandle(dir)).getFileHandle(name)).getFile();
        },
    };
    return { io, files: files.sort((a, b) => b.replace(/snapshots\/(snapshot|structure)-/, "").localeCompare(a.replace(/snapshots\/(snapshot|structure)-/, "")) || a.localeCompare(b)) };
}
export async function restoreDiskSnapshot(source: RecoverySource, path: string) {
    if (!useCanvasStore.getState().hydrated) throw new Error("浏览器存储尚未加载成功，停止导入；请先处理保存错误");
    const { data, blobs } = await readDiskSnapshot(source.io, path);
    const keys = new Map([...blobs.keys()].map((key) => [key, `${key.split(":")[0]}:restore-${crypto.randomUUID()}`]));
    // New media keys protect every existing canvas from collisions with an older snapshot.
    const remap = (value: unknown): unknown => {
        if (typeof value === "string") return keys.get(value) || value;
        if (Array.isArray(value)) return value.map(remap);
        if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, remap(item)]));
        return value;
    };
    for (const [key, blob] of blobs) await (key.startsWith("image:") ? setImageBlob(keys.get(key)!, blob) : setMediaBlob(keys.get(key)!, blob));
    for (const item of data.projects) useCanvasStore.getState().importProject(remap(item.project) as typeof item.project);
    await useCanvasStore.getState().flushPersist();
    return { projects: data.projects.length, missing: data.missing.length };
}

/** Repair media only: preserve current projects, keys, prompts and existing blobs. */
export async function repairMissingDiskMedia(source: RecoverySource, path: string, progress: (text: string) => void) {
    if (!useCanvasStore.getState().hydrated) throw new Error("画布尚未加载完成");
    progress("正在核验备份媒体…");
    const { blobs } = await readDiskSnapshot(source.io, path);
    const needed = collectBackupKeys(useCanvasStore.getState().projects);
    let restored = 0,
        present = 0,
        missing = 0;
    for (const key of needed) {
        if (key.startsWith("unbacked-url:")) {
            missing++;
            continue;
        }
        const load = key.startsWith("image:") ? getImageBlob : getMediaBlob;
        const existing = await load(key);
        if (existing) {
            present++;
            continue;
        }
        const blob = blobs.get(key);
        if (!blob) {
            missing++;
            continue;
        }
        await (key.startsWith("image:") ? setImageBlob(key, blob) : setMediaBlob(key, blob));
        const check = await load(key);
        if (!check || check.size !== blob.size || (await blobHash(check)) !== (await blobHash(blob))) throw new Error(`媒体回读失败；已补回 ${restored} 项，当前画布结构未改动`);
        restored++;
        progress(`已补回 ${restored} 项媒体，保留现有 ${present} 项`);
    }
    await useCanvasStore.getState().flushPersist();
    return { restored, present, missing };
}

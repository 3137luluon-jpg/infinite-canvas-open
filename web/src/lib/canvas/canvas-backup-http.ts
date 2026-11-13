import type { BackupIO } from "./canvas-disk-backup-core";
const BASE = "/__canvas-backup";
async function localBackupFetch(url: string, options: RequestInit) {
    try {
        return await fetch(url, options);
    } catch (error) {
        if ((error as Error).name === "TimeoutError" || (error as Error).name === "AbortError") throw Error("本地备份请求超时，任务已停止；历史版本保留");
        throw Error("无法连接本地备份服务，请确认画布服务已启动；未写入其他目录");
    }
}
async function requestError(response: Response, operation: string) {
    const detail = await response.json().catch(() => null);
    return Error(detail?.error || `${operation}（${response.status}），历史版本保留`);
}
export async function backupRequest<T>(path: string, data?: unknown): Promise<T> {
    const response = await localBackupFetch(`${BASE}${path}`, {
        method: data === undefined ? "GET" : "POST",
        headers: { "X-Canvas-Backup": "1", ...(data === undefined ? {} : { "Content-Type": "application/json" }) },
        body: data === undefined ? undefined : JSON.stringify(data),
        signal: AbortSignal.timeout(30000),
    });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result) throw Error(result?.error || `本地备份服务不可用（${response.status}），未写入其他目录`);
    return result as T;
}
export function remoteBackupIO(sessionId: string): BackupIO {
    const url = (path: string) => `${BASE}/file?${new URLSearchParams({ sessionId, path })}`;
    return {
        async read(path) {
            const r = await localBackupFetch(url(path), { headers: { "X-Canvas-Backup": "1" }, signal: AbortSignal.timeout(60000) });
            if (r.status === 404) return null;
            if (!r.ok) throw await requestError(r, "读取备份失败");
            return r.blob();
        },
        async stat(path) {
            const r = await localBackupFetch(url(path), { method: "HEAD", headers: { "X-Canvas-Backup": "1" }, signal: AbortSignal.timeout(30000) });
            if (r.status === 404) return null;
            if (!r.ok) throw Error(`读取备份索引失败 ${r.status}`);
            return { size: Number(r.headers.get("content-length")), lastModified: Number(r.headers.get("x-backup-mtime")) };
        },
        async write(path, blob) {
            const r = await localBackupFetch(url(path), { method: "PUT", headers: { "X-Canvas-Backup": "1", "Content-Type": "application/octet-stream" }, body: blob, signal: AbortSignal.timeout(120000) });
            if (!r.ok) throw await requestError(r, "写入备份失败");
        },
    };
}
export function remoteRecoveryIO(sourceId: string): BackupIO {
    return {
        write: async () => {
            throw Error("恢复来源只读");
        },
        read: async (path) => {
            const r = await localBackupFetch(`${BASE}/recovery/file?${new URLSearchParams({ sourceId, path })}`, { headers: { "X-Canvas-Backup": "1" }, signal: AbortSignal.timeout(120000) });
            if (r.status === 404) return null;
            if (!r.ok) throw Error(`历史备份读取失败 ${r.status}`);
            return r.blob();
        },
    };
}

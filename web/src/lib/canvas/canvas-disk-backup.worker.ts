/// <reference lib="webworker" />
import localforage from "localforage";
import { blobHash, collectBackupKeys, writeDiskSnapshot } from "./canvas-disk-backup-core";
import { backupRequest, remoteBackupIO } from "./canvas-backup-http";
import { getMediaBackupRevision } from "../../services/media-backup-revision";
import type { CanvasProject } from "../../stores/canvas/use-canvas-store";

const images = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
const media = localforage.createInstance({ name: "infinite-canvas", storeName: "media_files" });
const stored = (key: string) => (key.startsWith("image:") ? images : media).getItem<Blob | string>(key);
async function load(key: string): Promise<Blob | null> {
    if (key.startsWith("unbacked-url:")) return null;
    const value = await stored(key);
    if (!value) return null;
    if (value instanceof Blob) return value;
    if (!/^(data:|https?:\/\/)/.test(value)) return null;
    const fetchBlob = async (url: string) => {
        const response = await fetch(url, { signal: AbortSignal.timeout(15000) });
        if (!response.ok) throw Error(`媒体读取失败 ${response.status}`);
        return response.blob();
    };
    try {
        return await fetchBlob(value);
    } catch {
        if (value.startsWith("data:")) return null;
        return fetchBlob(`/__media-proxy?url=${encodeURIComponent(value)}`);
    }
}
const extensions: Record<string, string> = {
    "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif", "image/avif": "avif", "image/svg+xml": "svg", "image/bmp": "bmp",
    "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
    "audio/mpeg": "mp3", "audio/mp4": "m4a", "audio/aac": "aac", "audio/wav": "wav", "audio/x-wav": "wav", "audio/ogg": "ogg", "audio/webm": "webm", "audio/flac": "flac",
};
async function syncMedia(project: CanvasProject, sessionId: string) {
    const io = remoteBackupIO(sessionId);
    let available = 0, missing = 0;
    for (const key of collectBackupKeys(project)) {
        const revision = key.startsWith("unbacked-url:") ? null : await getMediaBackupRevision(key, () => stored(key));
        const blob = await load(key).catch(() => null);
        const mime = blob?.type.split(";")[0] || "";
        const extension = Object.hasOwn(extensions, mime) ? extensions[mime] : undefined;
        if (!blob?.size || !extension) {
            missing++;
            continue;
        }
        const folder = mime.startsWith("image/") ? "pic" : mime.startsWith("video/") ? "video" : "audio";
        const stable = revision && revision === await getMediaBackupRevision(key, () => stored(key));
        const hash = await blobHash(new Blob([key, "\n", stable ? revision : await blobHash(blob)]));
        const path = `${folder}/${hash}.${extension}`;
        if ((await io.stat!(path))?.size !== blob.size) await io.write(path, blob);
        available++;
    }
    return { available, missing };
}
const handleTask = async (event: MessageEvent<{ id: string; op: "backup" | "ensure" | "media"; projects: CanvasProject[]; projectId?: string }>) => {
    const { id, op, projects, projectId } = event.data;
    let sessionId: string | undefined;
    try {
        const project = projectId ? projects.find((p) => p.id === projectId) : null;
        if (projectId && !project) throw Error("找不到当前画布");
        const session = await backupRequest<{ sessionId: string; directoryName: string; projectTitle?: string; root: string }>("/begin", { project: project ? { id: project.id, title: project.title, createdAt: project.createdAt } : null, mediaOnly: op === "media" });
        sessionId = session.sessionId;
        if (op === "media" && project) {
            const result = await syncMedia(project, sessionId);
            await backupRequest("/finish", { sessionId });
            sessionId = undefined;
            self.postMessage({ id, ok: true, directoryName: session.directoryName, root: session.root, ...result });
            return;
        }
        if (op === "ensure") {
            await backupRequest("/finish", { sessionId });
            sessionId = undefined;
            self.postMessage({ id, ok: true, directoryName: session.directoryName, projectTitle: session.projectTitle });
            return;
        }
        const result = await writeDiskSnapshot(projects, remoteBackupIO(sessionId), load, { sourceRevision: (key) => (key.startsWith("unbacked-url:") ? Promise.resolve(null) : getMediaBackupRevision(key, () => stored(key))) });
        await backupRequest("/finish", { sessionId });
        sessionId = undefined;
        self.postMessage({
            id,
            ok: true,
            directoryName: session.directoryName,
            projectTitle: session.projectTitle,
            projectId,
            path: result.path,
            complete: result.snapshot.complete,
            missing: result.snapshot.missing.length,
            exportedAt: result.snapshot.exportedAt,
            metrics: result.metrics,
            cacheWarning: result.cacheWarning,
        });
    } catch (error) {
        self.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) });
    } finally {
        if (sessionId) await backupRequest("/finish", { sessionId }).catch(() => undefined);
    }
};

let tasks = Promise.resolve();
self.onmessage = (event) => {
    tasks = tasks.then(() => handleTask(event)).catch(() => undefined);
};

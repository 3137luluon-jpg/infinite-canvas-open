/**
 * 画布本地目录：只选一个根目录。
 * 生成媒体写入固定子目录 pic / video / audio（不存在则创建）。
 */
import localforage from "localforage";

import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { BoardProject } from "@/types/board";

export type CanvasMediaKind = "image" | "video" | "audio";

/** 兼容旧字段名：仅保留 root 展示名 */
export type CanvasFolderLabels = { root?: string };

type RootRecord = {
    projectId: string;
    label: string;
    handle: FileSystemDirectoryHandle;
};

const SUBDIRS: Record<CanvasMediaKind, string> = {
    image: "pic",
    video: "video",
    audio: "audio",
};

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "canvas_local_folders" });
const backupStore = localforage.createInstance({ name: "infinite-canvas", storeName: "canvas_media_backups" });

function rootKey(projectId: string) {
    return `root:${projectId}`;
}

export function supportsDirectoryPicker() {
    return typeof window !== "undefined" && typeof window.showDirectoryPicker === "function";
}

export async function pickCanvasRootFolder(projectId: string): Promise<string> {
    if (!supportsDirectoryPicker()) throw new Error("unsupported");
    const picker = window.showDirectoryPicker;
    if (!picker) throw new Error("unsupported");
    const handle = await picker.call(window, { mode: "readwrite", id: "canvas-local-root" });
    const permission = await ensureDirPermission(handle);
    if (!permission) throw new Error("denied");
    await Promise.all(Object.values(SUBDIRS).map((name) => getOrCreateSubdir(handle, name)));
    const label = handle.name;
    const record: RootRecord = { projectId, label, handle };
    await store.setItem(rootKey(projectId), record);
    return label;
}

export async function clearCanvasRootFolder(projectId: string) {
    await store.removeItem(rootKey(projectId));
}

export async function getCanvasRootFolderLabel(projectId: string) {
    const record = await store.getItem<RootRecord>(rootKey(projectId));
    return record?.label || "";
}

/** Background synchronization must never request permissions without a user gesture. */
export async function getCanvasMediaRoot(projectId: string, requestPermission = false) {
    const record = await store.getItem<RootRecord>(rootKey(projectId));
    if (!record?.handle) throw new Error("请先通过画布顶栏“本地目录”选择项目目录");
    const handle = record.handle as FileSystemDirectoryHandle & { queryPermission?: (options: { mode: "readwrite" }) => Promise<PermissionState> };
    if (requestPermission) {
        if (!await ensureDirPermission(handle)) throw new Error("项目目录未授权，请重新选择本地目录");
    } else if (handle.queryPermission && await handle.queryPermission({ mode: "readwrite" }) !== "granted") {
        throw new Error("项目目录权限已失效，请点击同步或重新选择本地目录");
    }
    return handle;
}

export async function loadCanvasFolderLabels(projectId: string): Promise<CanvasFolderLabels> {
    const root = await getCanvasRootFolderLabel(projectId);
    if (root) void ensureCanvasMediaFolders(projectId).catch(() => false);
    return root ? { root } : {};
}

async function getWritableRoot(projectId: string) {
    const record = await store.getItem<RootRecord>(rootKey(projectId));
    if (!record?.handle) return null;
    const ok = await ensureDirPermission(record.handle);
    return ok ? record.handle : null;
}

async function getOrCreateSubdir(root: FileSystemDirectoryHandle, name: string) {
    return root.getDirectoryHandle(name, { create: true });
}

export async function ensureCanvasMediaFolders(projectId: string) {
    const root = await getWritableRoot(projectId);
    if (!root) return false;
    await Promise.all(Object.values(SUBDIRS).map((name) => getOrCreateSubdir(root, name)));
    return true;
}

async function ensureDirPermission(handle: FileSystemDirectoryHandle) {
    const opts = { mode: "readwrite" as const };
    const withPermission = handle as FileSystemDirectoryHandle & {
        queryPermission?: (descriptor: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
        requestPermission?: (descriptor: { mode?: "read" | "readwrite" }) => Promise<PermissionState>;
    };
    if (withPermission.queryPermission && (await withPermission.queryPermission(opts)) === "granted") return true;
    if (withPermission.requestPermission && (await withPermission.requestPermission(opts)) === "granted") return true;
    return !withPermission.queryPermission;
}

function defaultExt(kind: CanvasMediaKind, blob: Blob, hint?: string) {
    if (hint) return hint.replace(/^\./, "");
    const mime = blob.type || "";
    if (kind === "image") {
        if (mime.includes("jpeg") || mime.includes("jpg")) return "jpg";
        if (mime.includes("webp")) return "webp";
        if (mime.includes("gif")) return "gif";
        return "png";
    }
    if (kind === "video") {
        if (mime.includes("webm")) return "webm";
        return "mp4";
    }
    if (mime.includes("mpeg") || mime.includes("mp3")) return "mp3";
    if (mime.includes("wav")) return "wav";
    if (mime.includes("ogg")) return "ogg";
    return "webm";
}

/** 写入 pic/video/audio；文件名为 UUID，不随节点改名 */
export async function writeGeneratedBlob(projectId: string, kind: CanvasMediaKind, blob: Blob, extensionHint?: string, sourceKey?: string) {
    const marker = sourceKey ? `${projectId}:${sourceKey}` : "";
    if (marker && (await backupStore.getItem(marker))) return true;
    const root = await getWritableRoot(projectId);
    if (!root) return false;
    const dir = await getOrCreateSubdir(root, SUBDIRS[kind]);
    const name = `${crypto.randomUUID()}.${defaultExt(kind, blob, extensionHint)}`;
    const file = await dir.getFileHandle(name, { create: true });
    const writable = await file.createWritable();
    await writable.write(blob);
    await writable.close();
    if (marker) await backupStore.setItem(marker, true);
    return true;
}

/** 重新授权根目录后，把当前画布尚未落盘的生成媒体补写一次。 */
export async function backupGeneratedCanvasMedia(projectId: string, nodes: CanvasNodeData[]) {
    const items: Array<{ kind: CanvasMediaKind; storageKey: string; extension: string }> = [];
    for (const node of nodes) {
        if (!node.metadata?.model && !node.metadata?.sourceVideoId) continue;
        if (node.type === CanvasNodeType.Image) {
            const images = node.metadata.images?.length ? node.metadata.images : [node.metadata];
            for (const image of images) {
                if (image.storageKey) items.push({ kind: "image", storageKey: image.storageKey, extension: image.mimeType?.includes("jpeg") ? "jpg" : "png" });
            }
        } else if (node.type === CanvasNodeType.Video && node.metadata.storageKey) {
            items.push({ kind: "video", storageKey: node.metadata.storageKey, extension: "mp4" });
        } else if (node.type === CanvasNodeType.Audio && node.metadata.storageKey) {
            items.push({ kind: "audio", storageKey: node.metadata.storageKey, extension: defaultExt("audio", new Blob([], { type: node.metadata.mimeType })) });
        }
    }
    let written = 0;
    for (const item of new Map(items.map((entry) => [entry.storageKey, entry])).values()) {
        const blob = item.kind === "image" ? await getImageBlob(item.storageKey).catch(() => null) : await getMediaBlob(item.storageKey).catch(() => null);
        if (blob && (await writeGeneratedBlob(projectId, item.kind, blob, item.extension, item.storageKey).catch(() => false))) written += 1;
    }
    return written;
}

/** 重新授权根目录后，把当前看板尚未落盘的故事板与视频补写一次。 */
export async function backupGeneratedBoardMedia(projectId: string, board: BoardProject) {
    const items: Array<{ kind: CanvasMediaKind; storageKey: string; extension: string }> = [];
    for (const shot of board.shots) for (const video of shot.videos) {
        if (video.storageKey) items.push({ kind: "video", storageKey: video.storageKey, extension: "mp4" });
        for (const storyboard of video.storyboards) if (storyboard.storageKey) items.push({ kind: "image", storageKey: storyboard.storageKey, extension: storyboard.mimeType?.includes("jpeg") ? "jpg" : "png" });
    }
    let written = 0;
    for (const item of new Map(items.map((entry) => [entry.storageKey, entry])).values()) {
        const blob = item.kind === "image" ? await getImageBlob(item.storageKey).catch(() => null) : await getMediaBlob(item.storageKey).catch(() => null);
        if (blob && (await writeGeneratedBlob(projectId, item.kind, blob, item.extension, item.storageKey).catch(() => false))) written += 1;
    }
    return written;
}

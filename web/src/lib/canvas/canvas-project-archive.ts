import type { CanvasProject } from "../../stores/canvas/use-canvas-store.ts";
import type { CanvasExportAsset, CanvasExportFile } from "../../types/canvas-export.ts";

import { createZip } from "../zip.ts";

export type CanvasExportBlobLoader = (storageKey: string) => Promise<Blob | null>;

export async function buildCanvasProjectsArchive(projects: CanvasProject[], loadBlob: CanvasExportBlobLoader, onMissing?: (count: number) => void) {
    if (!projects.length) throw new Error("no-projects");

    const zipFiles: { name: string; data: BlobPart }[] = [];
    const missing: Array<{ projectId: string; storageKey: string; reason: string }> = [];
    // Freeze the in-memory structure before waiting for media reads.
    projects = JSON.parse(JSON.stringify(projects));
    const usedPaths = new Set<string>();
    const uniqueZipPath = (path: string) => {
        if (!usedPaths.has(path)) {
            usedPaths.add(path);
            return path;
        }
        const dot = path.lastIndexOf(".");
        const stem = dot > 0 ? path.slice(0, dot) : path;
        const ext = dot > 0 ? path.slice(dot) : "";
        for (let index = 1; index < 1000; index += 1) {
            const candidate = `${stem}-${index}${ext}`;
            if (!usedPaths.has(candidate)) {
                usedPaths.add(candidate);
                return candidate;
            }
        }
        throw new Error("duplicate-zip-path");
    };

    const exportedProjects = await Promise.all(
        projects.map(async (project) => {
            const files: CanvasExportAsset[] = [];
            await Promise.all(
                collectStorageKeys(project).map(async (storageKey) => {
                    let blob: Blob | null = null;
                    let timer: ReturnType<typeof setTimeout> | undefined;
                    try {
                        blob = await Promise.race([loadBlob(storageKey), new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), 15000); })]);
                    } catch { /* Keep the structure even if IndexedDB has closed. */ }
                    finally { if (timer) clearTimeout(timer); }
                    if (!blob) { missing.push({ projectId: project.id, storageKey, reason: "媒体缺失、读取失败或超时" }); return; }
                    const path = uniqueZipPath(`projects/${project.id}/files/${safeCanvasExportFileName(storageKey)}.${canvasExportFileExtension(blob.type, storageKey)}`);
                    files.push({ storageKey, path, mimeType: blob.type || "application/octet-stream", bytes: blob.size });
                    zipFiles.push({ name: path, data: blob });
                }),
            );
            return { project, files };
        }),
    );

    const data: CanvasExportFile = { app: "infinite-canvas", version: 3, exportedAt: new Date().toISOString(), projects: exportedProjects };
    const zip = await createZip([{ name: "projects.json", data: JSON.stringify(data, null, 2) }, { name: "备份核对.json", data: JSON.stringify({ complete: missing.length === 0, missing }, null, 2) }, ...zipFiles]);
    onMissing?.(missing.length);
    return zip;
}

export function safeCanvasExportFileName(value: string) {
    return value.replace(/[\\/:*?"<>|]/g, "_").trim();
}

export function canvasExportFileExtension(mimeType: string, storageKey: string) {
    if (mimeType.includes("png")) return "png";
    if (mimeType.includes("jpeg")) return "jpg";
    if (mimeType.includes("webp")) return "webp";
    if (mimeType.includes("gif")) return "gif";
    if (mimeType.includes("mp4")) return "mp4";
    if (mimeType.includes("webm")) return "webm";
    if (mimeType.includes("mpeg") || mimeType.includes("mp3")) return "mp3";
    if (mimeType.includes("wav")) return "wav";
    if (mimeType.includes("ogg")) return "ogg";
    return storageKey.startsWith("image:") ? "png" : "bin";
}

function collectStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return [...keys];
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.includes(":")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectStorageKeys(child, keys)) : collectStorageKeys(item, keys)));
    return [...keys];
}

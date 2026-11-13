import { saveAs } from "file-saver";

import { getMediaBlob } from "@/services/file-storage";
import { getImageBlob } from "@/services/image-storage";

type DownloadFileInput = {
    source: string;
    filename: string;
    storageKey?: string;
};

export async function downloadFile({ source, filename, storageKey }: DownloadFileInput) {
    const blob = await readDownloadBlob({ source, storageKey });
    saveAs(blob, safeFilename(filename));
}

export async function readDownloadBlob({ source, storageKey }: Omit<DownloadFileInput, "filename">) {
    let blob: Blob | null = null;
    try {
        blob = storageKey?.startsWith("image:") ? await getImageBlob(storageKey) : storageKey ? await getMediaBlob(storageKey) : null;
    } catch {
        // 本地记录若仍指向已失效的旧远程地址，继续尝试节点当前可见地址。
    }
    if (!blob && source) blob = await fetchDownloadBlob(source);
    if (!blob) throw new Error("download source unavailable");
    return blob;
}

async function fetchDownloadBlob(source: string) {
    try {
        const response = await fetch(source);
        if (!response.ok) throw new Error(String(response.status));
        return response.blob();
    } catch (error) {
        if (!/^https:\/\//i.test(source)) throw error;
        const response = await fetch(`/__media-proxy?url=${encodeURIComponent(source)}`);
        if (!response.ok) throw new Error(String(response.status));
        return response.blob();
    }
}

function safeFilename(filename: string) {
    return filename.replace(/[\\/:*?"<>|]/g, "_");
}

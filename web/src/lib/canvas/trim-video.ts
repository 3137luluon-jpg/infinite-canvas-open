import { getMediaBlob, resolveMediaUrl } from "@/services/file-storage";

export type TrimmedVideo = { blob: Blob; extension: string };

export function videoFileExtension(mimeType?: string) {
    if (mimeType?.includes("webm")) return "webm";
    if (mimeType?.includes("quicktime")) return "mov";
    if (mimeType?.includes("matroska")) return "mkv";
    return "mp4";
}

/** Copy encoded media in a worker instead of playing and recording it in real time. */
export async function trimVideo(source: string, storageKey: string | undefined, start: number, end: number, onProgress?: (value: number) => void): Promise<TrimmedVideo> {
    let blob = storageKey ? await getMediaBlob(storageKey) : null;
    if (!blob) {
        const url = await resolveMediaUrl(storageKey, source);
        let response: Response;
        try {
            response = await fetch(url);
            if (!response.ok) throw new Error(String(response.status));
            blob = await response.blob();
        } catch (error) {
            if (!/^https?:/i.test(url)) throw error;
            response = await fetch(`/__media-proxy?url=${encodeURIComponent(url)}`);
            if (!response.ok) throw new Error("无法下载原视频，请稍后重试");
            blob = await response.blob();
        }
    }
    const worker = new Worker(new URL("./trim-video.worker.ts", import.meta.url), { type: "module" });
    try {
        return await new Promise<TrimmedVideo>((resolve, reject) => {
            worker.onmessage = (event: MessageEvent<Partial<TrimmedVideo> & { progress?: number; error?: string }>) => {
                if (event.data.error) reject(new Error(event.data.error));
                else if (event.data.blob && event.data.extension) resolve({ blob: event.data.blob, extension: event.data.extension });
                else if (event.data.progress !== undefined) onProgress?.(event.data.progress);
            };
            worker.onerror = (event) => {
                event.preventDefault();
                reject(new Error("视频截取组件发生错误，本次未添加片段，请重试"));
            };
            worker.onmessageerror = () => reject(new Error("视频截取数据传输失败"));
            worker.postMessage({ blob, start, end });
        });
    } finally {
        worker.terminate();
    }
}

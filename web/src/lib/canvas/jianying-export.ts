import { readDownloadBlob } from "@/lib/download-file";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import { videoFileExtension } from "./trim-video";

export class JianyingExportError extends Error {}

async function loadVideoReader(): Promise<typeof import("mediabunny")> {
    try {
        if (import.meta.env.DEV) {
            // The running canvas can outlive Vite's optimized dependency cache.
            // Use the package's standalone browser bundle for this on-demand reader.
            const url = `${import.meta.env.BASE_URL}node_modules/mediabunny/dist/bundles/mediabunny.min.mjs`;
            return await import(/* @vite-ignore */ url);
        }
        return await import("mediabunny");
    } catch (cause) {
        throw new JianyingExportError("视频读取组件没能加载，草稿尚未写入。请先刷新画布，再重新选片导出。", { cause });
    }
}

export function canExportToJianying(node: CanvasNodeData) {
    return node.type === CanvasNodeType.Video && Boolean(node.metadata?.content || node.metadata?.storageKey)
        && node.metadata?.status !== "loading" && node.metadata?.status !== "error";
}

export async function exportJianyingDraft(name: string, nodes: CanvasNodeData[], onProgress: (text: string) => void) {
    const { Input, BlobSource, ALL_FORMATS } = await loadVideoReader();
    const blobs: Blob[] = [];
    const clips = [];
    for (const [index, node] of nodes.entries()) {
        const title = node.title || `视频 ${index + 1}`;
        onProgress(`正在读取视频 ${index + 1} / ${nodes.length}`);
        try {
            const blob = await readDownloadBlob({ source: node.metadata?.content || "", storageKey: node.metadata?.storageKey });
            const input = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
            try {
                const video = await input.getPrimaryVideoTrack();
                if (!video) throw new JianyingExportError("文件没有视频轨道");
                const [width, height, duration, format] = await Promise.all([
                    video.getDisplayWidth(), video.getDisplayHeight(), video.getDurationFromMetadata().then((value) => value ?? input.computeDuration([video])), input.getFormat(),
                ]);
                if (!Number.isFinite(duration) || duration <= 0) throw new JianyingExportError("无法读出视频时长");
                if (!/^video\/(mp4|quicktime|webm|x-matroska)$/.test(format.mimeType)) throw new JianyingExportError("请使用 MP4、MOV、WebM 或 MKV 视频");
                clips.push({ title: title.slice(0, 120), width, height, duration: Math.round(duration * 1e6), bytes: blob.size, extension: videoFileExtension(format.mimeType) });
                blobs.push(blob);
            } finally {
                input.dispose();
            }
        } catch (cause) {
            const detail = cause instanceof JianyingExportError ? cause.message : "请确认这段视频能在画布里播放，必要时重新导入原文件";
            throw new JianyingExportError(`「${title}」读取失败：${detail}。`, { cause });
        }
    }

    const manifest = new TextEncoder().encode(JSON.stringify({ name, clips }));
    const header = new DataView(new ArrayBuffer(4));
    header.setUint32(0, manifest.byteLength);
    onProgress("正在写入剪映草稿…");
    const response = await fetch("/__jianying/export", {
        method: "POST",
        headers: { "X-Canvas-Jianying": "1" },
        body: new Blob([header.buffer, manifest, ...blobs], { type: "application/octet-stream" }),
    }).catch((cause) => {
        throw new JianyingExportError("导出时与本机服务的连接中断了。请先到剪映首页检查草稿是否已生成，再重试。", { cause });
    });
    const result = await response.json().catch(() => null) as { name?: string; error?: string } | null;
    if (!response.ok || !result?.name) throw new JianyingExportError(result?.error || "剪映导出服务没有正常响应。请确认本机画布正在运行，再重试。");
    return result.name;
}

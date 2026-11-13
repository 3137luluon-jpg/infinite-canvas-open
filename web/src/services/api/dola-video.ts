import axios from "axios";
import { buildDolaVideoBody, dolaApiUrl, readDolaTask, type DolaTask } from "@/lib/dola-video";
import type { AiConfig } from "@/stores/use-config-store";

type Reference = { name: string; type: string; url: string };
function headers(config: AiConfig) { return config.apiKey.trim() ? { Authorization: `Bearer ${config.apiKey}` } : undefined; }

export async function submitDolaVideo(config: AiConfig, prompt: string, references: { images: Reference[]; videos: Reference[]; audios: Reference[] }, signal?: AbortSignal) {
    // Validate model, duration, ratio and counts before any upload or billable submission.
    buildDolaVideoBody(config.model, prompt, config.videoSeconds, config.size, { images: references.images.map(r => r.name), videos: references.videos.map(r => r.name), audios: references.audios.map(r => r.name) });
    const paths = { images: [] as string[], videos: [] as string[], audios: [] as string[] };
    for (const kind of ["images", "videos", "audios"] as const) {
        if (!references[kind].length) continue;
        const form = new FormData();
        for (const reference of references[kind]) {
            const response = await fetch(reference.url, { signal });
            if (!response.ok) throw new Error(`读取 DOLA 参考素材失败：${response.status}`);
            const blob = await response.blob();
            const extension = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "image/apng": "apng", "video/mp4": "mp4", "video/quicktime": "mov", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav" } as Record<string, string>)[blob.type || reference.type];
            if (!extension) throw new Error(`DOLA 不支持素材格式 ${blob.type || reference.type}，请使用 JPG/PNG/WebP、MP4/MOV 或 MP3/WAV`);
            form.append("files", blob, `${kind}-${paths[kind].length}-${form.getAll("files").length}.${extension}`);
        }
        const uploaded = (await axios.post<{ paths?: string[]; error?: string }>(dolaApiUrl(config.baseUrl, "upload"), form, { headers: headers(config), signal })).data;
        if (!uploaded.paths || uploaded.paths.length !== references[kind].length) throw new Error(uploaded.error || "DOLA 素材上传数量不一致，未提交生成");
        paths[kind] = uploaded.paths;
    }
    const body = buildDolaVideoBody(config.model, prompt, config.videoSeconds, config.size, paths);
    const result = (await axios.post<{ taskId?: string; error?: string }>(dolaApiUrl(config.baseUrl, "tasks/submit"), body, { headers: headers(config), signal })).data;
    if (!result.taskId) throw new Error(result.error || "DOLA 未返回任务编号，请在控制台确认任务后再决定是否重试");
    return { id: result.taskId, statusUrl: dolaApiUrl(config.baseUrl, `tasks/${encodeURIComponent(result.taskId)}`) };
}

export async function pollDolaVideo(config: AiConfig, id: string, signal?: AbortSignal) {
    const task = (await axios.get<DolaTask>(dolaApiUrl(config.baseUrl, `tasks/${encodeURIComponent(id)}`), { headers: headers(config), signal })).data;
    return readDolaTask(task);
}

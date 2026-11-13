/** Contract exposed by the local DOLA 4.9.5 dashboard (not the Ark API). */
export const DOLA_BASE_URL = "http://127.0.0.1:5600/api";
export const DOLA_CHANNEL_ID = "dola-local";
export const DOLA_MODELS = ["Seedance 2.5", "Seedance 2.0 Fast"] as const;
export const DOLA_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];

export function dolaApiUrl(baseUrl: string, path: string) {
    const url = new URL(baseUrl);
    if (!/^https?:$/.test(url.protocol)) throw new Error("DOLA 地址必须使用 HTTP 或 HTTPS");
    url.search = "";
    url.hash = "";
    url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/(?:api|dashboard)$/, "") + "/api/" + path.replace(/^\/+/, "");
    return url.toString();
}

export function dolaDurations(model: string) {
    return model === "Seedance 2.5" ? [10, 30] : [5, 10, 15];
}

export function dolaRatio(size: string) {
    const ratio = ({ "1280x720": "16:9", "720x1280": "9:16", "1024x1024": "1:1", auto: "16:9", adaptive: "16:9", "": "16:9" } as Record<string, string>)[size] || size;
    if (!DOLA_RATIOS.includes(ratio)) throw new Error(`DOLA 不支持比例 ${size}，请选择画幅比例`);
    return ratio;
}

export function buildDolaVideoBody(model: string, prompt: string, seconds: string, size: string, paths: { images: string[]; videos: string[]; audios: string[] } = { images: [], videos: [], audios: [] }) {
    if (!(DOLA_MODELS as readonly string[]).includes(model)) throw new Error(`DOLA 暂不支持模型 ${model}`);
    if (!prompt.trim()) throw new Error("请填写视频提示词");
    const duration = !seconds || seconds === "auto" ? 10 : Number(seconds);
    if (!dolaDurations(model).includes(duration)) throw new Error(`${model} 仅支持 ${dolaDurations(model).join(" / ")} 秒，请在视频设置中选择`);
    if (paths.images.length > 30 || paths.videos.length > 10 || paths.audios.length > 10) throw new Error("DOLA 最多支持 30 张图片、10 段视频和 10 段音频");
    if (model !== "Seedance 2.5" && (paths.videos.length || paths.audios.length)) throw new Error("DOLA 参考视频和音频仅支持 Seedance 2.5");
    return { taskType: "SubmitPrompt", params: { platform: "dola", model, prompt, duration, mode: "video", aspectRatio: dolaRatio(size), referenceImages: paths.images, referenceVideos: paths.videos, referenceAudios: paths.audios } };
}

export type DolaTask = { taskId?: string; status?: string; progress?: number; error?: string; stageMessage?: string; result?: { url?: string; videoUrl?: string; video_url?: string; path?: string } | null };
export function readDolaTask(task: DolaTask): { status: "pending"; progress?: number } | { status: "completed"; url: string } | { status: "failed"; error: string } {
    if (task.status === "failed" || task.status === "cancelled") return { status: "failed", error: task.error || task.stageMessage || "DOLA 任务失败或已取消" };
    if (task.status === "success") {
        const url = task.result?.url || task.result?.videoUrl || task.result?.video_url;
        if (url && /^https?:\/\//i.test(url)) return { status: "completed", url };
        return { status: "failed", error: task.result?.path ? `DOLA 已生成并保存到 ${task.result.path}，但接口未返回可下载链接。请将该文件导入画布；不要重复生成。` : "DOLA 报告完成，但没有返回视频文件或下载链接" };
    }
    if (!["pending", "running", "waiting", "retrying", "paused"].includes(task.status || "")) throw new Error("DOLA 返回了未知任务状态");
    // During DOLA's own retries an earlier error may remain populated. Do not resubmit.
    return { status: "pending", progress: task.progress };
}

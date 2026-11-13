/** RunningHub 标准模型 API；仅适配用户指定接口，不自动替换模型。 */
export const RUNNINGHUB_BASE_URL = "https://www.runninghub.ai";
export const RUNNINGHUB_VIDEO_MODEL = "bytedance/seedance-2.0-global-token/multimodal-video";
export const RUNNINGHUB_VIDEO_ALIAS = "Seedance 2.0 Global · Token";
export const RUNNINGHUB_RATIOS = ["adaptive", "16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];
export const RUNNINGHUB_RESOLUTIONS = ["480p", "720p", "1080p"];

export function isRunningHubConfig(config: { baseUrl: string; apiFormat?: string }) {
    try {
        const url = new URL(config.baseUrl.trim());
        return (!config.apiFormat || config.apiFormat === "openai") && url.protocol === "https:" && ["www.runninghub.ai", "runninghub.ai", "www.runninghub.cn", "runninghub.cn"].includes(url.hostname) && !url.port && !url.username && !url.password && ["/", "/openapi/v2", "/openapi/v2/"].includes(url.pathname) && !url.search && !url.hash;
    } catch { return false; }
}

export function runningHubUrl(baseUrl: string, path: string) {
    if (!isRunningHubConfig({ baseUrl })) throw new Error("RunningHub 地址请填写 https://www.runninghub.ai");
    return new URL(path, baseUrl).toString();
}

export type RunningHubVideoInput = {
    prompt: string;
    seconds: number;
    ratio: string;
    resolution: string;
    generateAudio: boolean;
    images: string[];
    videos: string[];
    audios: string[];
};

export function buildRunningHubVideoBody(model: string, input: RunningHubVideoInput) {
    if (model !== RUNNINGHUB_VIDEO_MODEL) throw new Error("RunningHub 当前只适配 Seedance 2.0 Global Token 多模态视频，请选择渠道预设模型");
    if (!input.prompt.trim()) throw new Error("请填写 RunningHub 视频提示词");
    if (!Number.isInteger(input.seconds) || input.seconds < 4 || input.seconds > 15) throw new Error("RunningHub Seedance 视频时长必须为 4–15 秒");
    if (!RUNNINGHUB_RESOLUTIONS.includes(input.resolution)) throw new Error("RunningHub 当前请选择 480P、720P 或 1080P");
    if (!RUNNINGHUB_RATIOS.includes(input.ratio)) throw new Error("RunningHub 不支持当前画幅，请重新选择比例");
    if (input.images.length > 9 || input.videos.length > 3 || input.audios.length > 3) throw new Error("RunningHub 最多支持 9 张图片、3 段视频和 3 段音频，未提交生成");
    if (input.audios.length && !input.images.length && !input.videos.length) throw new Error("参考音频需要同时连接图片或视频");
    // 画布解析 @ 芯片后输出“图片1”等标签；仅转换引用语法，编号与分类数组顺序相同。
    const counts: Record<string, number> = { Image: input.images.length, Video: input.videos.length, Audio: input.audios.length };
    const prompt = input.prompt.replace(/@?(图片|图像|视频|音频)\s*(\d+)(?!\d)|@(Image|Video|Audio)\s*(\d+)(?!\d)/gi, (_match, chineseKind: string, chineseNumber: string, englishKind: string, englishNumber: string) => {
        const kind = chineseKind || englishKind;
        const number = chineseNumber || englishNumber;
        const label = ({ 图片: "Image", 图像: "Image", 视频: "Video", 音频: "Audio", image: "Image", video: "Video", audio: "Audio" } as Record<string, string>)[kind.toLowerCase()];
        const index = Number(number);
        if (index < 1 || index > counts[label]) throw new Error(`RunningHub 提示词引用 @${label} ${index}，但没有对应素材，未提交生成`);
        return `@${label} ${index}`;
    });
    return {
        prompt, resolution: input.resolution, duration: String(input.seconds),
        imageUrls: input.images, videoUrls: input.videos, audioUrls: input.audios,
        generateAudio: input.generateAudio, ratio: input.ratio,
        realPersonMode: true, conversionSlots: ["all"], returnLastFrame: false, seed: -1,
    };
}

export function runningHubError(body: Record<string, unknown>, key = "") {
    const code = String(body.errorCode || body.code || "");
    let detail = String(body.errorMessage || body.message || body.msg || "请求失败");
    if (code === "1014") detail = "此模型需要「企业级－共享 API Key」，请在 RunningHub 个人账户下创建该类型密钥后更新渠道";
    if (code === "40311") detail = "当前 API Key 尚未开通此接口权限，请联系 RunningHub 平台开通 Seedance 2.0 Global Token 多模态视频权限，或更换已开通的企业级－共享 Key";
    if (key) detail = detail.replaceAll(key, "[已隐藏]");
    return `RunningHub${code ? ` ${code}` : ""}：${detail.slice(0, 500)}`;
}

export function readRunningHubVideoState(body: Record<string, unknown>, key = ""): { status: "pending" } | { status: "completed"; url: string } | { status: "failed"; error: string } {
    const status = String(body.status || "").toUpperCase();
    if (status === "FAILED" || status === "CANCELLED" || (body.errorCode && !["0", "200"].includes(String(body.errorCode)))) return { status: "failed", error: runningHubError(body, key) };
    if (status === "SUCCESS") {
        const results = Array.isArray(body.results) ? body.results as { url?: string; outputType?: string }[] : [];
        const video = results.find(item => /^(mp4|webm|mov|m4v|video\/.+)$/i.test(item.outputType || "") && typeof item.url === "string") || results.find(item => /\.(mp4|webm|mov|m4v)(?:[?#]|$)/i.test(item.url || ""));
        if (!video?.url || !/^https?:\/\//i.test(video.url)) throw new Error("RunningHub 任务已完成但缺少视频地址，请继续查询原任务，不要重新生成");
        return { status: "completed", url: video.url };
    }
    if (status === "QUEUED" || status === "RUNNING") return { status: "pending" };
    throw new Error(`RunningHub 返回未知任务状态：${status || "空"}，请查询原任务，不要重复提交`);
}

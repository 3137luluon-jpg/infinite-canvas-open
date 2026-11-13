/** Agnes 官方 API 文档，核对于 2026-09-30。仅按官方域名分流，不影响其他兼容渠道。 */
export const AGNES_BASE_URL = "https://apihub.agnes-ai.com/v1";
export const AGNES_IMAGE_MODEL = "agnes-image-2.5-flash";
export const AGNES_VIDEO_MODEL = "agnes-video-2.5-flash";
export const AGNES_IMAGE_RATIOS = ["1:1", "3:4", "4:3", "16:9", "9:16", "2:3", "3:2", "21:9"];
export const AGNES_VIDEO_RATIOS = ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"];

export function isAgnesConfig(config: { baseUrl: string; apiFormat?: string }) {
    try {
        const url = new URL(config.baseUrl.trim());
        return (!config.apiFormat || config.apiFormat === "openai") && url.protocol === "https:" && url.hostname === "apihub.agnes-ai.com" && !url.port && !url.username && !url.password;
    } catch { return false; }
}

export function agnesRatio(value: string | undefined, video = false) {
    const allowed = video ? AGNES_VIDEO_RATIOS : AGNES_IMAGE_RATIOS;
    if (!value || value === "auto" || value === "adaptive") return video ? "16:9" : "1:1";
    if (allowed.includes(value)) return value;
    const pixels = value.match(/^(\d+)x(\d+)$/i);
    if (pixels && Number(pixels[1]) > 0 && Number(pixels[2]) > 0) {
        const ratio = Number(pixels[1]) / Number(pixels[2]);
        return allowed.reduce((best, next) => {
            const distance = (item: string) => { const [w, h] = item.split(":").map(Number); return Math.abs(w / h - ratio); };
            return distance(next) < distance(best) ? next : best;
        });
    }
    throw new Error(`Agnes 不支持画幅 ${value}，请选择 ${allowed.join("、")}`);
}

export function buildAgnesImageBody(input: { model: string; prompt: string; size?: string; quality?: string; images?: string[] }) {
    if (!/^agnes-image-2\.(0|1|5)-flash$/.test(input.model)) throw new Error("当前 Agnes 图片适配支持 Image 2.0 / 2.1 / 2.5 Flash");
    const quality = (input.quality || "1k").toLowerCase();
    const size = ({ low: "1K", standard: "1K", medium: "2K", hd: "2K", high: "4K", "1k": "1K", "2k": "2K", "3k": "3K", "4k": "4K" } as Record<string, string>)[quality];
    if (!size) throw new Error("Agnes 图片分辨率请选择 1K、2K、3K 或 4K");
    // curl 文档明确要求 image 和 response_format 放入 extra_body，而非顶层。
    return {
        model: input.model, prompt: input.prompt, size, ratio: agnesRatio(input.size),
        ...(input.images?.length
            ? { extra_body: { image: input.images, response_format: "b64_json" } }
            : { return_base64: true }),
    };
}

function publicMediaUrl(value: string) {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("Agnes 视频参考素材需要公网 HTTP(S) 地址；本地素材请先上传后再引用，或先使用纯文字生成。"); }
    const host = url.hostname.toLowerCase();
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.|\[)/.test(host) || host.endsWith(".local")) {
        throw new Error("Agnes 视频参考素材需要公网 HTTP(S) 地址；暂不支持本地、Blob 或 Base64 素材，请先使用纯文字生成。");
    }
    return value;
}

export function buildAgnesVideoBody(input: { model: string; prompt: string; seconds: number; size?: string; images?: string[]; audios?: string[]; videos?: string[] }) {
    if (input.model !== AGNES_VIDEO_MODEL) throw new Error(`当前 Agnes 视频适配仅支持 ${AGNES_VIDEO_MODEL}，不自动切换付费模型`);
    if (!Number.isInteger(input.seconds) || input.seconds < 4 || input.seconds > 12) throw new Error("Agnes Flash 视频时长必须为 4–12 秒");
    if (input.videos?.length) throw new Error("Agnes Flash 不支持参考视频");
    if ((input.images?.length || 0) > 5 || (input.audios?.length || 0) > 3) throw new Error("Agnes Flash 最多支持 5 张参考图片和 3 段参考音频");
    const images = (input.images || []).map(publicMediaUrl);
    const audios = (input.audios || []).map(publicMediaUrl);
    return {
        model: input.model, prompt: input.prompt, seconds: String(input.seconds), size: "720P",
        aspect_ratio: agnesRatio(input.size, true), mode: images.length || audios.length ? "reference" : "text", n: 1,
        ...(images.length ? { images } : {}), ...(audios.length ? { audios } : {}),
    };
}

export function agnesVideoStatusUrl(baseUrl: string, videoId: string, model: string) {
    if (!isAgnesConfig({ baseUrl })) throw new Error("Agnes 接口地址必须使用 https://apihub.agnes-ai.com/v1");
    if (!videoId.trim()) throw new Error("Agnes 未返回 video_id，无法查询；请检查平台任务记录，不要自动重复提交");
    const url = new URL("/agnesapi", baseUrl);
    url.searchParams.set("video_id", videoId);
    url.searchParams.set("model_name", model);
    return url.toString();
}

export function readAgnesVideoState(body: Record<string, unknown>): { status: "pending"; progress?: number } | { status: "completed"; url: string } | { status: "failed"; error: string } {
    // internal_status 在 completed 时仍可能为 pending，绝不能据此判断任务状态。
    if (body.status === "failed" || body.status === "cancelled") {
        const error = body.error;
        return { status: "failed", error: typeof error === "string" ? error : String((error as { message?: string } | null)?.message || "Agnes 视频生成失败") };
    }
    if (body.status === "completed") {
        if (typeof body.url !== "string" || !/^https?:\/\//.test(body.url)) throw new Error("Agnes 任务已完成但未返回视频地址，请继续查询原任务，不要重新生成");
        return { status: "completed", url: body.url };
    }
    if (body.status !== "queued" && body.status !== "in_progress") throw new Error(`Agnes 返回未知任务状态：${String(body.status || "空")}`);
    return { status: "pending", ...(typeof body.progress === "number" && Number.isFinite(body.progress) ? { progress: Math.max(0, Math.min(100, body.progress)) } : {}) };
}

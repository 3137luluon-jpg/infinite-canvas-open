// Contract verified against AutoDL's public workflow metadata and API form, 2026-09-12.
export const AUTODL_WORKFLOW_ID = "minimax_h3_zm_u24";
export const AUTODL_WORKFLOW_NAME = "H3多图多音频生视频（升级画质）";
export const AUTODL_BASE_URL = "https://autodl.art";

type Config = { baseUrl: string; apiKey: string };
type Envelope = {
    code?: string;
    msg?: string;
    error?: { message?: string };
    data?: { task_id?: string; status?: string; message?: string; results?: { url?: string; type?: string }[] };
};

export function autodlVideoSettings(size: string, quality: string) {
    const ratio = ["9:16", "720x1280"].includes(size) ? "9:16" : ["1:1", "1024x1024"].includes(size) ? "1:1" : "16:9";
    const resolution = ["480", "480p", "low"].includes(quality.toLowerCase()) ? "480p" : "768p";
    return { ratio, resolution, apiResolution: `${resolution}${ratio === "1:1" ? "(1:1)" : ratio === "9:16" ? "竖" : "横"}` };
}

export function buildAutodlVideoBody(input: { prompt: string; seconds: number; size: string; quality: string; images: string[]; audios: string[]; videoCount: number }) {
    if (!input.prompt.trim() || [...input.prompt].length > 10000) throw new Error("AutoDL H3 提示词需要 1–10000 个字符");
    if (input.images.length < 1 || input.images.length > 9) throw new Error("AutoDL H3 需要连接 1–9 张参考图片");
    if (input.audios.length > 3) throw new Error("AutoDL H3 最多支持 3 段参考音频");
    if (input.videoCount) throw new Error("此 AutoDL H3 工作流只支持图片和音频参考，请断开参考视频");
    if (!Number.isInteger(input.seconds) || input.seconds < 1 || input.seconds > 15) throw new Error("AutoDL H3 时长需要为 1–15 秒");
    const body: Record<string, string | number> = { prompt: input.prompt, duration: input.seconds, resolution: autodlVideoSettings(input.size, input.quality).apiResolution, seed: Math.floor(Math.random() * 999999999999999) };
    for (const [kind, values] of [["image", input.images], ["audio", input.audios]] as const) {
        values.forEach((value, index) => {
            const dataPattern = kind === "image" ? /^data:image\/(jpeg|png|webp);base64,/i : /^data:audio\/(mpeg|wav|x-wav|flac);base64,/i;
            if (!/^https?:\/\//i.test(value) && !dataPattern.test(value)) throw new Error(kind === "image" ? "AutoDL 参考图需为 JPG、PNG 或 WebP" : "AutoDL 参考音频需为 MP3、WAV 或 FLAC");
            body[`ref_${kind}_${index}`] = value.replace(/^data:audio\/x-wav;/i, "data:audio/wav;");
        });
    }
    return body;
}

function endpoint(config: Config, suffix: string) {
    const url = new URL(config.baseUrl);
    if (url.protocol !== "https:" || !["autodl.art", "www.autodl.art"].includes(url.hostname) || url.port || url.username || url.password) throw new Error("AutoDL 接口地址请填写 https://autodl.art");
    return `${url.origin}/api/v1/comfyui/comfyui_workflow/${suffix}`;
}

async function request(config: Config, suffix: string, signal?: AbortSignal, body?: Record<string, string | number>) {
    if (!config.apiKey.trim()) throw new Error("请先在 AutoDL 工作流渠道填写 ComfyUI 分组的令牌");
    const response = await fetch(endpoint(config, suffix), {
        method: body ? "POST" : "GET",
        headers: { Authorization: config.apiKey.trim(), ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal,
        redirect: "error",
    });
    const result: Envelope = await response.json();
    if (!response.ok || result.code !== "Success" || result.error || !result.data) throw new Error(result.error?.message || result.msg || `AutoDL 请求失败（HTTP ${response.status}）`);
    return result.data;
}

export async function submitAutodlVideo(config: Config, workflowId: string, body: Record<string, string | number>, signal?: AbortSignal) {
    if (workflowId !== AUTODL_WORKFLOW_ID) throw new Error("当前 AutoDL 适配支持 minimax_h3_zm_u24，请选择升级画质工作流");
    // A submission is never retried automatically: a lost response may already be a billed task.
    const data = await request(config, encodeURIComponent(workflowId), signal, body);
    if (!data.task_id?.trim()) throw new Error("AutoDL 未返回 task_id，请查看平台调用日志，勿直接重复提交");
    return { id: data.task_id.trim(), workflowId, submittedAt: Date.now(), inputSnapshot: Object.fromEntries(Object.entries(body).map(([key, value]) => [key, key.startsWith("ref_") ? "[参考素材]" : value])) };
}

export async function pollAutodlVideo(config: Config, taskId: string, signal?: AbortSignal) {
    const data = await request(config, `result/${encodeURIComponent(taskId)}`, signal);
    const status = data.status?.toUpperCase();
    if (status === "QUEUED" || status === "RUNNING") return { status: "pending" as const };
    if (status === "SUCCESS" || status === "COMPLETED") {
        const url = data.results?.find((item) => item.type === "video" && /^https?:\/\//i.test(item.url || ""))?.url;
        if (!url) throw new Error("AutoDL 任务已完成但没有有效的视频结果");
        return { status: "completed" as const, url };
    }
    return { status: "failed" as const, error: data.message || `AutoDL 任务状态：${status || "未知"}（${taskId}）` };
}

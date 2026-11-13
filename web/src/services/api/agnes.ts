import { agnesVideoStatusUrl, buildAgnesImageBody, buildAgnesVideoBody, isAgnesConfig, readAgnesVideoState } from "../../lib/agnes.ts";

type Config = { baseUrl: string; apiKey: string; model: string };
async function agnesJson(config: Config, url: string, body?: unknown, signal?: AbortSignal) {
    if (!isAgnesConfig(config)) throw new Error("Agnes 接口地址必须使用 https://apihub.agnes-ai.com/v1");
    if (!config.apiKey.trim()) throw new Error("请先在 Agnes 渠道填写 API Key");
    const response = await fetch(url, {
        method: body === undefined ? "GET" : "POST", signal,
        headers: { Authorization: `Bearer ${config.apiKey}`, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const result = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!response.ok || !result || (result.error && result.status !== "failed" && result.status !== "cancelled")) {
        const error = result?.error;
        const detail = typeof error === "string" ? error : (error as { message?: string } | null)?.message || result?.detail || result?.message;
        const text = typeof detail === "string" ? detail.replaceAll(config.apiKey, "[已隐藏]").slice(0, 600) : "请求失败";
        throw new Error(`Agnes HTTP ${response.status}：${text}`);
    }
    return result;
}

export async function generateAgnesImage(config: Config, input: Omit<Parameters<typeof buildAgnesImageBody>[0], "model">, signal?: AbortSignal) {
    return agnesJson(config, new URL("/v1/images/generations", config.baseUrl).toString(), buildAgnesImageBody({ ...input, model: config.model }), signal);
}

export async function submitAgnesVideo(config: Config, input: Omit<Parameters<typeof buildAgnesVideoBody>[0], "model">, signal?: AbortSignal) {
    const body = await agnesJson(config, new URL("/v1/videos", config.baseUrl).toString(), buildAgnesVideoBody({ ...input, model: config.model }), signal);
    const videoId = typeof body.video_id === "string" ? body.video_id : "";
    // 校验 video_id，不能误用 id/task_id 作为视频查询 ID。
    agnesVideoStatusUrl(config.baseUrl, videoId, config.model);
    return { id: videoId, ...(typeof body.task_id === "string" ? { agnesTaskId: body.task_id } : {}) };
}

export async function pollAgnesVideo(config: Config, videoId: string, signal?: AbortSignal) {
    const body = await agnesJson(config, agnesVideoStatusUrl(config.baseUrl, videoId, config.model), undefined, signal);
    return readAgnesVideoState(body);
}

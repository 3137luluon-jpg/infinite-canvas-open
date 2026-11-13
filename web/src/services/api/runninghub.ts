import { buildRunningHubVideoBody, readRunningHubVideoState, runningHubError, runningHubUrl, type RunningHubVideoInput } from "../../lib/runninghub.ts";

type Config = { baseUrl: string; apiKey: string; model?: string };
export type RunningHubReference = { name: string; url: string; type: string };
type References = { images: RunningHubReference[]; videos: RunningHubReference[]; audios: RunningHubReference[] };

async function runningHubRequest(config: Config, path: string, body: unknown, signal?: AbortSignal) {
    const url = runningHubUrl(config.baseUrl, path);
    if (!config.apiKey.trim()) throw new Error("请先在 RunningHub 渠道填写 API Key");
    const form = body instanceof FormData;
    let response: Response;
    try {
        response = await fetch(url, { method: "POST", signal, headers: { Authorization: `Bearer ${config.apiKey.trim()}`, ...(!form ? { "Content-Type": "application/json" } : {}) }, body: form ? body : JSON.stringify(body) });
    } catch (error) {
        if (signal?.aborted) throw error;
        throw new Error("RunningHub 网络请求失败，请检查连接；若已提交，请先核对平台任务记录，不要重复生成");
    }
    const result = await response.json().catch(() => null) as Record<string, unknown> | null;
    if (!result) throw new Error(`RunningHub HTTP ${response.status}：没有返回有效 JSON`);
    const code = result.code;
    if (!response.ok || (code != null && !["0", "200"].includes(String(code)))) throw new Error(runningHubError(result, config.apiKey.trim()));
    return result;
}

/** 只查询账户与不存在的任务，不上传素材、不提交生成，不产生生成费用。 */
export async function checkRunningHubConnection(config: Config, signal?: AbortSignal) {
    const account = await runningHubRequest(config, "/uc/openapi/accountStatus", { apiKey: config.apiKey.trim() }, signal);
    const data = account.data as Record<string, unknown> | undefined;
    if (!data || account.code == null) throw new Error("RunningHub 没有返回账户信息");
    const query = await runningHubRequest(config, "/openapi/v2/query", { taskId: "1" }, signal);
    if (String(query.errorCode) !== "1004" && !["QUEUED", "RUNNING", "SUCCESS", "FAILED"].includes(String(query.status))) throw new Error(runningHubError(query, config.apiKey.trim()));
    return { apiType: String(data.apiType || "未知"), coins: String(data.remainCoins ?? "未知"), money: String(data.remainMoney ?? "未知"), currency: String(data.currency || "") };
}

async function uploadReference(config: Config, ref: RunningHubReference, kind: keyof References, signal?: AbortSignal) {
    // 公网链接原样传入；本地与 data/blob 素材先上传，不把 Key 发给素材链接。
    if (/^https?:\/\//i.test(ref.url)) {
        const host = new URL(ref.url).hostname;
        if (!/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|0\.|169\.254\.|\[)/i.test(host) && !host.endsWith(".local")) return ref.url;
    }
    const response = await fetch(ref.url, { signal });
    if (!response.ok) throw new Error(`读取 RunningHub 参考素材失败：${response.status}`);
    const blob = await response.blob();
    const mime = (blob.type || ref.type).split(";", 1)[0];
    const prefix = kind === "images" ? "image/" : kind === "videos" ? "video/" : "audio/";
    if (!mime.startsWith(prefix) || !blob.size) throw new Error(`RunningHub 参考素材 ${ref.name} 的格式或内容不正确，未提交生成`);
    const limit = (kind === "images" ? 30 : kind === "videos" ? 200 : 15) * 1024 * 1024;
    if (blob.size > limit) throw new Error(`RunningHub 参考素材 ${ref.name} 超出 ${limit / 1024 / 1024}MB，未提交生成`);
    const extension = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/quicktime": "mov", "video/webm": "webm", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/flac": "flac" } as Record<string, string>)[mime] || ref.name.split(".").pop() || "bin";
    const form = new FormData();
    form.append("file", blob, `reference.${extension}`);
    const uploaded = await runningHubRequest(config, "/openapi/v2/media/upload/binary", form, signal);
    const url = (uploaded.data as { download_url?: string } | undefined)?.download_url;
    if (typeof url !== "string" || !/^https?:\/\//i.test(url)) throw new Error("RunningHub 上传未返回 download_url，未提交生成");
    return url;
}

export async function submitRunningHubVideo(config: Config & { model: string }, input: Omit<RunningHubVideoInput, "images" | "videos" | "audios">, refs: References, signal?: AbortSignal) {
    // 先完成可确定的参数和引用校验，再上传，最后只提交一次生成。
    buildRunningHubVideoBody(config.model, { ...input, images: refs.images.map(ref => ref.url), videos: refs.videos.map(ref => ref.url), audios: refs.audios.map(ref => ref.url) });
    runningHubUrl(config.baseUrl, "/openapi/v2/query");
    if (!config.apiKey.trim()) throw new Error("请先在 RunningHub 渠道填写 API Key");
    const urls: { images: string[]; videos: string[]; audios: string[] } = { images: [], videos: [], audios: [] };
    for (const kind of ["images", "videos", "audios"] as const) {
        for (const ref of refs[kind]) urls[kind].push(await uploadReference(config, ref, kind, signal));
    }
    const created = await runningHubRequest(config, `/openapi/v2/${config.model}`, buildRunningHubVideoBody(config.model, { ...input, ...urls }), signal);
    if (created.errorCode && !["0", "200"].includes(String(created.errorCode))) throw new Error(runningHubError(created, config.apiKey.trim()));
    if (typeof created.taskId !== "string" || !created.taskId.trim()) throw new Error("RunningHub 未返回 taskId，请先核对平台任务记录，不要自动重复提交");
    // 返回给现有 onRemoteTask 保存屏障；此处绝不开始轮询。
    return { id: created.taskId, submittedAt: Date.now() };
}

export async function pollRunningHubVideo(config: Config, taskId: string, signal?: AbortSignal) {
    if (!taskId.trim()) throw new Error("缺少 RunningHub 原任务编号，不能查询");
    return readRunningHubVideoState(await runningHubRequest(config, "/openapi/v2/query", { taskId }, signal), config.apiKey.trim());
}

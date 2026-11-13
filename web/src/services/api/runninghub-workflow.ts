import { runningHubError, runningHubUrl } from "../../lib/runninghub.ts";
import { buildRhNodeInfo, rhWorkflowId, selectRhOutputs, validateRhMapping, type RhGraph, type RhMapping, type RhSnapshot, type RhValues } from "../../lib/runninghub-workflow.ts";

type Config = { baseUrl: string; apiKey: string };
type Envelope = { code?: number | string; msg?: string; data?: unknown };

async function request(config: Config, path: string, body: object | FormData, signal?: AbortSignal): Promise<Envelope> {
    const remoteUrl = new URL(runningHubUrl(config.baseUrl, path));
    const url = typeof window !== "undefined" && ["http://localhost:3000", "http://127.0.0.1:5173"].includes(window.location.origin)
        ? `/__runninghub-workflow?${new URLSearchParams({ host: remoteUrl.hostname, endpoint: remoteUrl.pathname })}`
        : remoteUrl.href;
    const apiKey = config.apiKey.trim();
    if (!apiKey) throw new Error("请先填写 RunningHub 工作流 API Key");
    const form = body instanceof FormData;
    const response = await fetch(url, { method: "POST", signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000), headers: { Authorization: `Bearer ${apiKey}`, ...(!form ? { "Content-Type": "application/json" } : {}) }, body: form ? body : JSON.stringify({ ...body, apiKey }) });
    const result = await response.json().catch(() => null);
    if (!response.ok || !result || result.code == null) throw new Error(`RunningHub 接口响应无效（HTTP ${response.status}）。若已提交，请查平台任务记录，勿重复提交。`);
    return result;
}

function success(config: Config, response: Envelope) {
    if (String(response.code) !== "0") throw new Error(runningHubError(response, config.apiKey.trim()));
    return response.data;
}

/** Read-only: obtain the saved API graph, never save or rewrite the cloud workflow. */
export async function fetchRhWorkflow(config: Config, id: string, signal?: AbortSignal): Promise<RhGraph> {
    const data = success(config, await request(config, "/api/openapi/getJsonApiFormat", { workflowId: rhWorkflowId(id) }, signal)) as { prompt?: string | RhGraph } | undefined;
    let graph: RhGraph;
    try { graph = typeof data?.prompt === "string" ? JSON.parse(data.prompt) : data?.prompt as RhGraph; } catch { throw new Error("RunningHub 返回的工作流 JSON 无法解析"); }
    if (!graph || typeof graph !== "object" || Array.isArray(graph) || !Object.keys(graph).length || !Object.values(graph).every(n => n && typeof n.class_type === "string" && n.inputs && typeof n.inputs === "object")) throw new Error("RunningHub 未返回 API 格式工作流；请先在平台保存并运行一次");
    return graph;
}

async function upload(config: Config, url: string, kind: "image" | "video" | "audio", signal?: AbortSignal) {
    const response = await fetch(url, { signal });
    if (!response.ok) throw new Error(`读取参考素材失败（${response.status}），未提交生成`);
    const blob = await response.blob();
    const mime = blob.type.split(";")[0];
    const ext = ({ "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp", "video/mp4": "mp4", "video/quicktime": "mov", "video/x-matroska": "mkv", "video/x-msvideo": "avi", "audio/mpeg": "mp3", "audio/wav": "wav", "audio/x-wav": "wav", "audio/flac": "flac", "audio/x-flac": "flac" } as Record<string, string>)[mime];
    if (!ext || !mime.startsWith(`${kind}/`) || !blob.size) throw new Error(`RunningHub 工作流不支持此参考素材格式 ${mime}，未提交生成`);
    if (blob.size > 30 * 1024 * 1024) throw new Error("RunningHub 工作流素材上传限制为每个文件 30MB，未提交生成");
    const form = new FormData();
    form.append("apiKey", config.apiKey.trim());
    form.append("fileType", "input");
    form.append("file", blob, `reference.${ext}`);
    const data = success(config, await request(config, "/task/openapi/upload", form, signal)) as { fileName?: string } | undefined;
    if (!data?.fileName || typeof data.fileName !== "string") throw new Error("RunningHub 上传没有返回 fileName，未提交生成");
    return data.fileName;
}

export async function submitRhWorkflow(config: Config, mapping: RhMapping, values: RhValues, signal?: AbortSignal) {
    buildRhNodeInfo(mapping, values);
    validateRhMapping(await fetchRhWorkflow(config, mapping.workflowId, signal), mapping);
    const uploaded: RhValues = { ...values, images: [], videos: [], audios: [] };
    for (const [plural, kind] of [["images", "image"], ["videos", "video"], ["audios", "audio"]] as const) {
        for (const url of values[plural]) uploaded[plural].push(await upload(config, url, kind, signal));
    }
    const data = success(config, await request(config, "/task/openapi/create", { workflowId: mapping.workflowId, nodeInfoList: buildRhNodeInfo(mapping, uploaded) }, signal)) as { taskId?: string } | undefined;
    if (typeof data?.taskId !== "string" || !data.taskId.trim()) throw new Error("RunningHub 未返回有效任务编号，请核对平台记录，勿重复提交");
    // The caller must persist this task through onRemoteTask BEFORE polling.
    return { id: data.taskId, workflowId: mapping.workflowId, submittedAt: Date.now(), inputSnapshot: { ...mapping, baseUrl: new URL(config.baseUrl).origin } as RhSnapshot & Record<string, unknown> };
}

export async function pollRhWorkflow(config: Config, taskId: string, snapshot: RhSnapshot, signal?: AbortSignal) {
    if (!taskId.trim()) throw new Error("缺少 RunningHub 原任务编号");
    if (new URL(config.baseUrl).origin !== new URL(snapshot.baseUrl).origin) throw new Error("当前渠道地址与原 RunningHub 任务不一致，请恢复原渠道后续查");
    const result = await request(config, "/task/openapi/outputs", { taskId }, signal);
    // Even a failed task may expose already-produced outputs. Accept ONLY the selected node.
    const urls = selectRhOutputs(result.data, snapshot);
    if (urls.length) return { status: "completed" as const, providerStatus: String(result.code) === "0" ? "completed" : "partial-output", urls };
    if (["804", "813"].includes(String(result.code))) return { status: "pending" as const, providerStatus: String(result.code) === "813" ? "queued" : "running", progress: undefined as number | undefined };
    if (String(result.code) === "0" || String(result.code) === "805") throw new Error(`RunningHub 任务 ${taskId} ${String(result.code) === "0" ? "已结束" : "失败或中断"}，接口未提供所选节点 #${snapshot.outputNodeId} 的${snapshot.outputKind === "video" ? "视频" : "图片"}。未用其他采样结果替代，也未重新生成。`);
    throw new Error(runningHubError(result, config.apiKey.trim()));
}

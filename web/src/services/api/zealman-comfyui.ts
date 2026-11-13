import axios from "axios";
import { recoverZealmanOutput, type ZealmanRecoveryReceipt } from "./zealman-output-recovery";

import type { AiConfig, ModelCapability } from "@/stores/use-config-store";
import { applyScailReferenceOutput, h3ResolutionControl, h3ResolutionInputValues, nativeDepthControl, nativeUpscaleControl, scailVideoControl, scailVideoInputValues, zealmanVideoDimensions } from "./zealman-video-settings";
import { collectWorkflowResults, isUploadedReferenceResult, isVideoWorkflowResult, zealmanWorkflowError, type ZealmanVideoResult } from "./zealman-video-results";
import {
    inferZealmanDurationInput,
    inferZealmanImageSizeMapping,
    inferZealmanPromptInput,
    inferZealmanReferenceSlots,
    inferZealmanSeedInput,
    pruneUnusedZealmanReferenceBranches,
    t8ResolutionInputs,
    zealmanOutpaintPads,
    zealmanRandomSeed,
    type ZealmanReferenceSlot,
    type ZealmanWorkflowApiConfig as WorkflowApiConfig,
    type ZealmanWorkflowTemplate as WorkflowTemplate,
} from "./zealman-workflow-template";

export { inferZealmanReferenceSlots, pruneUnusedZealmanReferenceBranches };
export type { ZealmanReferenceSlot };

export const ZEALMAN_IMAGE_WORKFLOW_ALIAS = "云端 ComfyUI · A01 文生图";

type WorkflowListItem = {
    id?: string;
    name?: string;
    kind?: string;
};

type WorkflowListResponse = {
    workflows?: WorkflowListItem[];
};

export type ZealmanWorkflowCatalogItem = {
    name: string;
    capability: ModelCapability;
    kind: string;
};

type WorkflowConfigResponse = {
    success?: boolean;
    error?: string | { message?: string };
    workflow_template?: WorkflowTemplate;
    api_config?: WorkflowApiConfig;
};

type WorkflowGenerateResponse = {
    success?: boolean;
    prompt_id?: string;
    data?: { prompt_id?: string };
    error?: string | { message?: string };
    message?: string;
};

type WorkflowResultResponse = {
    success?: boolean;
    pending?: boolean;
    results?: ZealmanVideoResult[];
    data?: unknown;
    result?: unknown;
    error?: string | { message?: string };
    message?: string;
    [key: string]: unknown;
};

export type ZealmanInputMapping = {
    prompt?: string;
    seed?: string;
    width?: string;
    height?: string;
    padLeft?: string;
    padTop?: string;
    padRight?: string;
    padBottom?: string;
    duration?: string;
};

export type ZealmanWorkflowUsage = {
    workflowId: string;
    referenceSlots: ZealmanReferenceSlot[];
    acceptsPrompt: boolean;
    guide: string;
    preservesSource?: boolean;
    followsReferences?: boolean;
};

export type ZealmanReferenceInput = {
    name: string;
    type: string;
    dataUrl: string;
};

export type ZealmanSubmittedTask = {
    id: string;
    workflowId: string;
    submittedAt: number;
    inputSnapshot: Record<string, unknown>;
    panelBaseUrl: string;
};

type ProviderConfig = Pick<AiConfig, "baseUrl" | "apiKey">;

const discoveryCache = new Map<string, string>();
const workflowCache = new Map<string, { template: WorkflowTemplate; mapping: ZealmanInputMapping; referenceSlots: ZealmanReferenceSlot[]; expiresAt: number }>();
const knownWorkflowIds = new Set<string>();

function cleanBaseUrl(baseUrl: string) {
    return baseUrl.trim().replace(/\/+$/, "");
}

function authHeaders(config: ProviderConfig) {
    return config.apiKey.trim() ? { Authorization: `Bearer ${config.apiKey.trim()}` } : undefined;
}

function errorMessage(value: unknown) {
    if (!value || typeof value !== "object") return "";
    const record = value as Record<string, unknown>;
    if (typeof record.error === "string") return record.error;
    if (record.error && typeof record.error === "object" && typeof (record.error as { message?: unknown }).message === "string") {
        return String((record.error as { message: string }).message);
    }
    return typeof record.message === "string" ? record.message : "";
}

function panelCandidates(baseUrl: string) {
    const configured = cleanBaseUrl(baseUrl);
    const candidates = [configured];
    try {
        const parsed = new URL(configured);
        if (/^u{1,2}\d+-/i.test(parsed.hostname)) {
            const host = parsed.hostname;
            const region = host.match(/\.(west[a-z])\./i)?.[1];
            const panelHost = /^uu\d+-/i.test(host) ? host : `u${host}`;
            const hosts = [panelHost];
            // SeetaCloud may move a resumed instance to another region while retaining its instance ID.
            if (region && region.toLowerCase() !== "westb") hosts.push(panelHost.replace(new RegExp(`\\.${region}\\.`, "i"), ".westb."));
            for (const candidateHost of hosts) {
                const candidate = new URL(parsed.toString());
                candidate.hostname = candidateHost;
                if (!candidate.port) candidate.port = "8443";
                candidates.push(cleanBaseUrl(candidate.toString()));
            }
        }
    } catch {
        // The caller receives a clear connection error below.
    }
    return Array.from(new Set(candidates));
}

export function zealmanPanelCandidates(baseUrl: string) {
    return panelCandidates(baseUrl);
}

export async function discoverZealmanPanelBaseUrl(config: ProviderConfig, signal?: AbortSignal) {
    const cacheKey = cleanBaseUrl(config.baseUrl);
    const cached = discoveryCache.get(cacheKey);
    if (cached) return cached;

    const failures: string[] = [];
    for (const candidate of panelCandidates(config.baseUrl)) {
        try {
            const response = await axios.get<WorkflowListResponse>(`${candidate}/api/workflow/list`, {
                headers: authHeaders(config),
                signal,
                timeout: 15_000,
            });
            if (Array.isArray(response.data?.workflows)) {
                discoveryCache.set(cacheKey, candidate);
                return candidate;
            }
        } catch (error) {
            const status = axios.isAxiosError(error) ? error.response?.status : undefined;
            failures.push(`${new URL(candidate).hostname}${status ? ` HTTP ${status}` : " 连接失败"}`);
            // Try the control-panel sibling of the configured native ComfyUI host.
        }
    }
    throw new Error(`ZEALMAN 云端实例未启动或服务不可用（${failures.join("；") || cacheKey || "未连接"}）`);
}

function workflowCapability(workflow: WorkflowListItem, template?: WorkflowTemplate): ModelCapability {
    const kind = String(workflow.kind || "").toLowerCase();
    if (kind === "image") return "image";
    if (kind === "video" || kind === "digital_human") return "video";
    if (kind === "audio") return "audio";
    if (template) {
        const types = Object.values(template).map((node) => node.class_type || "");
        if (types.some((type) => /^(?:SaveVideo|VHS_VideoCombine)$/.test(type))) return "video";
        if (types.some((type) => /^SaveImage/.test(type))) return "image";
        if (types.some((type) => /LLM.*Generate|TextGenerate/.test(type))) return "text";
    }

    const name = `${workflow.id || ""} ${workflow.name || ""}`;
    if (/API-U24-/i.test(name)) return "video";
    if (/(视频|数字人|动作迁移|口型|animate|infinite\s*talk|ltx|lightx?2v|wan|minimax)/i.test(name)) return "video";
    if (/(声音|语音|音频|配音|克隆|audio|speech|voice|tts|fish)/i.test(name)) return "audio";
    if (/(图像|生图|洗图|写真|角色|人像|场景|分镜|视图|多参考图|扩图|外扩|outpaint|inpaint|raw|image|flux|qwen|krea|zimage|klein)/i.test(name)) return "image";
    return "text";
}

export async function listZealmanWorkflows(config: ProviderConfig, signal?: AbortSignal): Promise<ZealmanWorkflowCatalogItem[]> {
    const panelBaseUrl = await discoverZealmanPanelBaseUrl(config, signal);
    for (const key of workflowCache.keys()) if (key.startsWith(`${panelBaseUrl}::`)) workflowCache.delete(key);
    const response = await axios.get<WorkflowListResponse>(`${panelBaseUrl}/api/workflow/list`, {
        headers: authHeaders(config),
        signal,
        timeout: 30_000,
        params: { _t: Date.now() },
    });
    const workflows = await Promise.all((response.data.workflows || [])
        .filter((workflow) => workflow.id)
        .map(async (workflow) => {
            let capability = workflowCapability(workflow);
            if (!["image", "video", "audio", "digital_human"].includes(String(workflow.kind)) && (capability === "text" || /提示词|prompt/i.test(String(workflow.id)))) {
                try {
                    const loaded = await loadWorkflow(config, String(workflow.id), signal);
                    capability = workflowCapability(workflow, loaded.template);
                } catch {
                    // Keep the catalog usable when one optional template is unavailable.
                }
            }
            return { name: String(workflow.id), capability, kind: String(workflow.kind || "none") };
        }));
    workflows.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));
    workflows.forEach((workflow) => knownWorkflowIds.add(workflow.name));
    return workflows;
}

export async function listZealmanImageWorkflows(config: ProviderConfig, signal?: AbortSignal) {
    return (await listZealmanWorkflows(config, signal)).filter((workflow) => workflow.capability === "image").map((workflow) => workflow.name);
}

export function isZealmanWorkflowProvider(config: Pick<ProviderConfig, "baseUrl">) {
    try {
        const hostname = new URL(cleanBaseUrl(config.baseUrl)).hostname;
        return /\.seetacloud\.com$/i.test(hostname) && /^u{1,2}\d+-/i.test(hostname);
    } catch {
        return false;
    }
}

export function isZealmanWorkflowModel(model: string, config?: Pick<ProviderConfig, "baseUrl">) {
    return knownWorkflowIds.has(model.trim()) || Boolean(config && isZealmanWorkflowProvider(config));
}

function cloneWorkflow(template: WorkflowTemplate): WorkflowTemplate {
    return JSON.parse(JSON.stringify(template)) as WorkflowTemplate;
}

/** Infer semantic inputs from the live workflow graph so cloud-side node IDs may change safely. */
export function inferZealmanImageMapping(workflow: WorkflowTemplate, apiConfig?: WorkflowApiConfig): ZealmanInputMapping {
    const prompt = inferZealmanPromptInput(workflow, apiConfig);
    const duration = inferZealmanDurationInput(workflow, apiConfig);
    const seed = inferZealmanSeedInput(workflow, apiConfig);

    return {
        ...(prompt ? { prompt } : {}),
        ...(seed ? { seed } : {}),
        ...inferZealmanImageSizeMapping(workflow, apiConfig),
        ...(duration ? { duration } : {}),
    };
}

function usageGuide(referenceSlots: ZealmanReferenceSlot[], acceptsPrompt: boolean) {
    if (!referenceSlots.length) return acceptsPrompt ? "输入提示词后直接生成；此工作流不读取画布参考图。" : "此工作流使用云端预设参数，不读取画布参考图或本地提示词。";
    const kindLabel = { image: "图片", video: "视频", audio: "音频" } as const;
    const sections = (["image", "video", "audio"] as const)
        .map((kind) => {
            const slots = referenceSlots.filter((slot) => slot.kind === kind);
            return slots.length ? `${kindLabel[kind]} ${slots.length} 个（${slots.map((slot) => slot.label).join("、")}）` : "";
        })
        .filter(Boolean)
        .join("；");
    const required = referenceSlots.filter((slot) => slot.required);
    const capacityLabel = required.length ? "输入槽" : "可选参考容量";
    return `${capacityLabel}：${sections}。同类素材按上方缩略图从左到右依次填入${required.length ? `；其中必须提供：${required.map((slot) => slot.label).join("、")}${required.length < referenceSlots.length ? "，其余槽可不连接" : ""}` : "，连接几个就上传并启用几个"}；${acceptsPrompt ? "提示词描述最终视频或画面。" : "该工作流使用云端预设提示词，可不填本地文字直接生成。"}`;
}

export function zealmanUsageGuide(usage: ZealmanWorkflowUsage) {
    return usageGuide(usage.referenceSlots, usage.acceptsPrompt);
}

function applyInputValues(workflow: WorkflowTemplate, values: Record<string, unknown>) {
    for (const [key, value] of Object.entries(values)) {
        if (!key) continue;
        const separator = key.lastIndexOf(":");
        const nodeId = key.slice(0, separator);
        const field = key.slice(separator + 1);
        if (!workflow[nodeId]?.inputs || !(field in workflow[nodeId].inputs!)) throw new Error(`工作流输入不存在：${key}`);
        workflow[nodeId].inputs![field] = value;
    }
}

async function loadWorkflow(config: ProviderConfig, workflowId: string, signal?: AbortSignal) {
    const panelBaseUrl = await discoverZealmanPanelBaseUrl(config, signal);
    const cacheKey = `${panelBaseUrl}::${workflowId}`;
    const cached = workflowCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return { panelBaseUrl, template: cloneWorkflow(cached.template), mapping: cached.mapping, referenceSlots: cached.referenceSlots };

    let response;
    try {
        response = await axios.get<WorkflowConfigResponse>(`${panelBaseUrl}/api/workflow/config/${encodeURIComponent(workflowId)}`, {
            headers: authHeaders(config),
            signal,
            timeout: 30_000,
        });
    } catch (error) {
        if (axios.isAxiosError(error) && error.response?.status === 404) throw new Error(`云端实例未启动，或工作流「${workflowId}」已被删除。请开机后刷新工作流列表。`);
        throw error;
    }
    if (response.data.success === false || !response.data.workflow_template) {
        throw new Error(errorMessage(response.data) || `无法读取工作流：${workflowId}`);
    }
    const mapping = inferZealmanImageMapping(response.data.workflow_template, response.data.api_config);
    const referenceSlots = inferZealmanReferenceSlots(response.data.workflow_template, response.data.api_config);
    workflowCache.set(cacheKey, { template: cloneWorkflow(response.data.workflow_template), mapping, referenceSlots, expiresAt: Date.now() + 5 * 60_000 });
    return { panelBaseUrl, template: cloneWorkflow(response.data.workflow_template), mapping, referenceSlots };
}

export async function getZealmanWorkflowUsage(config: ProviderConfig, workflowId: string, signal?: AbortSignal): Promise<ZealmanWorkflowUsage> {
    const loaded = await loadWorkflow(config, workflowId, signal);
    if (nativeDepthControl(loaded.template)) {
        return { workflowId, referenceSlots: loaded.referenceSlots, acceptsPrompt: false, preservesSource: true, guide: usageGuide(loaded.referenceSlots, false) + " 深度预处理沿用云端加载器的参考尺寸、帧率和完整帧数；本地输出清晰度、比例、时长不改写此流程。" };
    }
    const upscale = nativeUpscaleControl(loaded.template);
    if (upscale) {
        const guide = upscale.kind === "video"
            ? ` 超分沿用原视频比例、帧率、帧数和音频；${upscale.preResize ? `云端先将长边缩放为${upscale.preResize}，再进行` : "使用"}${upscale.scale}倍VOSR处理，保留云端后续增强与输出分支。本地比例、清晰度、时长不改写此流程。`
            : ` 按原图比例进行${upscale.scale}倍超分；本地比例与1K/2K/4K选项不改写固定倍率。`;
        return { workflowId, referenceSlots: loaded.referenceSlots, acceptsPrompt: Boolean(loaded.mapping.prompt), preservesSource: true, guide: usageGuide(loaded.referenceSlots, Boolean(loaded.mapping.prompt)) + guide };
    }
    const resolution = h3ResolutionControl(loaded.template);
    const scail = scailVideoControl(loaded.template);
    const videoGuide = scail
        ? " Scail2固定跟随素材：比例与参考图一致，时长与完整参考视频一致，忽略旧比例与秒数设置。清晰度仍可选择；采样尺寸对齐后校准成品比例，保留分段动作、插帧和参考音频。"
        : resolution
        ? ` 比例与清晰度已接入；清晰度为最终输出目标，保留${resolution.scale}倍处理，实际尺寸按节点对齐取整。${loaded.mapping.duration ? "时长已接入，按工作流帧数规则取整；短于5秒的效果需实测。" : "时长未识别，提交前会提示。"}`
        : "";
    const hasPads = Boolean(loaded.mapping.padLeft || loaded.mapping.padTop || loaded.mapping.padRight || loaded.mapping.padBottom);
    const outpaintGuide = scail ? "" : hasPads
        ? " 扩图按当前清晰度与比例决定输出画布，参考图居中，四周补齐；auto 会保持参考图比例。"
        : loaded.mapping.width && loaded.mapping.height
          ? " 输出宽高已接入当前清晰度与比例；auto 会按参考图比例计算。"
          : loaded.referenceSlots.some((slot) => slot.kind === "image")
            ? " 输出尺寸沿用云端预设（如跟随原图或固定倍率）；本地 1K/2K/4K 不会改写尺寸。"
            : "";
    return {
        workflowId,
        referenceSlots: loaded.referenceSlots,
        acceptsPrompt: Boolean(loaded.mapping.prompt),
        ...(scail ? { followsReferences: true } : {}),
        guide: usageGuide(loaded.referenceSlots, Boolean(loaded.mapping.prompt)) + videoGuide + outpaintGuide,
    };
}

async function referenceImageSize(reference: ZealmanReferenceInput | undefined, signal?: AbortSignal): Promise<{ width: number; height: number }> {
    if (!reference) throw new Error("Scail2需要连接参考图以确定输出比例。");
    signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
        const image = new Image();
        const cleanup = () => {
            image.onload = null;
            image.onerror = null;
            signal?.removeEventListener("abort", abort);
        };
        const abort = () => { cleanup(); image.src = ""; reject(signal?.reason || new Error("已取消读取参考图")); };
        image.onload = () => {
            const size = { width: image.naturalWidth, height: image.naturalHeight };
            cleanup();
            if (size.width && size.height) resolve(size);
            else reject(new Error("无法读取参考图比例，请重新连接图片。"));
        };
        image.onerror = () => { cleanup(); reject(new Error("无法读取参考图比例，请重新连接图片或选择明确比例。")); };
        signal?.addEventListener("abort", abort, { once: true });
        image.src = reference.dataUrl;
    });
}

async function referenceVideoDuration(reference: ZealmanReferenceInput | undefined, signal?: AbortSignal) {
    if (!reference) throw new Error("Scail2需要连接动作参考视频以确定完整时长。");
    const { Input, BlobSource, ALL_FORMATS } = await import("mediabunny");
    const blob = await fetch(reference.dataUrl, { signal }).then((response) => {
        if (!response.ok) throw new Error(`无法读取参考视频时长：HTTP ${response.status}`);
        return response.blob();
    });
    const media = new Input({ formats: ALL_FORMATS, source: new BlobSource(blob) });
    try {
        signal?.throwIfAborted();
        const duration = await media.computeDuration();
        signal?.throwIfAborted();
        if (!Number.isFinite(duration) || duration <= 0) throw new Error("参考视频没有有效播放时长。");
        return duration;
    } finally {
        media.dispose();
    }
}

function extensionForType(type: string) {
    if (/png/i.test(type)) return "png";
    if (/webp/i.test(type)) return "webp";
    if (/gif/i.test(type)) return "gif";
    if (/webm/i.test(type)) return "webm";
    if (/quicktime|mov/i.test(type)) return "mov";
    if (/mp4|video/i.test(type)) return "mp4";
    if (/wav/i.test(type)) return "wav";
    if (/ogg/i.test(type)) return "ogg";
    if (/m4a|mp4a/i.test(type)) return "m4a";
    if (/mpeg|mp3|audio/i.test(type)) return "mp3";
    return "jpg";
}

async function uploadReference(panelBaseUrl: string, config: ProviderConfig, reference: ZealmanReferenceInput, signal?: AbortSignal) {
    const blob = await fetch(reference.dataUrl, { signal }).then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.blob();
    });
    const safeBase =
        reference.name
            .replace(/\.[^.]+$/, "")
            .replace(/[^\p{L}\p{N}._-]+/gu, "-")
            .slice(0, 48) || "reference";
    const filename = `ai-canvas-${crypto.randomUUID()}-${safeBase}.${extensionForType(reference.type || blob.type)}`;
    const formData = new FormData();
    formData.append("file", new File([blob], filename, { type: reference.type || blob.type || "image/png" }));
    formData.append("overwrite", "false");
    const response = await axios.post<{ name?: string }>(`${panelBaseUrl}/api/comfy/upload/file`, formData, {
        headers: authHeaders(config),
        signal,
        timeout: 120_000,
    });
    const name = response.data?.name?.trim();
    if (!name) throw new Error("云端文件上传成功，但接口未返回文件名");
    return name;
}

export async function submitZealmanWorkflowTask(
    config: ProviderConfig,
    input: { workflowId: string; prompt: string; size: string; quality: string; seconds: number; references?: ZealmanReferenceInput[] },
    signal?: AbortSignal,
): Promise<ZealmanSubmittedTask> {
    const loaded = await loadWorkflow(config, input.workflowId, signal);
    const workflow = cloneWorkflow(loaded.template);
    const sourceUpscale = nativeUpscaleControl(workflow)?.kind === "video" || nativeDepthControl(workflow);
    const scail = scailVideoControl(workflow);
    const resolutionValues = h3ResolutionInputValues(workflow, input.size, input.quality);
    if (!sourceUpscale && !scail && !resolutionValues && (!loaded.mapping.width || !loaded.mapping.height)) {
        throw new Error("此工作流尚未接入画面比例与清晰度控制，已停止提交。请开放实际生成节点的尺寸参数并完成映射，不能仅修改画布选项。");
    }
    if (!sourceUpscale && !scail && !loaded.mapping.duration) throw new Error("此工作流尚未接入时长控制，已停止提交。请在云端开放标为“视频时长（秒）”的数值参数。");
    const dimensions = sourceUpscale || scail ? null : zealmanVideoDimensions(input.size, input.quality);
    const references = input.references || [];
    const expectedCounts = loaded.referenceSlots.reduce((counts, slot) => ({ ...counts, [slot.kind]: counts[slot.kind] + 1 }), { image: 0, video: 0, audio: 0 });
    const actualCounts = references.reduce(
        (counts, reference) => {
            const kind = reference.type.startsWith("video/") ? "video" : reference.type.startsWith("audio/") ? "audio" : "image";
            counts[kind] += 1;
            return counts;
        },
        { image: 0, video: 0, audio: 0 },
    );
    for (const kind of ["image", "video", "audio"] as const) {
        if (actualCounts[kind] > expectedCounts[kind]) throw new Error(`工作流「${input.workflowId}」最多接收 ${expectedCounts[kind]} 个${kind === "image" ? "图片" : kind === "video" ? "视频" : "音频"}输入，当前连接了 ${actualCounts[kind]} 个。`);
    }
    const missingRequired = (["image", "video", "audio"] as const).flatMap((kind) => {
        return loaded.referenceSlots.filter((slot) => slot.kind === kind).filter((slot, index) => slot.required && index >= actualCounts[kind]);
    });
    if (missingRequired.length) throw new Error(`工作流「${input.workflowId}」缺少必要素材：${missingRequired.map((slot) => slot.label).join("、")}。请先连接到当前视频节点。`);
    const scailReferenceSize = scail ? await referenceImageSize(references.find((reference) => reference.type.startsWith("image/")), signal) : undefined;
    const scailDuration = scail ? await referenceVideoDuration(references.find((reference) => reference.type.startsWith("video/")), signal) : undefined;
    const scailValues = scail ? scailVideoInputValues(workflow, input.size, input.quality, input.seconds, scailReferenceSize) : null;
    const inputValues: Record<string, unknown> = {
        ...(loaded.mapping.prompt ? { [loaded.mapping.prompt]: input.prompt } : {}),
        ...(loaded.mapping.seed ? { [loaded.mapping.seed]: zealmanRandomSeed() } : {}),
        ...(!sourceUpscale ? scailValues || resolutionValues || {
            ...(loaded.mapping.width ? { [loaded.mapping.width]: dimensions!.width } : {}),
            ...(loaded.mapping.height ? { [loaded.mapping.height]: dimensions!.height } : {}),
        } : {}),
        ...(!sourceUpscale && !scail && loaded.mapping.duration ? { [loaded.mapping.duration]: input.seconds } : {}),
        ...(!sourceUpscale && !scail ? t8ResolutionInputs(workflow, dimensions!.width, dimensions!.height, input.quality) : {}),
    };
    const queues = {
        image: references.filter((reference) => reference.type.startsWith("image/")),
        video: references.filter((reference) => reference.type.startsWith("video/")),
        audio: references.filter((reference) => reference.type.startsWith("audio/")),
    };
    const unusedSlots: ZealmanReferenceSlot[] = [];
    for (const slot of loaded.referenceSlots) {
        const reference = queues[slot.kind].shift();
        if (reference) inputValues[slot.key] = /^https?:\/\//i.test(reference.dataUrl) ? reference.dataUrl : await uploadReference(loaded.panelBaseUrl, config, reference, signal);
        const enabledKey = `${slot.nodeId}:enabled`;
        const hasEnabledInput = Boolean(workflow[slot.nodeId]?.inputs && "enabled" in workflow[slot.nodeId].inputs!);
        if (hasEnabledInput) inputValues[enabledKey] = Boolean(reference);
        else if (!reference && !slot.required) unusedSlots.push(slot);
    }
    pruneUnusedZealmanReferenceBranches(workflow, unusedSlots);
    if (scailReferenceSize && scailDuration) applyScailReferenceOutput(workflow, input.quality, scailReferenceSize, scailDuration);
    applyInputValues(workflow, inputValues);
    const response = await axios.post<WorkflowGenerateResponse>(
        `${loaded.panelBaseUrl}/api/workflow/generate`,
        { workflow_id: input.workflowId, input_values: inputValues, workflow_template: workflow, client_id: crypto.randomUUID() },
        { headers: { "Content-Type": "application/json", ...authHeaders(config) }, signal, timeout: 30_000 },
    );
    const promptId = (response.data.prompt_id || response.data.data?.prompt_id || "").trim();
    if (!promptId) throw new Error(errorMessage(response.data) || "ZEALMAN 未返回 prompt_id");
    return {
        id: promptId,
        workflowId: input.workflowId,
        submittedAt: Date.now(),
        inputSnapshot: Object.fromEntries(Object.entries(inputValues).map(([key, value]) => [key, loaded.referenceSlots.some((slot) => slot.key === key) ? "[已上传参考素材]" : value])),
        panelBaseUrl: loaded.panelBaseUrl,
    };
}

export async function submitZealmanImageTask(config: ProviderConfig, input: { workflowId: string; prompt: string; width: number; height: number; sourceWidth?: number; sourceHeight?: number; references?: ZealmanReferenceInput[] }, signal?: AbortSignal): Promise<ZealmanSubmittedTask> {
    const loaded = await loadWorkflow(config, input.workflowId, signal);
    const workflow = cloneWorkflow(loaded.template);
    const imageSlots = loaded.referenceSlots.filter((slot) => slot.kind === "image");
    const references = input.references || [];
    if (references.length && !imageSlots.length) throw new Error(`工作流「${input.workflowId}」没有开放参考图输入，请改选图生图/多参考图工作流，或断开参考图后生成。`);
    const requiredImageSlots = imageSlots.filter((slot, index) => slot.required && index >= references.length);
    if (requiredImageSlots.length)
        throw new Error(
            `工作流「${input.workflowId}」需要参考图：${requiredImageSlots
                .map((slot) => slot.label)
                .join("、")}。请先把图片连接到当前生图节点。`,
        );
    if (references.length > imageSlots.length) throw new Error(`工作流「${input.workflowId}」最多接收 ${imageSlots.length} 张参考图，当前连接了 ${references.length} 张，请断开多余图片。`);
    const hasPads = Boolean(loaded.mapping.padLeft || loaded.mapping.padTop || loaded.mapping.padRight || loaded.mapping.padBottom);
    const pads = hasPads && input.sourceWidth && input.sourceHeight ? zealmanOutpaintPads({ width: input.sourceWidth, height: input.sourceHeight }, { width: input.width, height: input.height }) : null;
    const inputValues: Record<string, unknown> = {
        ...(loaded.mapping.prompt ? { [loaded.mapping.prompt]: input.prompt } : {}),
        ...(loaded.mapping.seed ? { [loaded.mapping.seed]: zealmanRandomSeed() } : {}),
        ...(loaded.mapping.width ? { [loaded.mapping.width]: input.width } : {}),
        ...(loaded.mapping.height ? { [loaded.mapping.height]: input.height } : {}),
        ...(pads && loaded.mapping.padLeft ? { [loaded.mapping.padLeft]: pads.left } : {}),
        ...(pads && loaded.mapping.padTop ? { [loaded.mapping.padTop]: pads.top } : {}),
        ...(pads && loaded.mapping.padRight ? { [loaded.mapping.padRight]: pads.right } : {}),
        ...(pads && loaded.mapping.padBottom ? { [loaded.mapping.padBottom]: pads.bottom } : {}),
    };
    const unusedSlots: ZealmanReferenceSlot[] = [];
    for (let index = 0; index < imageSlots.length; index += 1) {
        const slot = imageSlots[index];
        const reference = references[index];
        if (reference) inputValues[slot.key] = await uploadReference(loaded.panelBaseUrl, config, reference, signal);
        const enabledKey = `${slot.nodeId}:enabled`;
        const hasEnabledInput = Boolean(workflow[slot.nodeId]?.inputs && "enabled" in workflow[slot.nodeId].inputs!);
        if (hasEnabledInput) inputValues[enabledKey] = Boolean(reference);
        else if (!reference && !slot.required) unusedSlots.push(slot);
    }
    pruneUnusedZealmanReferenceBranches(workflow, unusedSlots);
    applyInputValues(workflow, inputValues);
    const response = await axios.post<WorkflowGenerateResponse>(
        `${loaded.panelBaseUrl}/api/workflow/generate`,
        {
            workflow_id: input.workflowId,
            input_values: inputValues,
            workflow_template: workflow,
            client_id: crypto.randomUUID(),
        },
        { headers: { "Content-Type": "application/json", ...authHeaders(config) }, signal, timeout: 30_000 },
    );
    const promptId = (response.data.prompt_id || response.data.data?.prompt_id || "").trim();
    if (!promptId) throw new Error(errorMessage(response.data) || "ZEALMAN 未返回 prompt_id");
    return {
        id: promptId,
        workflowId: input.workflowId,
        submittedAt: Date.now(),
        inputSnapshot: Object.fromEntries(Object.entries(inputValues).map(([key, value]) => [key, loaded.referenceSlots.some((slot) => slot.key === key) ? "[已上传参考图]" : value])),
        panelBaseUrl: loaded.panelBaseUrl,
    };
}

export async function pollZealmanImageTaskOnce(config: ProviderConfig, promptId: string, signal?: AbortSignal) {
    const panelBaseUrl = await discoverZealmanPanelBaseUrl(config, signal);
    const response = await axios.get<WorkflowResultResponse>(`${panelBaseUrl}/api/workflow/result`, {
        params: { prompt_id: promptId },
        headers: authHeaders(config),
        signal,
        timeout: 30_000,
    });
    if (response.data.success === false) throw new Error(errorMessage(response.data) || `ZEALMAN 任务查询失败：${promptId}`);
    if (response.data.pending !== false) return { status: "pending" as const, providerStatus: "generating" };

    const workflowError = zealmanWorkflowError(response.data);
    if (workflowError) throw new Error(`ZEALMAN 工作流执行失败：${workflowError.trim()}`);
    const urls = (response.data.results || []).filter((result) => result.type === "image" && result.url && !isUploadedReferenceResult(result)).map((result) => new URL(String(result.url), `${panelBaseUrl}/`).toString());
    if (!urls.length) throw new Error(`ZEALMAN 工作流已完成但没有图片输出：${promptId}`);
    return { status: "completed" as const, providerStatus: "completed", progress: 100, urls };
}

export async function pollZealmanVideoTaskOnce(config: ProviderConfig, promptId: string, signal?: AbortSignal, receipt?: ZealmanRecoveryReceipt): Promise<{ status: "pending" } | { status: "completed"; url: string; requiresAuth?: true }> {
    const panelBaseUrl = await discoverZealmanPanelBaseUrl(config, signal);
    const response = await axios.get<WorkflowResultResponse>(`${panelBaseUrl}/api/workflow/result`, {
        params: { prompt_id: promptId },
        headers: authHeaders(config),
        signal,
        timeout: 30_000,
    });
    if (response.data.success === false) throw new Error(errorMessage(response.data) || `ZEALMAN 任务查询失败：${promptId}`);
    if (response.data.pending !== false) {
        // The legacy result endpoint reports pending even for IDs lost on restart.
        if (receipt?.submittedAt && Date.now() - receipt.submittedAt > 60_000) {
            let stored: { id?: string; status?: string; outputs?: unknown } | undefined;
            try {
                const saved = await axios.get<{ task?: typeof stored }>(`${panelBaseUrl}/api/tasks/${encodeURIComponent(promptId)}`, { headers: authHeaders(config), signal, timeout: 10_000 });
                if (saved.data.task?.id === promptId) stored = saved.data.task;
            } catch (error) { if (signal?.aborted) throw error; }
            const durable = collectWorkflowResults(stored?.outputs, config.baseUrl).find(isVideoWorkflowResult);
            if (durable?.url) {
                const url = new URL(durable.url, `${panelBaseUrl}/`).toString();
                const requiresAuth = new URL(url).pathname === "/view" && new URL(url).origin === new URL(config.baseUrl).origin;
                return { status: "completed" as const, url, ...(requiresAuth ? { requiresAuth: true as const } : {}) };
            }
            if (stored && /^(?:cancelled|canceled|interrupted|failed|error|completed|success|succeeded)$/.test(stored.status || "")) {
                return recoverZealmanOutput(panelBaseUrl, receipt, authHeaders(config), signal);
            }
        }
        return { status: "pending" as const };
    }
    const workflowError = zealmanWorkflowError(response.data);
    if (workflowError) throw new Error(`ZEALMAN 工作流执行失败：${workflowError.trim()}`);
    const results = collectWorkflowResults(response.data, config.baseUrl);
    let result: ZealmanVideoResult | undefined = results.find(isVideoWorkflowResult);
    let historyError = "";
    if (!result?.url) {
        try {
            const history = await axios.get<Record<string, unknown>>(`${cleanBaseUrl(config.baseUrl)}/history/${encodeURIComponent(promptId)}`, {
                headers: authHeaders(config),
                signal,
                timeout: 30_000,
            });
            const entry = history.data?.[promptId] || history.data;
            result = collectWorkflowResults(entry, config.baseUrl).find(isVideoWorkflowResult);
        } catch (error) {
            historyError = axios.isAxiosError(error) ? `History HTTP ${error.response?.status || "连接失败"}` : "History 查询失败";
        }
    }
    if (!result?.url) throw new Error(`ZEALMAN 工作流已完成但没有可识别的视频输出：${promptId}（结果字段：${Object.keys(response.data).join(", ")}；ZEALMAN 结果 ${results.length} 项${historyError ? `；${historyError}` : "；ComfyUI History 也无视频文件"}）`);
    const url = new URL(result.url, `${panelBaseUrl}/`).toString();
    const requiresAuth = new URL(url).pathname === "/view" && new URL(url).origin === new URL(config.baseUrl).origin;
    return { status: "completed" as const, url, ...(requiresAuth ? { requiresAuth: true as const } : {}) };
}

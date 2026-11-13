import axios from "axios";
import { nanoid } from "nanoid";

import type { AiConfig } from "@/stores/use-config-store";
import type { ReferenceImage } from "@/types/image";
import { readImageMeta } from "@/lib/image-utils";
import { isZealmanWorkflowModel, isZealmanWorkflowProvider, listZealmanImageWorkflows, pollZealmanImageTaskOnce, submitZealmanImageTask } from "./zealman-comfyui";
import { zealmanImageTargetSize } from "./zealman-workflow-template";
import { isRunningHubWorkflowConfig, parseRhMapping, rhSnapshot } from "@/lib/runninghub-workflow";
import { submitRhWorkflow, pollRhWorkflow } from "./runninghub-workflow";

type ComfyUiRequestOptions = {
    workflowScript?: string;
    inputSnapshot?: Record<string, unknown>;
    signal?: AbortSignal;
    onRemoteTask?: (task: { id: string; provider: "comfyui"; model: string; workflowId?: string; submittedAt?: number; inputSnapshot?: Record<string, unknown>; panelBaseUrl?: string }) => void | Promise<void>;
    onTaskState?: (state: { stage: "queued" | "generating" | "downloading"; providerStatus?: string; progress?: number; attempt?: number }) => void;
};

type ComfyUiImage = { filename: string; subfolder?: string; type?: string };
type ComfyUiHistoryEntry = {
    outputs?: Record<string, { images?: ComfyUiImage[] }>;
    status?: { completed?: boolean; status_str?: string; messages?: unknown[] };
};

function apiUrl(baseUrl: string, path: string) {
    return `${baseUrl.trim().replace(/\/+$/, "")}${path}`;
}

function headers(config: Pick<AiConfig, "apiKey">, json = false) {
    return {
        ...(json ? { "Content-Type": "application/json" } : {}),
        ...(config.apiKey.trim() ? { Authorization: `Bearer ${config.apiKey.trim()}` } : {}),
    };
}

function dimensions(size: string, quality: string) {
    const [rw, rh] = size.split(":").map(Number);
    const ratio = Number.isFinite(rw) && Number.isFinite(rh) && rw > 0 && rh > 0 ? rw / rh : 1;
    const longEdge = quality.toLowerCase() === "4k" ? 2048 : quality.toLowerCase() === "2k" ? 1536 : 1024;
    const landscape = ratio >= 1;
    const width = landscape ? longEdge : longEdge * ratio;
    const height = landscape ? longEdge / ratio : longEdge;
    return {
        width: Math.max(512, Math.round(width / 64) * 64),
        height: Math.max(512, Math.round(height / 64) * 64),
    };
}

function workflow(config: AiConfig, prompt: string, count: number) {
    const { width, height } = dimensions(config.size || config.imageSize || "1:1", config.quality || "1k");
    return {
        "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: config.model } },
        "2": { class_type: "CLIPTextEncode", inputs: { text: prompt, clip: ["1", 1] } },
        "3": { class_type: "CLIPTextEncode", inputs: { text: "low quality, blurry, distorted, watermark, text", clip: ["1", 1] } },
        "4": { class_type: "EmptyLatentImage", inputs: { width, height, batch_size: count } },
        "5": {
            class_type: "KSampler",
            inputs: {
                seed: Math.floor(Math.random() * 1_000_000_000_000_000),
                steps: 28,
                cfg: 7,
                sampler_name: "euler",
                scheduler: "normal",
                denoise: 1,
                model: ["1", 0],
                positive: ["2", 0],
                negative: ["3", 0],
                latent_image: ["4", 0],
            },
        },
        "6": { class_type: "VAEDecode", inputs: { samples: ["5", 0], vae: ["1", 2] } },
        "7": { class_type: "SaveImage", inputs: { filename_prefix: "AiCanvas", images: ["6", 0] } },
    };
}

async function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("ComfyUI 图片读取失败"));
        reader.readAsDataURL(blob);
    });
}

async function downloadZealmanImage(sourceUrl: string, config: Pick<AiConfig, "apiKey">, signal?: AbortSignal) {
    try {
        const result = await axios.get<Blob>(sourceUrl, { headers: headers(config), responseType: "blob", signal, timeout: 60_000 });
        if (!result.data.type.startsWith("image/")) throw new Error(result.data.type || "unknown");
        return result.data;
    } catch (directError) {
        try {
            const response = await fetch(`/__media-proxy?url=${encodeURIComponent(sourceUrl)}`, { signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            if (!blob.type.startsWith("image/")) throw new Error(blob.type || "unknown");
            return blob;
        } catch (proxyError) {
            const detail = proxyError instanceof Error ? proxyError.message : directError instanceof Error ? directError.message : "unknown";
            throw new Error(`ZEALMAN 图片下载失败：${detail}`);
        }
    }
}

export async function fetchComfyUiCheckpointModels(config: Pick<AiConfig, "baseUrl" | "apiKey">) {
    try {
        const workflows = await listZealmanImageWorkflows(config);
        if (workflows.length) return workflows;
        if (isZealmanWorkflowProvider(config)) throw new Error("云端 ComfyUI 已连接，但没有找到标记为生图的工作流");
    } catch (error) {
        if (isZealmanWorkflowProvider(config)) throw error;
        // A regular native ComfyUI server has no ZEALMAN workflow catalog.
    }
    const response = await axios.get<unknown>(apiUrl(config.baseUrl, "/models/checkpoints"), { headers: headers(config) });
    const values = Array.isArray(response.data) ? response.data : [];
    return values
        .map(String)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b));
}

export async function pollComfyUiImageTaskOnce(config: AiConfig, promptId: string, options?: ComfyUiRequestOptions) {
    const snapshot = rhSnapshot(options?.inputSnapshot);
    if (snapshot) {
        const state = await pollRhWorkflow(config, promptId, snapshot, options?.signal);
        if (state.status === "pending") return state;
        options?.onTaskState?.({ stage: "downloading", providerStatus: state.providerStatus, progress: 100 });
        const images = await Promise.all(state.urls.map(async sourceUrl => {
            // Output CDN requests must never receive the RunningHub API key.
            const blob = await downloadZealmanImage(sourceUrl, { apiKey: "" }, options?.signal);
            return { id: nanoid(), dataUrl: await blobToDataUrl(blob), sourceUrl };
        }));
        return { ...state, images };
    }
    if (isRunningHubWorkflowConfig(config)) throw new Error("缺少 RunningHub 原任务输出映射，不能猜测或重新提交");
    if (isZealmanWorkflowModel(config.model, config)) {
        const state = await pollZealmanImageTaskOnce(config, promptId, options?.signal);
        if (state.status === "pending") return state;
        options?.onTaskState?.({ stage: "downloading", providerStatus: state.providerStatus, progress: 100 });
        const images = await Promise.all(
            state.urls.map(async (sourceUrl) => {
                const blob = await downloadZealmanImage(sourceUrl, config, options?.signal);
                return { id: nanoid(), dataUrl: await blobToDataUrl(blob), sourceUrl };
            }),
        );
        return { ...state, images };
    }
    const response = await axios.get<Record<string, ComfyUiHistoryEntry>>(apiUrl(config.baseUrl, `/history/${encodeURIComponent(promptId)}`), {
        headers: headers(config),
        signal: options?.signal,
    });
    const entry = response.data?.[promptId];
    if (!entry) return { status: "pending" as const, providerStatus: "queued" };
    const providerStatus = entry.status?.status_str || (entry.status?.completed ? "completed" : "running");
    if (providerStatus.toLowerCase() === "error") throw new Error(`ComfyUI 任务失败（${promptId}）`);
    const outputImages = Object.values(entry.outputs || {}).flatMap((output) => output.images || []);
    if (!outputImages.length) {
        if (entry.status?.completed) throw new Error(`ComfyUI 任务已结束但没有图片输出（${promptId}）`);
        return { status: "pending" as const, providerStatus };
    }
    options?.onTaskState?.({ stage: "downloading", providerStatus, progress: 100 });
    const images = await Promise.all(
        outputImages.map(async (image) => {
            const params = new URLSearchParams({ filename: image.filename, subfolder: image.subfolder || "", type: image.type || "output" });
            const result = await axios.get<Blob>(`${apiUrl(config.baseUrl, "/view")}?${params}`, {
                headers: headers(config),
                responseType: "blob",
                signal: options?.signal,
            });
            return { id: nanoid(), dataUrl: await blobToDataUrl(result.data) };
        }),
    );
    return { status: "completed" as const, providerStatus, progress: 100, images };
}

export async function pollComfyUiImageTask(config: AiConfig, promptId: string, options?: ComfyUiRequestOptions) {
    for (let attempt = 1; attempt <= 240; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const state = await pollComfyUiImageTaskOnce(config, promptId, options);
        if (state.status === "completed") return state.images;
        options?.onTaskState?.({ stage: state.providerStatus === "queued" ? "queued" : "generating", providerStatus: state.providerStatus, attempt });
        await new Promise((resolve) => window.setTimeout(resolve, 2500));
    }
    throw new Error(`ComfyUI 任务轮询超时（${promptId}）`);
}

export async function requestComfyUiImages(config: AiConfig, prompt: string, count: number, options?: ComfyUiRequestOptions, references: ReferenceImage[] = []) {
    if (isRunningHubWorkflowConfig(config)) {
        const mapping = parseRhMapping(options?.workflowScript || "");
        if (mapping.workflowId !== config.model || mapping.outputKind !== "image") throw new Error("RunningHub 生图工作流映射与所选模型不一致");
        const task = await submitRhWorkflow(config, mapping, { prompt, count, images: references.map(ref => ref.dataUrl), videos: [], audios: [] }, options?.signal);
        await options?.onRemoteTask?.({ ...task, provider: "comfyui", model: config.model });
        return pollComfyUiImageTask(config, task.id, { ...options, inputSnapshot: task.inputSnapshot });
    }
    if (isZealmanWorkflowModel(config.model, config)) {
        const source = references[0]?.dataUrl ? await readImageMeta(references[0].dataUrl).catch(() => undefined) : undefined;
        const { width, height } = zealmanImageTargetSize(config.size || config.imageSize || "auto", config.quality || "1k", source);
        if (count > 1) console.info("[ComfyUI] 云端工作流每次提交一张图片；当前请求按单任务执行。", { requestedCount: count, workflowId: config.model });
        const task = await submitZealmanImageTask(config, { workflowId: config.model, prompt, width, height, sourceWidth: source?.width, sourceHeight: source?.height, references }, options?.signal);
        await options?.onRemoteTask?.({ ...task, provider: "comfyui", model: config.model });
        return pollComfyUiImageTask(config, task.id, options);
    }
    if (references.length) throw new Error("原生 ComfyUI 参考图需要先导入对应 API 格式工作流；当前自动参考图映射仅适用于 ZEALMAN 云端工作流。");
    const response = await axios.post<{ prompt_id?: string; error?: { message?: string } }>(
        apiUrl(config.baseUrl, "/prompt"),
        { prompt: workflow(config, prompt, count), client_id: crypto.randomUUID() },
        { headers: headers(config, true), signal: options?.signal },
    );
    const promptId = response.data?.prompt_id?.trim();
    if (!promptId) throw new Error(response.data?.error?.message || "ComfyUI 未返回 prompt_id");
    await options?.onRemoteTask?.({ id: promptId, provider: "comfyui", model: config.model });
    return pollComfyUiImageTask(config, promptId, options);
}

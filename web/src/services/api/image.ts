import axios from "axios";
import { buildOfficialImageFields, isOfficialOpenAiImageUrl } from "@/lib/openai-image";
import { isAgnesConfig } from "@/lib/agnes";
import { isRunningHubConfig, RUNNINGHUB_VIDEO_MODEL } from "@/lib/runninghub";
import { checkRunningHubConnection } from "./runninghub";
import { isRunningHubWorkflowConfig } from "@/lib/runninghub-workflow";
import { buildKlongImageBody, isKlongImageConfig } from "@/lib/klong-image";
import { buildFeimiaoChatImageBody, isFeimiaoChatImage, readFeimiaoChatImages, readFeimiaoImageTask } from "@/lib/feimiao-image";
import { generateAgnesImage } from "./agnes";

import i18n from "@/i18n";
import { buildApimartImageBody, buildChatgpt2ApiImageBody, buildGeeknowGptImage2Body, buildOpenAiImageEditFields, isChatgpt2ApiUrl, isGeeknowImageHost, usesOpenAiMaskEdits } from "@/lib/apimart-image";
import { dataUrlToFile, readImageMeta } from "@/lib/image-utils";
import { recordCatalogPresence, withModelAvailability } from "@/lib/record-model-availability";
import { buildApiUrl, guessCapability, resolveModelRequestConfig, resolveModelScript, type AiConfig, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";
import { normalizePluginImages, runModelPlugin } from "./model-plugin";
import { nanoid } from "nanoid";
import { buildImageReferencePromptText } from "@/lib/image-reference-prompt";
import { imageToDataUrl } from "@/services/image-storage";
import type { ReferenceImage } from "@/types/image";
import { fetchComfyUiCheckpointModels, requestComfyUiImages } from "./comfyui";
import { isZealmanWorkflowProvider, listZealmanWorkflows } from "./zealman-comfyui";
import { AUTODL_WORKFLOW_ID } from "@/lib/autodl-workflow";
import { DOLA_MODELS, dolaApiUrl } from "@/lib/dola-video";
import { requestOpenAiCompatibleText, ResponsesEndpointError } from "./openai-compatible-text";

const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

export type AiTextMessage = {
    role: "system" | "user" | "assistant";
    content: string | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;
};

type ResponseToolCall = {
    id: string;
    type: "function";
    function: { name: string; arguments: string };
    thoughtSignature?: string;
};

type ResponseInputMessage =
    | AiTextMessage
    | { type: "function_call"; call_id: string; name: string; arguments: string; thoughtSignature?: string }
    | { role: "tool"; tool_call_id: string; content: string };

type ResponseFunctionTool = {
    type: "function";
    function: {
        name: string;
        description?: string;
        parameters: Record<string, unknown>;
        strict?: boolean;
    };
};

type ToolResponseResult = {
    content: string;
    toolCalls: ResponseToolCall[];
};

type ToolChoice = "auto" | "required" | { type: "function"; name: string };
type ResponseMessageContent = AiTextMessage["content"] | string;
type ResponseInputContent = { type: "input_text"; text: string } | { type: "input_image"; image_url: string };
type ResponseInputItem =
    | { role: "system" | "user" | "assistant"; content: string | ResponseInputContent[] }
    | { type: "function_call"; call_id: string; name: string; arguments: string }
    | { type: "function_call_output"; call_id: string; output: string };
type ResponseApiToolDefinition = {
    type: "function";
    name: string;
    description?: string;
    parameters: Record<string, unknown>;
    strict?: boolean;
};
type ResponseApiOutputItem =
    | { type?: "message"; content?: Array<{ type?: string; text?: string }> }
    | { type?: "function_call"; id?: string; call_id?: string; name?: string; arguments?: string };
type ResponseApiPayload = {
    id?: string;
    output?: ResponseApiOutputItem[];
    output_text?: string;
    error?: { message?: string };
    code?: number;
    msg?: string;
};
type ResponseStreamState = { buffer: string; text: string; payload?: ResponseApiPayload; error?: string };

type ImageApiResponse = {
    data?: Array<Record<string, unknown>>;
    error?: { message?: string };
    code?: number;
    msg?: string;
};
type GeminiPart = {
    text?: string;
    inlineData?: { mimeType?: string; data?: string };
    inline_data?: { mime_type?: string; mimeType?: string; data?: string };
    fileData?: { mimeType?: string; fileUri?: string };
    functionCall?: { id?: string; name?: string; args?: Record<string, unknown> };
    functionResponse?: { id?: string; name?: string; response?: Record<string, unknown> };
    thoughtSignature?: string;
    thought_signature?: string;
};
type GeminiContent = { role?: "user" | "model"; parts: GeminiPart[] };
type GeminiPayload = {
    candidates?: Array<{ content?: { parts?: GeminiPart[] }; finishReason?: string }>;
    models?: Array<{ name?: string }>;
    error?: { message?: string };
    promptFeedback?: { blockReason?: string };
};
type GeminiStreamState = { buffer: string; text: string; toolCalls: ResponseToolCall[]; error?: string };
export type ImageGenerationTask = {
    id: string;
    provider: "apimart" | "comfyui" | "feimiao";
    model: string;
    /** ZEALMAN 保存工作流的稳定 ID；原生 ComfyUI checkpoint 任务不设置。 */
    workflowId?: string;
    submittedAt?: number;
    /** 只保存本次实际提交的语义输入，便于刷新后诊断，不保存工作流大 JSON。 */
    inputSnapshot?: Record<string, unknown>;
    panelBaseUrl?: string;
};
export type ImageRequestOptions = {
    signal?: AbortSignal;
    /** 文本 Gemini 调用可显式使用 generateContent，避免渠道未实现流式接口。 */
    geminiStream?: boolean;
    /** 异步 task_id 一到手立刻回调，便于落盘订单后续轮询 */
    onRemoteTask?: (task: ImageGenerationTask) => void | Promise<void>;
    /** APIMart 异步任务的可观测阶段；不影响普通调用。 */
    onTaskState?: (state: { stage: "queued" | "generating" | "downloading"; providerStatus?: string; progress?: number; attempt?: number }) => void;
};
type RequestOptions = ImageRequestOptions;

const QUALITY_BASE: Record<string, number> = {
    low: 1024,
    medium: 2048,
    high: 2880,
    standard: 1024,
    hd: 2048,
};
const QUALITY_ALIASES: Record<string, string> = {
    "1k": "low",
    "2k": "medium",
    "4k": "high",
};
const DEFAULT_IMAGE_SHORT_SIDE = 1024;
const IMAGE_SIZE_STEP = 16;
const IMAGE_MIN_PIXELS = 655360;
const IMAGE_MAX_PIXELS = 8294400;
const IMAGE_MAX_EDGE = 3840;
const IMAGE_MAX_RATIO = 3;
const IMAGE_OUTPUT_FORMAT = "png";

const GEMINI_SUPPORTED_RATIOS = ["1:1", "1:4", "1:8", "2:3", "3:2", "3:4", "4:1", "4:3", "4:5", "5:4", "8:1", "9:16", "16:9", "21:9"];
const GEMINI_IMAGE_SIZE_BY_QUALITY: Record<string, string> = { low: "1K", medium: "2K", high: "4K", standard: "1K", hd: "2K" };

function normalizeQuality(quality: string) {
    const value = quality.trim().toLowerCase();
    const normalized = QUALITY_ALIASES[value] || value;
    return QUALITY_BASE[normalized] ? normalized : undefined;
}

/** Only "transparent" is forwarded; any other value (incl. empty) means keep the default opaque background. */
function normalizeBackground(background: string | undefined) {
    return background?.trim().toLowerCase() === "transparent" ? "transparent" : undefined;
}

/** Map "quality + ratio" to an explicit pixel dimension like "3840x2160". */
function resolveSize(quality: string | undefined, ratio: string): string {
    const parsedRatio = parseImageRatio(ratio);
    const basePixels = quality ? QUALITY_BASE[quality] : undefined;
    const isLandscape = parsedRatio.width >= parsedRatio.height;
    const longRatio = isLandscape ? parsedRatio.width / parsedRatio.height : parsedRatio.height / parsedRatio.width;
    let longSide: number;
    let shortSide: number;

    if (basePixels) {
        const targetPixels = basePixels * basePixels;
        const longSideRaw = Math.sqrt(targetPixels * longRatio);
        longSide = Math.floor(longSideRaw / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
        shortSide = Math.round(longSide / longRatio / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    } else {
        shortSide = DEFAULT_IMAGE_SHORT_SIDE;
        longSide = Math.round((shortSide * longRatio) / IMAGE_SIZE_STEP) * IMAGE_SIZE_STEP;
    }

    const width = isLandscape ? longSide : shortSide;
    const height = isLandscape ? shortSide : longSide;
    validateImageSize(width, height);
    return `${width}x${height}`;
}

function parseRatioValue(value: string) {
    const parts = value.split(":");
    if (parts.length !== 2) throw new Error(apiText("invalidImageSizeFormat"));
    const w = Number(parts[0]);
    const h = Number(parts[1]);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) throw new Error(apiText("positiveImageRatio"));
    return { width: w, height: h };
}

function parseImageRatio(value: string) {
    const ratio = parseRatioValue(value);
    if (Math.max(ratio.width, ratio.height) / Math.min(ratio.width, ratio.height) > IMAGE_MAX_RATIO) throw new Error(apiText("imageRatioLimit"));
    return ratio;
}

function parseImageDimensions(value: string) {
    const match = value.match(/^(\d+)x(\d+)$/i);
    if (!match) return null;
    return { width: Number(match[1]), height: Number(match[2]) };
}

function validateImageSize(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) throw new Error(apiText("positiveImageDimensions"));
    if (width % IMAGE_SIZE_STEP !== 0 || height % IMAGE_SIZE_STEP !== 0) throw new Error(apiText("imageDimensionStep"));
    if (Math.max(width, height) > IMAGE_MAX_EDGE) throw new Error(apiText("imageEdgeLimit"));
    if (Math.max(width, height) / Math.min(width, height) > IMAGE_MAX_RATIO) throw new Error(apiText("imageRatioLimit"));
    const pixels = width * height;
    if (pixels < IMAGE_MIN_PIXELS || pixels > IMAGE_MAX_PIXELS) throw new Error(apiText("imagePixelLimit"));
}

function resolveRequestSize(quality: string | undefined, size: string) {
    const value = size.trim();
    if (!value || value.toLowerCase() === "auto") return undefined;
    const dimensions = parseImageDimensions(value);
    if (dimensions) {
        validateImageSize(dimensions.width, dimensions.height);
        return `${dimensions.width}x${dimensions.height}`;
    }
    if (value.includes(":")) return resolveSize(quality, value);
    throw new Error(apiText("invalidImageSizeFormat"));
}

function resolveGeminiImageConfig(config: AiConfig) {
    const value = config.size.trim();
    const dimensions = parseImageDimensions(value);
    const ratio = dimensions ? `${dimensions.width}:${dimensions.height}` : value;
    const aspectRatio = value && value.toLowerCase() !== "auto" ? closestGeminiAspectRatio(ratio) : undefined;
    const imageSize = supportsGeminiImageSize(config.model) ? resolveGeminiImageSize(config.quality, dimensions) : undefined;
    const image = { ...(aspectRatio ? { aspectRatio } : {}), ...(imageSize ? { imageSize } : {}) };
    return Object.keys(image).length ? { responseFormat: { image } } : {};
}

function closestGeminiAspectRatio(value: string) {
    const ratio = parseImageRatio(value);
    const target = ratio.width / ratio.height;
    return GEMINI_SUPPORTED_RATIOS.reduce((best, item) => {
        const current = parseRatioValue(item);
        const bestRatio = parseRatioValue(best);
        return Math.abs(current.width / current.height - target) < Math.abs(bestRatio.width / bestRatio.height - target) ? item : best;
    });
}

function resolveGeminiImageSize(quality: string, dimensions: { width: number; height: number } | null) {
    const normalizedQuality = normalizeQuality(quality);
    if (normalizedQuality) return GEMINI_IMAGE_SIZE_BY_QUALITY[normalizedQuality];
    if (!dimensions) return undefined;
    const edge = Math.max(dimensions.width, dimensions.height);
    if (edge <= 768) return "512";
    if (edge <= 1536) return "1K";
    if (edge <= 3072) return "2K";
    return "4K";
}

function supportsGeminiImageSize(model: string) {
    const value = model.toLowerCase();
    return value.includes("gemini-3") || value.includes("3.1") || value.includes("3-pro");
}

function resolveImageDataUrl(item: Record<string, unknown>) {
    if (typeof item.b64_json === "string" && item.b64_json) {
        return `data:image/png;base64,${item.b64_json}`;
    }
    if (typeof item.url === "string" && item.url) {
        return item.url;
    }
    return null;
}

function parseImagePayload(payload: ImageApiResponse) {
    if (typeof payload.code === "number" && payload.code !== 0 && payload.code !== 200) {
        throw new Error(payload.msg || (payload.error as { message?: string } | undefined)?.message || apiText("requestFailed"));
    }
    // Support data, images, and results response fields used by different APIs.
    const imageList = payload.data
        || (payload as Record<string, unknown>).images as Array<Record<string, unknown>> | undefined
        || (payload as Record<string, unknown>).results as Array<Record<string, unknown>> | undefined
        || [];
    const images =
        imageList
            .flatMap((item) => {
                const dataUrl = resolveImageDataUrl(item);
                return dataUrl ? [{ id: nanoid(), dataUrl, ...(typeof item.batch_index === "number" && Number.isInteger(item.batch_index) && item.batch_index >= 0 ? { batchIndex: item.batch_index } : {}) }] : [];
            });

    if (images.length === 0) {
        // Check whether the response contains data in an unrecognized format.
        const rawKeys = Object.keys(payload).filter((k) => k !== "code" && k !== "msg" && k !== "error");
        throw new Error(rawKeys.length > 0
            ? apiText("unknownImageResponse", { fields: rawKeys.join(", ") })
            : apiText("noImageReturned"));
    }

    return images;
}

function readApimartTaskId(value: unknown): string {
    if (!value || typeof value !== "object") return "";
    const obj = value as Record<string, unknown>;
    for (const key of ["task_id", "taskId", "id"]) {
        const text = typeof obj[key] === "string" ? String(obj[key]).trim() : "";
        if (text.startsWith("task_")) return text;
    }
    return "";
}

function extractApimartTaskId(payload: Record<string, unknown>) {
    const data = payload.data;
    if (Array.isArray(data)) {
        for (const item of data) {
            const id = readApimartTaskId(item);
            if (id) return id;
        }
    }
    const fromData = readApimartTaskId(data);
    if (fromData) return fromData;
    return readApimartTaskId(payload);
}

function collectApimartImageUrls(value: unknown, out: string[] = []) {
    if (!value) return out;
    if (typeof value === "string") {
        const text = value.trim();
        if (/^https?:\/\//i.test(text) || text.startsWith("data:image/")) out.push(text);
        return out;
    }
    if (Array.isArray(value)) {
        value.forEach((item) => collectApimartImageUrls(item, out));
        return out;
    }
    if (typeof value !== "object") return out;
    const record = value as Record<string, unknown>;
    for (const key of ["url", "urls", "image_url", "imageUrl", "b64_json"]) {
        if (!(key in record)) continue;
        const item = record[key];
        if (key === "b64_json" && typeof item === "string" && item) {
            out.push(item.startsWith("data:") ? item : `data:image/png;base64,${item}`);
            continue;
        }
        collectApimartImageUrls(item, out);
    }
    for (const key of ["images", "result", "data", "output", "files"]) {
        if (key in record) collectApimartImageUrls(record[key], out);
    }
    return out;
}

function readApimartTaskRoot(payload: Record<string, unknown>) {
    const data = payload.data;
    if (Array.isArray(data) && data[0] && typeof data[0] === "object") return data[0] as Record<string, unknown>;
    if (data && typeof data === "object" && !Array.isArray(data)) return data as Record<string, unknown>;
    return payload;
}

function extractApimartTaskImages(payload: Record<string, unknown>) {
    const root = readApimartTaskRoot(payload);
    const status = String(root.status || "").toLowerCase();
    if (status === "failed" || status === "error" || status === "cancelled" || status === "canceled") {
        const err = (root.error as { message?: string } | undefined)?.message || payload.msg || apiText("requestFailed");
        throw new Error(String(err));
    }
    return Array.from(new Set(collectApimartImageUrls(root.result ?? root)));
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(apiText("requestFailed")));
        reader.readAsDataURL(blob);
    });
}

async function downloadApimartImageUrl(url: string, options?: RequestOptions) {
    if (url.startsWith("data:image/")) return url;
    try {
        const response = await axios.get<Blob>(url, { responseType: "blob", signal: options?.signal });
        return await blobToDataUrl(response.data);
    } catch (error) {
        // CDN 偶发拦截时，至少把可展示的远程地址交回画布，避免“任务成功却整单失败”
        if (/^https?:\/\//i.test(url)) return url;
        throw new Error(readAxiosError(error, apiText("requestFailed")));
    }
}

/** 单次查询 APIMart 图片任务；completed 且有图则返回，否则 pending/抛错 */
export async function pollApimartImageTaskOnce(config: AiConfig, taskId: string, options?: RequestOptions) {
    const response = await axios.get<Record<string, unknown>>(aiApiUrl(config, `/tasks/${encodeURIComponent(taskId)}`), {
        headers: aiHeaders(config),
        params: { language: "zh" },
        signal: options?.signal,
    });
    const payload = response.data || {};
    if (typeof payload.code === "number" && payload.code !== 0 && payload.code !== 200) {
        throw new Error(String(payload.msg || apiText("requestFailed")));
    }
    const root = readApimartTaskRoot(payload);
    const status = String(root.status || "").toLowerCase();
    const progressValue = Number(root.progress);
    const progress = Number.isFinite(progressValue) ? Math.max(0, Math.min(100, progressValue)) : undefined;
    const urls = isFeimiaoChatImage(config) ? readFeimiaoImageTask(payload).images : extractApimartTaskImages(payload);
    if (urls.length) {
        options?.onTaskState?.({ stage: "downloading", providerStatus: status, progress: 100 });
        const dataUrls = await Promise.all(urls.map((url) => downloadApimartImageUrl(url, options)));
        return { status: "completed" as const, providerStatus: status, progress: 100, images: dataUrls.map((dataUrl) => ({ id: nanoid(), dataUrl })) };
    }
    if (status === "completed" || status === "success" || status === "succeeded") {
        throw new Error(`${apiText("noImageReturned")} (task_id=${taskId})`);
    }
    if (status === "failed" || status === "error" || status === "cancelled" || status === "canceled") {
        throw new Error(apiText("requestFailed"));
    }
    return { status: "pending" as const, providerStatus: status, progress };
}

export async function pollApimartImageTask(config: AiConfig, taskId: string, options?: RequestOptions) {
    const started = Date.now();
    const timeoutMs = 10 * 60 * 1000;
    let attempt = 0;
    while (Date.now() - started < timeoutMs) {
        attempt += 1;
        if (options?.signal?.aborted) throw new Error(apiText("requestCanceled"));
        const state = await pollApimartImageTaskOnce(config, taskId, options);
        if (state.status === "completed") return state.images;
        const queued = !state.providerStatus || state.providerStatus === "submitted" || state.providerStatus === "pending" || state.providerStatus === "queued";
        options?.onTaskState?.({ stage: queued ? "queued" : "generating", providerStatus: state.providerStatus, progress: state.progress, attempt });
        await new Promise((resolve) => setTimeout(resolve, 2500));
    }
    throw new Error(`${apiText("requestFailed")} (task_id=${taskId})`);
}

async function completeApimartImageResponse(config: AiConfig, payload: Record<string, unknown>, options?: RequestOptions) {
    if (typeof payload.code === "number" && payload.code !== 0 && payload.code !== 200) {
        throw new Error(String(payload.msg || (payload.error as { message?: string } | undefined)?.message || apiText("requestFailed")));
    }
    const taskId = extractApimartTaskId(payload);
    if (taskId) {
        await options?.onRemoteTask?.({ id: taskId, provider: "apimart", model: config.model });
        return pollApimartImageTask(config, taskId, options);
    }
    // 异步已提交但没解析到 task_id 时，不要误走同步解析（会把 submitted 当成无图失败）
    const submitted = readApimartTaskRoot(payload);
    const submittedStatus = String(submitted.status || "").toLowerCase();
    if (submittedStatus === "submitted" || submittedStatus === "pending" || submittedStatus === "processing" || submittedStatus === "in_progress") {
        throw new Error(`${apiText("requestFailed")}: missing task_id`);
    }
    return parseImagePayload(payload as ImageApiResponse);
}

async function requestAgnesImages(config: AiConfig, prompt: string, n: number, images: string[], options?: RequestOptions) {
    // Agnes 文档没有批量 n 参数；画布按独立订单逐张提交，不静默少生成。
    if (n !== 1) throw new Error("Agnes 每次请求生成 1 张图片，请使用画布的独立多图任务");
    const payload = await generateAgnesImage(config, { prompt, size: config.size, quality: config.quality, images }, options?.signal);
    return parseImagePayload(payload);
}

async function requestApimartImages(config: AiConfig, prompt: string, n: number, imageUrls: string[], options?: RequestOptions) {
    const body = buildApimartImageBody({
        model: config.model,
        prompt,
        n,
        size: config.size,
        quality: config.quality,
        imageUrls,
    });
    const response = await axios.post<Record<string, unknown>>(aiApiUrl(config, "/images/generations"), body, {
        headers: aiHeaders(config, "application/json"),
        signal: options?.signal,
    });
    return completeApimartImageResponse(config, response.data || {}, options);
}

async function requestOfficialOpenAiImages(config: AiConfig, prompt: string, n: number, imageUrls: string[], maskUrl?: string, options?: RequestOptions) {
    const fields = buildOfficialImageFields({ model: config.model, prompt, n, size: config.size, quality: config.quality });
    let body: typeof fields | FormData = fields;
    if (imageUrls.length) {
        const form = new FormData();
        for (const [key, value] of Object.entries(fields)) form.set(key, String(value));
        imageUrls.forEach((dataUrl, index) => form.append("image[]", dataUrlToFile({ id: nanoid(), dataUrl, name: `reference-${index}.png`, type: "image/png" })));
        if (maskUrl) form.set("mask", dataUrlToFile({ id: nanoid(), dataUrl: maskUrl, name: "mask.png", type: "image/png" }));
        body = form;
    }
    const response = await axios.post<ImageApiResponse>(aiApiUrl(config, imageUrls.length ? "/images/edits" : "/images/generations"), body, {
        headers: aiHeaders(config, imageUrls.length ? undefined : "application/json"), signal: options?.signal,
    });
    return parseImagePayload(response.data);
}

async function requestChatgpt2ApiImages(config: AiConfig, prompt: string, n: number, options?: RequestOptions) {
    const body = buildChatgpt2ApiImageBody({
        model: config.model,
        prompt,
        n,
        size: config.size,
        quality: config.quality,
    });
    const response = await axios.post<ImageApiResponse>(aiApiUrl(config, "/images/generations"), body, {
        headers: aiHeaders(config, "application/json"),
        signal: options?.signal,
    });
    return parseImagePayload(response.data);
}

async function requestGeeknowGptImage2(config: AiConfig, prompt: string, n: number, imageUrls: string[], options?: RequestOptions) {
    const body = buildGeeknowGptImage2Body({
        model: config.model,
        prompt,
        n,
        size: config.size,
        imageUrls,
    });
    const response = await axios.post<Record<string, unknown>>(aiApiUrl(config, "/images/generations"), body, {
        headers: aiHeaders(config, "application/json"),
        signal: options?.signal,
    });
    return completeApimartImageResponse(config, response.data || {}, options);
}

async function requestCompatibleImages(config: AiConfig, prompt: string, n: number, imageUrls: string[], options?: RequestOptions) {
    if (isOfficialOpenAiImageUrl(config.baseUrl)) return requestOfficialOpenAiImages(config, prompt, n, imageUrls, undefined, options);
    if (isKlongImageConfig(config)) {
        const referenceSize = (!config.size || config.size === "auto") && imageUrls.length ? await readImageMeta(imageUrls[0]) : undefined;
        const body = buildKlongImageBody({ model: config.model, prompt, n, size: config.size, quality: config.quality, images: imageUrls, referenceSize });
        const response = await axios.post<ImageApiResponse>(aiApiUrl(config, imageUrls.length ? "/images/edits" : "/images/generations"), body, {
            headers: aiHeaders(config, "application/json"), signal: options?.signal,
        });
        return parseImagePayload(response.data);
    }
    if (isFeimiaoChatImage(config)) {
        const response = await axios.post(aiApiUrl(config, "/chat/completions"), buildFeimiaoChatImageBody(config.model, prompt, imageUrls, config.size, config.quality, n), {
            headers: aiHeaders(config, "application/json"), signal: options?.signal,
        });
        if (response.data?.error) throw new Error(readApiErrorMessage(response.data) || "飞喵生图接口返回错误");
        const task = readFeimiaoImageTask(response.data);
        if (task.taskId) {
            // Persist before polling so refresh never resubmits a paid request.
            await options?.onRemoteTask?.({ id: task.taskId, provider: "feimiao", model: config.model });
            if (!task.images.length) return pollApimartImageTask(config, task.taskId, options);
        }
        const images = readFeimiaoChatImages(response.data);
        if (!images.length) {
            const content = response.data?.choices?.[0]?.message?.content;
            const detail = typeof content === "string" && !/data:image\//i.test(content) ? content.slice(0, 160) : `响应字段：${Object.keys(response.data || {}).join(", ")}`;
            throw new Error(`飞喵聊天生图未返回可识别图片：${detail}`);
        }
        return images.map(dataUrl => ({ id: nanoid(), dataUrl }));
    }
    if (isAgnesConfig(config)) return requestAgnesImages(config, prompt, n, imageUrls, options);
    if (isGeeknowImageHost(config.baseUrl)) {
        return requestGeeknowGptImage2(config, prompt, n, imageUrls, options);
    }
    return requestApimartImages(config, prompt, n, imageUrls, options);
}

async function requestChatgpt2ApiImageEdit(config: AiConfig, prompt: string, n: number, references: ReferenceImage[], mask?: ReferenceImage, options?: RequestOptions) {
    const formData = new FormData();
    formData.set("model", config.model);
    formData.set("prompt", prompt);
    formData.set("n", String(n));
    formData.set("size", config.size || "auto");
    formData.set("quality", config.quality || "auto");
    formData.set("response_format", "b64_json");
    const files = await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    files.forEach((file) => formData.append("image", file));
    if (mask) {
        const maskUrl = await imageToDataUrl(mask);
        formData.set("mask", dataUrlToFile({ ...mask, dataUrl: maskUrl, name: mask.name || "mask.png", type: "image/png" }));
    }
    const response = await axios.post<ImageApiResponse>(aiApiUrl(config, "/images/edits"), formData, {
        headers: aiHeaders(config),
        signal: options?.signal,
    });
    return parseImagePayload(response.data);
}

function readApiErrorMessage(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") {
        // The value may be serialized JSON, such as error.message, or a plain-text error.
        try {
            const parsed = JSON.parse(value);
            const inner = readApiErrorMessage(parsed) || value;
            // Treat an empty parsed object such as "{}" as having no useful message.
            if (inner === value && typeof parsed === "object" && Object.keys(parsed).length === 0) return "";
            return inner;
        } catch {
            // Detect HTML error pages.
            if (/<[a-z][\s\S]*>/i.test(value)) return apiText("htmlError", { preview: `${value.slice(0, 80)}...` });
            return value;
        }
    }
    if (typeof value !== "object") return "";
    const payload = value as { msg?: unknown; message?: unknown; error?: unknown; detail?: unknown };
    // error may be a string or an object containing a message.
    const errorMsg =
        typeof payload.error === "string"
            ? payload.error
            : (payload.error as { message?: unknown })?.message;
    return (
        readApiErrorMessage(payload.msg) ||
        readApiErrorMessage(payload.message) ||
        readApiErrorMessage(errorMsg) ||
        readApiErrorMessage(payload.detail) ||
        ""
    );
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return apiText("requestCanceled");
    if (axios.isAxiosError(error)) {
        const responseData = error.response?.data;
        // Prefer the API error from the response body.
        const apiMsg = readApiErrorMessage(responseData);
        if (apiMsg) return apiMsg;
        // Infer the error from the HTTP status when the response body has no usable message.
        const statusMsg = readStatusError(error.response?.status, fallback);
        if (statusMsg) return statusMsg;
        // Fall back to Axios's own error message.
        return error.message || fallback;
    }
    if (error instanceof DOMException && error.name === "AbortError") return apiText("requestCanceled");
    return error instanceof Error ? readApiErrorMessage(error.message) || error.message : fallback;
}

function readStatusError(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return apiText("authenticationFailed");
    if (status === 429) return apiText("rateLimited");
    if (status === 404) return apiText("notFound");
    if (status === 502) return apiText("badGateway");
    if (status === 503) return apiText("serviceBusy");
    return status ? apiText("httpFailed", { status }) : fallback;
}

function withSystemPrompt(config: AiConfig, prompt: string) {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? `${systemPrompt}\n\n${prompt}` : prompt;
}

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

function geminiBaseUrl(config: Pick<AiConfig, "baseUrl">) {
    const normalizedBaseUrl = config.baseUrl.trim().replace(/\/+$/, "");
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    return lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/v1beta") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1beta`;
}

function geminiModelName(model: string) {
    return model.trim().replace(/^models\//, "");
}

function geminiApiUrl(config: Pick<AiConfig, "baseUrl" | "model">, action?: "generateContent" | "streamGenerateContent") {
    const baseUrl = geminiBaseUrl(config);
    if (!action) return `${baseUrl}/models`;
    return `${baseUrl}/models/${encodeURIComponent(geminiModelName(config.model))}:${action}`;
}

function geminiHeaders(config: Pick<AiConfig, "apiKey">) {
    return {
        "x-goog-api-key": config.apiKey,
        "Content-Type": "application/json",
    };
}

function withSystemMessage<T extends ResponseInputMessage>(config: AiConfig, messages: T[]): ResponseInputMessage[] {
    const systemPrompt = config.systemPrompt.trim();
    return systemPrompt ? [{ role: "system" as const, content: systemPrompt }, ...messages] : messages;
}

function toResponseInput(messages: ResponseInputMessage[]): ResponseInputItem[] {
    return messages.flatMap((message): ResponseInputItem[] => {
        if ("type" in message) return [message];
        if (message.role === "tool") return [{ type: "function_call_output", call_id: message.tool_call_id, output: message.content }];
        return [{ role: message.role, content: toResponseContent(message.content || "") }];
    });
}

function toResponseContent(content: ResponseMessageContent): string | ResponseInputContent[] {
    if (!Array.isArray(content)) return String(content || "");
    return content.map((item) => (item.type === "text" ? { type: "input_text" as const, text: item.text } : { type: "input_image" as const, image_url: item.image_url.url }));
}

function toResponseTool(tool: ResponseFunctionTool): ResponseApiToolDefinition {
    return {
        type: "function",
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
        strict: tool.function.strict,
    };
}

function parseToolResponse(payload: ResponseApiPayload): ToolResponseResult {
    const output = payload.output || [];
    const content =
        payload.output_text ||
        output
            .flatMap((item) => (item.type === "message" ? item.content || [] : []))
            .map((item) => item.text || "")
            .join("");
    const toolCalls = output
        .filter((item): item is Extract<ResponseApiOutputItem, { type?: "function_call" }> => item.type === "function_call")
        .map((item) => ({
            id: item.call_id || item.id || "",
            type: "function" as const,
            function: { name: item.name || "", arguments: item.arguments || "{}" },
        }))
        .filter((item) => item.id && item.function.name);
    return { content, toolCalls };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function responseErrorMessage(value: unknown) {
    if (!isRecord(value)) return "";
    const error = isRecord(value.error) ? value.error : undefined;
    const response = isRecord(value.response) ? value.response : undefined;
    const responseError = response && isRecord(response.error) ? response.error : undefined;
    return stringValue(value.msg) || stringValue(error?.message) || stringValue(responseError?.message);
}

function stringValue(value: unknown) {
    return typeof value === "string" ? value : "";
}

function validateResponsePayload(payload: ResponseApiPayload) {
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(payload.msg || apiText("requestFailed"));
    if (payload.error?.message) throw new Error(payload.error.message);
}

function validateGeminiPayload(payload: GeminiPayload) {
    if (payload.error?.message) throw new Error(payload.error.message);
    if (payload.promptFeedback?.blockReason) throw new Error(apiText("geminiRejected", { reason: payload.promptFeedback.blockReason }));
}

async function readFetchError(response: Response, fallback: string) {
    const text = await response.text();
    if (!text) return readStatusError(response.status, fallback);
    try {
        return responseErrorMessage(JSON.parse(text)) || readStatusError(response.status, fallback);
    } catch {
        return text.slice(0, 300) || readStatusError(response.status, fallback);
    }
}

function consumeResponseStreamBlock(block: string, state: ResponseStreamState, onDelta?: (text: string) => void) {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (!data || data === "[DONE]") return;
    const event = JSON.parse(data) as Record<string, unknown>;
    const type = stringValue(event.type);
    const errorMessage = responseErrorMessage(event);
    if (errorMessage) state.error = errorMessage;
    if (type === "response.output_text.delta" && typeof event.delta === "string") {
        state.text += event.delta;
        onDelta?.(state.text);
    }
    if (type === "response.output_text.done" && !state.text && typeof event.text === "string") {
        state.text = event.text;
        onDelta?.(state.text);
    }
    if (type === "response.completed" && isRecord(event.response)) {
        state.payload = event.response as ResponseApiPayload;
    } else if (Array.isArray(event.output)) {
        state.payload = event as ResponseApiPayload;
    }
}

function consumeResponseStreamText(state: ResponseStreamState, text: string, onDelta?: (text: string) => void, flush = false) {
    state.buffer += text;
    for (;;) {
        const match = state.buffer.match(/\r?\n\r?\n/);
        if (!match) break;
        const index = match.index ?? 0;
        consumeResponseStreamBlock(state.buffer.slice(0, index), state, onDelta);
        state.buffer = state.buffer.slice(index + match[0].length);
    }
    if (flush && state.buffer.trim()) {
        consumeResponseStreamBlock(state.buffer, state, onDelta);
        state.buffer = "";
    }
}

async function requestStreamingResponse(config: AiConfig, body: Record<string, unknown>, onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const response = await fetch(aiApiUrl(config, "/responses"), {
        method: "POST",
        headers: { ...aiHeaders(config, "application/json"), Accept: "text/event-stream" },
        body: JSON.stringify({ ...body, stream: true }),
        signal: options?.signal,
    });
    if (!response.ok) throw new ResponsesEndpointError(response.status, await readFetchError(response, apiText("requestFailed")));
    if (!response.body) {
        const payload = (await response.json()) as ResponseApiPayload;
        validateResponsePayload(payload);
        return parseToolResponse(payload);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state: ResponseStreamState = { buffer: "", text: "" };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        consumeResponseStreamText(state, decoder.decode(value, { stream: true }), onDelta);
        if (state.error) throw new Error(state.error);
    }
    consumeResponseStreamText(state, decoder.decode(), onDelta, true);
    if (state.error) throw new Error(state.error);
    if (!state.payload) return { content: state.text, toolCalls: [] };
    validateResponsePayload(state.payload);
    const result = parseToolResponse(state.payload);
    return { ...result, content: state.text || result.content };
}

function toGeminiBody(config: AiConfig, messages: ResponseInputMessage[], extra?: Record<string, unknown>) {
    const systemText = [
        config.systemPrompt.trim(),
        ...messages.flatMap((message) => (!("type" in message) && message.role === "system" ? [geminiTextContent(message.content)] : [])),
    ]
        .filter(Boolean)
        .join("\n\n");
    const contents = toGeminiContents(messages.filter((message) => ("type" in message ? true : message.role !== "system")));
    return {
        contents,
        ...(systemText ? { systemInstruction: { parts: [{ text: systemText }] } } : {}),
        ...extra,
    };
}

function toGeminiContents(messages: ResponseInputMessage[]): GeminiContent[] {
    const callNameById = new Map<string, string>();
    return messages.flatMap((message): GeminiContent[] => {
        if ("type" in message) {
            callNameById.set(message.call_id, message.name);
            return [{ role: "model", parts: [{ functionCall: { id: message.call_id, name: message.name, args: jsonObject(message.arguments) }, ...(message.thoughtSignature ? { thoughtSignature: message.thoughtSignature } : {}) }] }];
        }
        if (message.role === "tool") {
            const name = callNameById.get(message.tool_call_id) || "tool_result";
            return [{ role: "user", parts: [{ functionResponse: { id: message.tool_call_id, name, response: { result: jsonValue(message.content) } } }] }];
        }
        return [{ role: message.role === "assistant" ? "model" : "user", parts: toGeminiParts(message.content) }];
    });
}

function toGeminiParts(content: ResponseMessageContent): GeminiPart[] {
    if (!Array.isArray(content)) return [{ text: String(content || "") }];
    return content.map((item) => (item.type === "text" ? { text: item.text } : toGeminiImagePart(item.image_url.url)));
}

function toGeminiImagePart(url: string): GeminiPart {
    const match = url.match(/^data:([^;,]+);base64,(.+)$/);
    if (match) return { inlineData: { mimeType: match[1], data: match[2] } };
    return { fileData: { fileUri: url, mimeType: "image/png" } };
}

function geminiTextContent(content: ResponseMessageContent) {
    if (!Array.isArray(content)) return String(content || "");
    return content.map((item) => (item.type === "text" ? item.text : item.image_url.url)).join("\n");
}

function jsonObject(value: string): Record<string, unknown> {
    const parsed = jsonValue(value);
    return isRecord(parsed) ? parsed : {};
}

function jsonValue(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return value;
    }
}

function toGeminiToolOptions(tools: ResponseFunctionTool[], toolChoice: ToolChoice) {
    if (!tools.length) return {};
    const functionDeclarations = tools.map((tool) => ({
        name: tool.function.name,
        description: tool.function.description,
        parameters: tool.function.parameters,
    }));
    const functionCallingConfig =
        typeof toolChoice === "object"
            ? { mode: "ANY", allowedFunctionNames: [toolChoice.name] }
            : { mode: toolChoice === "required" ? "ANY" : "AUTO" };
    return {
        tools: [{ functionDeclarations }],
        toolConfig: { functionCallingConfig },
    };
}

async function requestGeminiStreamingResponse(config: AiConfig, body: Record<string, unknown>, onDelta?: (text: string) => void, options?: RequestOptions): Promise<ToolResponseResult> {
    const streaming = options?.geminiStream !== false;
    const endpoint = streaming ? `${geminiApiUrl(config, "streamGenerateContent")}?alt=sse` : geminiApiUrl(config, "generateContent");
    const response = await fetch(endpoint, {
        method: "POST",
        headers: geminiHeaders(config),
        body: JSON.stringify(body),
        signal: options?.signal,
    });
    if (!response.ok) throw new Error(await readFetchError(response, apiText("requestFailed")));
    if (!streaming || !response.body) {
        const payload = (await response.json()) as GeminiPayload;
        const result = parseGeminiToolResponse(payload);
        if (result.content) onDelta?.(result.content);
        return result;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    const state: GeminiStreamState = { buffer: "", text: "", toolCalls: [] };
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        consumeGeminiStreamText(state, decoder.decode(value, { stream: true }), onDelta);
        if (state.error) throw new Error(state.error);
    }
    consumeGeminiStreamText(state, decoder.decode(), onDelta, true);
    if (state.error) throw new Error(state.error);
    return { content: state.text, toolCalls: state.toolCalls };
}

function consumeGeminiStreamText(state: GeminiStreamState, text: string, onDelta?: (text: string) => void, flush = false) {
    state.buffer += text;
    for (;;) {
        const match = state.buffer.match(/\r?\n\r?\n/);
        if (!match) break;
        const index = match.index ?? 0;
        consumeGeminiStreamBlock(state.buffer.slice(0, index), state, onDelta);
        state.buffer = state.buffer.slice(index + match[0].length);
    }
    if (flush && state.buffer.trim()) {
        consumeGeminiStreamBlock(state.buffer, state, onDelta);
        state.buffer = "";
    }
}

function consumeGeminiStreamBlock(block: string, state: GeminiStreamState, onDelta?: (text: string) => void) {
    const data = block
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice(5).replace(/^ /, ""))
        .join("\n")
        .trim();
    if (!data || data === "[DONE]") return;
    const result = parseGeminiToolResponse(JSON.parse(data) as GeminiPayload);
    if (result.content) {
        state.text += result.content;
        onDelta?.(state.text);
    }
    state.toolCalls.push(...result.toolCalls);
}

function parseGeminiToolResponse(payload: GeminiPayload): ToolResponseResult {
    validateGeminiPayload(payload);
    const parts = payload.candidates?.flatMap((candidate) => candidate.content?.parts || []) || [];
    const content = parts.map((part) => part.text || "").join("");
    const toolCalls = parts
        .map((part) => part.functionCall)
        .filter((call): call is NonNullable<GeminiPart["functionCall"]> => Boolean(call?.name))
        .map((call) => {
            const part = parts.find((item) => item.functionCall === call);
            const thoughtSignature = part?.thoughtSignature || part?.thought_signature;
            return {
                id: call.id || nanoid(),
                type: "function" as const,
                function: { name: call.name || "", arguments: JSON.stringify(call.args || {}) },
                ...(thoughtSignature ? { thoughtSignature } : {}),
            };
        });
    return { content, toolCalls };
}

async function requestGeminiImages(config: AiConfig, prompt: string, references: ReferenceImage[], count: number, options?: RequestOptions) {
    const requests = Array.from({ length: count }, () => requestGeminiImagesOnce(config, prompt, references, options));
    return (await Promise.all(requests)).flat();
}

async function requestGeminiImagesOnce(config: AiConfig, prompt: string, references: ReferenceImage[], options?: RequestOptions) {
    const parts: GeminiPart[] = [{ text: prompt }];
    for (const image of references) {
        parts.push(toGeminiImagePart(await imageToDataUrl(image)));
    }
    const response = await axios.post<GeminiPayload>(
        geminiApiUrl(config, "generateContent"),
        {
            ...toGeminiBody(config, [{ role: "user", content: prompt }], { generationConfig: { responseModalities: ["TEXT", "IMAGE"], ...resolveGeminiImageConfig(config) } }),
            contents: [{ role: "user", parts }],
        },
        { headers: geminiHeaders(config), signal: options?.signal },
    );
    return parseGeminiImagePayload(response.data);
}

function parseGeminiImagePayload(payload: GeminiPayload) {
    validateGeminiPayload(payload);
    const images =
        payload.candidates
            ?.flatMap((candidate) => candidate.content?.parts || [])
            .map((part) => {
                const inlineData = part.inlineData || (part.inline_data ? { mimeType: part.inline_data.mimeType || part.inline_data.mime_type, data: part.inline_data.data } : undefined);
                if (inlineData?.data) return `data:${inlineData.mimeType || "image/png"};base64,${inlineData.data}`;
                return part.fileData?.fileUri || null;
            })
            .filter((value): value is string => Boolean(value))
            .map((dataUrl) => ({ id: nanoid(), dataUrl })) || [];
    if (!images.length) throw new Error(apiText("geminiNoImage"));
    return images;
}

export async function requestGeneration(config: AiConfig, prompt: string, options?: RequestOptions) {
    return withModelAvailability((config.model || config.imageModel).trim(), () => requestGenerationUntracked(config, prompt, options));
}

async function requestGenerationUntracked(config: AiConfig, prompt: string, options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.imageModel);
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const script = resolveModelScript(config, config.model || config.imageModel);
    if (script && !isRunningHubWorkflowConfig(requestConfig)) {
        const body = buildApimartImageBody({ model: requestConfig.model, prompt, n, size: config.size, quality: config.quality });
        try {
            const result = await runModelPlugin({
                capability: "image",
                script,
                config: requestConfig,
                prompt: withSystemPrompt(requestConfig, prompt),
                images: [],
                params: { size: body.size, resolution: body.resolution, quality: body.resolution, count: n },
                signal: options?.signal,
            });
            return normalizePluginImages(result).map((dataUrl) => ({ id: nanoid(), dataUrl }));
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("requestFailed")));
        }
    }
    if (requestConfig.apiFormat === "gemini") {
        try {
            return await requestGeminiImages(requestConfig, prompt, [], n, options);
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("requestFailed")));
        }
    }
    if (requestConfig.apiFormat === "comfyui") {
        try {
            return await requestComfyUiImages(requestConfig, withSystemPrompt(requestConfig, prompt), n, { ...options, workflowScript: script });
        } catch (error) {
            throw new Error(readAxiosError(error, "ComfyUI 生图失败"));
        }
    }
    try {
        if (isOfficialOpenAiImageUrl(requestConfig.baseUrl)) {
            return await requestOfficialOpenAiImages(requestConfig, withSystemPrompt(requestConfig, prompt), n, [], undefined, options);
        }
        if (isChatgpt2ApiUrl(requestConfig.baseUrl)) {
            return await requestChatgpt2ApiImages(requestConfig, withSystemPrompt(requestConfig, prompt), n, options);
        }
        if (isKlongImageConfig(requestConfig) || isFeimiaoChatImage(requestConfig)) return await requestCompatibleImages(requestConfig, withSystemPrompt(requestConfig, prompt), n, [], options);
        if (isAgnesConfig(requestConfig)) return await requestAgnesImages(requestConfig, withSystemPrompt(requestConfig, prompt), n, [], options);
        // 本地硬改：OpenAI 渠道按 APIMart gpt-image-2（size 宽高比 + resolution 1k/2k/4k，支持异步 task）
        return await requestApimartImages(requestConfig, withSystemPrompt(requestConfig, prompt), n, [], options);
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("requestFailed")));
    }
}

export async function requestEdit(config: AiConfig, prompt: string, references: ReferenceImage[], mask?: ReferenceImage, options?: RequestOptions) {
    return withModelAvailability((config.model || config.imageModel).trim(), () => requestEditUntracked(config, prompt, references, mask, options));
}

async function requestEditUntracked(config: AiConfig, prompt: string, references: ReferenceImage[], mask?: ReferenceImage, options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.imageModel);
    const n = Math.max(1, Math.min(15, Math.floor(Math.abs(Number(config.count)) || 1)));
    const requestPrompt = buildImageReferencePromptText(prompt, references);
    const script = resolveModelScript(config, config.model || config.imageModel);
    if (script && !isRunningHubWorkflowConfig(requestConfig)) {
        const refs = await Promise.all(references.map((image) => imageToDataUrl(image)));
        const body = buildApimartImageBody({ model: requestConfig.model, prompt: requestPrompt, n, size: config.size, quality: config.quality, imageUrls: refs });
        try {
            const result = await runModelPlugin({
                capability: "image",
                script,
                config: requestConfig,
                prompt: withSystemPrompt(requestConfig, requestPrompt),
                images: refs,
                params: { size: body.size, resolution: body.resolution, quality: body.resolution, count: n },
                signal: options?.signal,
            });
            return normalizePluginImages(result).map((dataUrl) => ({ id: nanoid(), dataUrl }));
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("requestFailed")));
        }
    }
    if (requestConfig.apiFormat === "gemini") {
        if (mask) throw new Error(apiText("geminiMaskUnsupported"));
        try {
            return await requestGeminiImages(requestConfig, requestPrompt, references, n, options);
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("requestFailed")));
        }
    }

    if (requestConfig.apiFormat === "comfyui") {
        if (mask) throw new Error("当前云端 ComfyUI 工作流没有声明蒙版输入槽，暂不支持局部蒙版编辑。");
        try {
            const normalizedReferences = await Promise.all(references.map(async (image) => ({ ...image, dataUrl: await imageToDataUrl(image) })));
            return await requestComfyUiImages(requestConfig, withSystemPrompt(requestConfig, requestPrompt), n, { ...options, workflowScript: script }, normalizedReferences);
        } catch (error) {
            throw new Error(readAxiosError(error, "ComfyUI 图生图失败"));
        }
    }

    if (requestConfig.apiFormat === "ark") {
        if (mask) throw new Error(apiText("maskModelUnsupported"));
        const refs = await Promise.all(references.map((image) => imageToDataUrl(image)));
        try {
            const body = buildApimartImageBody({
                model: requestConfig.model,
                prompt: withSystemPrompt(requestConfig, requestPrompt),
                n,
                size: config.size,
                quality: config.quality,
                imageUrls: refs,
            });
            const response = await axios.post<ImageApiResponse>(aiApiUrl(requestConfig, "/images/generations"), { ...body, image: refs, response_format: "b64_json", output_format: IMAGE_OUTPUT_FORMAT }, {
                headers: aiHeaders(requestConfig, "application/json"),
                signal: options?.signal,
            });
            return parseImagePayload(response.data);
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("requestFailed")));
        }
    }

    if (isAgnesConfig(requestConfig)) {
        if (mask) throw new Error("Agnes 暂未声明蒙版编辑接口，请使用参考图加文字进行编辑");
        const refs = await Promise.all(references.map((image) => imageToDataUrl(image)));
        return requestAgnesImages(requestConfig, withSystemPrompt(requestConfig, requestPrompt), n, refs, options);
    }

    if (isOfficialOpenAiImageUrl(requestConfig.baseUrl)) {
        try {
            const refs = await Promise.all(references.map((image) => imageToDataUrl(image)));
            return await requestOfficialOpenAiImages(requestConfig, withSystemPrompt(requestConfig, requestPrompt), n, refs, mask ? await imageToDataUrl(mask) : undefined, options);
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("requestFailed")));
        }
    }

    if (mask) {
        if (isKlongImageConfig(requestConfig)) throw new Error("恐龙 Klong 暂不支持蒙版编辑，请使用参考图加文字编辑");
        if (isFeimiaoChatImage(requestConfig)) throw new Error("飞喵聊天生图尚未声明蒙版接口，请使用参考图加文字编辑");
        if (isChatgpt2ApiUrl(requestConfig.baseUrl)) {
            try {
                return await requestChatgpt2ApiImageEdit(requestConfig, withSystemPrompt(requestConfig, requestPrompt), n, references, mask, options);
            } catch (error) {
                throw new Error(readAxiosError(error, apiText("requestFailed")));
            }
        }
        const refs = await Promise.all(references.map((image) => imageToDataUrl(image)));
        const maskUrl = await imageToDataUrl(mask);
        const promptText = withSystemPrompt(requestConfig, requestPrompt);
        try {
            // gpt-image-1 / DALL·E 才走 OpenAI /images/edits。gpt-image-2（含 geekai/geeknow）用当前生图入口，
            // 把原图和遮罩当参考图提交，跟随当前生图渠道，不访问已删除的 APIMart。
            if (usesOpenAiMaskEdits(requestConfig.model)) {
                const fields = buildOpenAiImageEditFields({
                    model: requestConfig.model,
                    prompt: promptText,
                    n,
                    size: config.size,
                    quality: config.quality,
                });
                const formData = new FormData();
                formData.set("model", fields.model);
                formData.set("prompt", fields.prompt);
                formData.set("n", String(fields.n));
                formData.set("size", fields.size);
                formData.set("quality", fields.quality);
                const files = await Promise.all(references.map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
                files.forEach((file) => formData.append("image", file));
                formData.set("mask", dataUrlToFile({ ...mask, dataUrl: maskUrl, name: mask.name || "mask.png", type: "image/png" }));
                const response = await axios.post<Record<string, unknown>>(aiApiUrl(requestConfig, "/images/edits"), formData, {
                    headers: aiHeaders(requestConfig),
                    signal: options?.signal,
                });
                return await completeApimartImageResponse(requestConfig, response.data || {}, options);
            }
            return await requestCompatibleImages(requestConfig, promptText, n, [...refs, maskUrl], options);
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("requestFailed")));
        }
    }

    try {
        if (isChatgpt2ApiUrl(requestConfig.baseUrl)) {
            return await requestChatgpt2ApiImageEdit(requestConfig, withSystemPrompt(requestConfig, requestPrompt), n, references, undefined, options);
        }
        const refs = await Promise.all(references.map((image) => imageToDataUrl(image)));
        return await requestCompatibleImages(requestConfig, withSystemPrompt(requestConfig, requestPrompt), n, refs, options);
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("requestFailed")));
    }
}

export async function requestImageQuestion(config: AiConfig, messages: AiTextMessage[], onDelta: (text: string) => void, options?: RequestOptions) {
    return withModelAvailability((config.model || config.textModel).trim(), () => requestImageQuestionUntracked(config, messages, onDelta, options));
}

async function requestImageQuestionUntracked(config: AiConfig, messages: AiTextMessage[], onDelta: (text: string) => void, options?: RequestOptions) {
    const requestConfig = resolveModelRequestConfig(config, config.model || config.textModel);
    const script = resolveModelScript(config, config.model || config.textModel);
    if (script) {
        try {
            const answer = await runModelPlugin<string>({
                capability: "text",
                script,
                config: requestConfig,
                messages: withSystemMessage(requestConfig, messages),
                signal: options?.signal,
                onDelta,
            });
            const text = String(answer ?? "").trim() || apiText("noContent");
            if (text === apiText("noContent")) onDelta(text);
            return text;
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("requestFailed")));
        }
    }
    try {
        if (requestConfig.apiFormat === "gemini") {
            const answer = (await requestGeminiStreamingResponse(requestConfig, toGeminiBody(requestConfig, messages), onDelta, options)).content || apiText("noContent");
            if (answer === apiText("noContent")) onDelta(answer);
            return answer;
        }
        const answer = await requestOpenAiCompatibleText({
            responses: async () => (await requestStreamingResponse(requestConfig, {
                model: requestConfig.model,
                input: toResponseInput(withSystemMessage(requestConfig, messages)),
                ...(requestConfig.reasoningEffort === "auto" ? {} : { reasoning: { effort: requestConfig.reasoningEffort } }),
            }, onDelta, options)).content || apiText("noContent"),
            chatUrl: aiApiUrl(requestConfig, "/chat/completions"),
            headers: aiHeaders(requestConfig, "application/json"),
            model: requestConfig.model,
            messages: withSystemMessage(requestConfig, messages) as AiTextMessage[],
            reasoningEffort: requestConfig.reasoningEffort,
            signal: options?.signal,
            onDelta,
        });
        if (answer === apiText("noContent")) onDelta(answer);
        return answer;
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("requestFailed")));
    }
}

function readOpenAiModelIds(payload: unknown) {
    const record = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : null;
    const data = record?.data && typeof record.data === "object" && !Array.isArray(record.data) ? record.data as Record<string, unknown> : null;
    const result = record?.result && typeof record.result === "object" && !Array.isArray(record.result) ? record.result as Record<string, unknown> : null;
    const candidates = [payload, record?.data, record?.models, record?.items, record?.result, data?.models, data?.items, result?.models, result?.items];
    const list = candidates.find(Array.isArray) as unknown[] | undefined;
    return Array.from(new Set((list || []).map((model) => {
        if (typeof model === "string") return model.trim();
        if (!model || typeof model !== "object") return "";
        const item = model as Record<string, unknown>;
        const id = item.id ?? item.name ?? item.model;
        return typeof id === "string" ? id.trim().replace(/^models\//, "") : "";
    }).filter(Boolean))).sort((a, b) => a.localeCompare(b));
}

export async function fetchImageModels(config: Pick<AiConfig, "baseUrl" | "apiKey" | "apiFormat">) {
    try {
        if (config.apiFormat === "comfyui") return fetchComfyUiCheckpointModels(config);
        if (config.apiFormat === "gemini") {
            const response = await axios.get<GeminiPayload>(geminiApiUrl({ ...defaultGeminiConfig, ...config }), { headers: geminiHeaders({ ...defaultGeminiConfig, ...config }) });
            validateGeminiPayload(response.data);
            return (response.data.models || [])
                .map((model) => model.name?.replace(/^models\//, ""))
                .filter((id): id is string => Boolean(id))
                .sort((a, b) => a.localeCompare(b));
        }
        const endpoint = buildApiUrl(config.baseUrl, "/models");
        const requestModels = (bypassCache = false) => axios.get<unknown>(endpoint, {
            headers: { Authorization: `Bearer ${config.apiKey}` },
            ...(bypassCache ? { params: { _canvas_refresh: Date.now() } } : {}),
        });
        const first = readOpenAiModelIds((await requestModels()).data);
        if (first.length > 0) return first;
        await new Promise((resolve) => window.setTimeout(resolve, 250));
        return readOpenAiModelIds((await requestModels(true)).data);
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("modelReadFailed")));
    }
}

export type FetchedChannelModel = {
    name: string;
    capability: ModelCapability;
    sourceKind?: string;
};

export async function fetchChannelModels(channel: ModelChannel): Promise<FetchedChannelModel[]> {
    if (isRunningHubWorkflowConfig(channel)) return channel.models.map(model => ({ name: model.name, capability: model.capability }));
    if (isRunningHubConfig(channel)) {
        await checkRunningHubConnection(channel);
        return [{ name: RUNNINGHUB_VIDEO_MODEL, capability: "video" }];
    }
    if (channel.apiFormat === "dola") {
        await axios.get(dolaApiUrl(channel.baseUrl, "health"), { timeout: 10000 });
        return DOLA_MODELS.map(name => ({ name, capability: "video" }));
    }
    // Only expose workflows whose input/output contract is implemented; this is a supported preset, not the whole cloud catalog.
    if (channel.apiFormat === "autodl") return [{ name: AUTODL_WORKFLOW_ID, capability: "video" }];
    const models =
        channel.apiFormat === "comfyui" && isZealmanWorkflowProvider(channel)
            ? (await listZealmanWorkflows(channel)).map((workflow) => ({ name: workflow.name, capability: workflow.capability, sourceKind: workflow.kind }))
            : (await fetchImageModels({ baseUrl: channel.baseUrl, apiKey: channel.apiKey, apiFormat: channel.apiFormat })).map((name) => ({
                  name,
                  // “飞喵”标记代表此渠道使用 Fmgo 视频协议。上游新模型名不一定
                  // 包含 video/feimiao 等关键词，不能因此被误归为文本后从视频选择器消失。
                  capability: channel.feimiao ? "video" : guessCapability(name),
              }));
    recordCatalogPresence(channel.id, models.map((model) => model.name));
    return models;
}

const defaultGeminiConfig: Pick<AiConfig, "baseUrl" | "apiKey" | "apiFormat" | "model" | "systemPrompt"> = {
    baseUrl: "https://generativelanguage.googleapis.com",
    apiKey: "",
    apiFormat: "gemini",
    model: "",
    systemPrompt: "",
};

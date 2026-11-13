import axios from "axios";
import { isAgnesConfig } from "@/lib/agnes";
import { pollAgnesVideo, submitAgnesVideo } from "./agnes";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { dataUrlToFile } from "@/lib/image-utils";
import { getMediaBlob, uploadMediaFile, type UploadedFile } from "@/services/file-storage";
import { imageToDataUrl } from "@/services/image-storage";
import { boolConfig, buildSeedancePromptText, isSeedanceVideoConfig, normalizeSeedanceRatio, normalizeSeedanceResolution, resolveSeedanceDuration, seedanceVideoReferenceError, SEEDANCE_REFERENCE_LIMITS } from "@/lib/seedance-video";
import { summarizeApiError } from "@/lib/api-error";
import { integerDurationRange, isAutoVideoDuration, resolveVideoDuration } from "@/lib/video-duration";
import { buildFeimiaoVideoCreateRequest, isFeimiaoModelConfig, resolveFeimiaoVideoRequest } from "@/lib/feimiao-video";
import { recordModelApiResult, withModelAvailability } from "@/lib/record-model-availability";
import { buildApiUrl, modelOptionName, resolveModelRequestConfig, resolveModelScript, type AiConfig } from "@/stores/use-config-store";
import { runModelPlugin } from "./model-plugin";
import { isZealmanWorkflowModel, pollZealmanVideoTaskOnce, submitZealmanWorkflowTask } from "./zealman-comfyui";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { buildAutodlVideoBody, pollAutodlVideo, submitAutodlVideo } from "@/lib/autodl-workflow";
import { normalizeZealmanVideoReference } from "./zealman-video-normalize";
import { mediaBlobToDataUrl, normalizeMediaDataUrl } from "./media-data-url";
import { submitDolaVideo, pollDolaVideo } from "./dola-video";
import { isRunningHubConfig } from "@/lib/runninghub";
import { submitRunningHubVideo, pollRunningHubVideo } from "./runninghub";
import { isRunningHubWorkflowConfig, parseRhMapping, rhSnapshot } from "@/lib/runninghub-workflow";
import { submitRhWorkflow, pollRhWorkflow } from "./runninghub-workflow";

type VideoResponse = { id?: string; task_id?: string; status?: string; progress?: number; error?: { message?: string }; url?: string; result_url?: string; video_url?: string; content?: { video_url?: string; url?: string } | null };
type ApiVideoResponse = VideoResponse | { code?: number | string; data?: VideoResponse | null; msg?: string; message?: string; error?: { message?: string } };
type SeedanceTask = {
    id: string;
    status?: "queued" | "running" | "succeeded" | "completed" | "failed" | "cancelled" | "expired";
    progress?: number;
    error?: { code?: string; message?: string } | null;
    content?: { video_url?: string; url?: string; last_frame_url?: string } | null;
    url?: string;
    result_url?: string;
    video_url?: string;
};
type ApiEnvelope<T> = T | { code?: number | string; data?: T | null; msg?: string; message?: string; error?: { message?: string } };
type RequestOptions = {
    signal?: AbortSignal;
    onRemoteTask?: (task: VideoGenerationTask) => void | Promise<void>;
    /** CinePack 稳定 @ 引用不得被渠道上限静默截断。 */
    strictReferenceCount?: boolean;
};
const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

export type VideoGenerationResult = { blob?: Blob; url?: string; mimeType?: string };
export type VideoGenerationTask = {
    id: string;
    provider: "openai" | "seedance" | "plugin" | "feimiao" | "comfyui-video" | "autodl-video" | "dola" | "agnes" | "runninghub";
    agnesTaskId?: string;
    model: string;
    feimiaoBackend?: "sora_videos" | "openai" | "fmgo";
    statusUrl?: string;
    workflowId?: string;
    submittedAt?: number;
    inputSnapshot?: Record<string, unknown>;
    panelBaseUrl?: string;
};
export type VideoGenerationTaskState = { status: "pending"; progress?: number } | { status: "completed"; result: VideoGenerationResult } | { status: "failed"; error: string };

/** Results for scripted (plugin) video models, which run their own create+poll in one shot at task creation. */
const pluginVideoResults = new Map<string, VideoGenerationResult>();

function aiApiUrl(config: AiConfig, path: string) {
    return buildApiUrl(config.baseUrl, path);
}

function aiHeaders(config: AiConfig, contentType?: string) {
    return {
        Authorization: `Bearer ${config.apiKey}`,
        ...(contentType ? { "Content-Type": contentType } : {}),
    };
}

export async function requestVideoGeneration(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationResult> {
    const task = await createVideoGenerationTask(config, prompt, references, videoReferences, audioReferences, options);
    const delayMs = task.provider === "seedance" || task.provider === "feimiao" || task.provider === "runninghub" ? 5000 : 2500;
    const maxAttempts = task.provider === "comfyui-video" ? 720 : 120;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        if (options?.signal?.aborted) throw new DOMException("Aborted", "AbortError");
        const state = await pollVideoGenerationTask(config, task, options);
        if (state.status === "completed") return state.result;
        if (state.status === "failed") throw new Error(state.error);
        if (attempt === maxAttempts - 1) throw new Error(apiText("videoTimeout", { provider: task.provider === "seedance" ? "Seedance " : "" }));
        await delay(delayMs, options?.signal);
    }
    throw new Error(apiText("videoTimeout", { provider: "" }));
}

export async function createVideoGenerationTask(config: AiConfig, prompt: string, references: ReferenceImage[] = [], videoReferences: ReferenceVideo[] = [], audioReferences: ReferenceAudio[] = [], options?: RequestOptions): Promise<VideoGenerationTask> {
    const selectedModel = (config.model || config.videoModel).trim();
    return withModelAvailability(selectedModel, async () => {
        const requestConfig = resolveModelRequestConfig(config, selectedModel);
        assertVideoConfig(requestConfig, requestConfig.model);
        // 飞喵必须优先于自定义 script / FormData：否则会绕开字字同款 JSON /videos 请求
        let task: VideoGenerationTask;
        if (isRunningHubWorkflowConfig(requestConfig)) {
            const mapping = parseRhMapping(resolveModelScript(config, selectedModel));
            if (mapping.workflowId !== requestConfig.model || mapping.outputKind !== "video") throw new Error("RunningHub 视频工作流映射与所选模型不一致");
            const submitted = await submitRhWorkflow(requestConfig, mapping, {
                prompt, seconds: Number(requestConfig.videoSeconds), count: 1,
                images: await Promise.all(references.map(imageToDataUrl)),
                videos: await Promise.all(videoReferences.map(referenceMediaToDataUrl)),
                audios: await Promise.all(audioReferences.map(referenceMediaToDataUrl)),
            }, options?.signal);
            task = { ...submitted, provider: "comfyui-video", model: selectedModel };
        } else if (isRunningHubConfig(requestConfig)) {
            const submitted = await submitRunningHubVideo(requestConfig, {
                prompt,
                seconds: resolveVideoDuration(requestConfig.videoSeconds || "5", prompt, integerDurationRange(4, 15), 5),
                ratio: normalizeSeedanceRatio(requestConfig.size),
                resolution: normalizeSeedanceResolution(requestConfig.vquality),
                generateAudio: boolConfig(requestConfig.videoGenerateAudio, true),
            }, {
                images: await Promise.all(references.map(async ref => ({ name: ref.name, type: ref.type || "image/png", url: await imageToDataUrl(ref) }))),
                videos: await Promise.all(videoReferences.map(async ref => ({ name: ref.name, type: ref.type || "video/mp4", url: await referenceMediaToDataUrl(ref) }))),
                audios: await Promise.all(audioReferences.map(async ref => ({ name: ref.name, type: ref.type || "audio/mpeg", url: await referenceMediaToDataUrl(ref) }))),
            }, options?.signal);
            task = { ...submitted, provider: "runninghub", model: selectedModel };
        } else if (isAgnesConfig(requestConfig)) {
            const submitted = await submitAgnesVideo(requestConfig, {
                prompt,
                seconds: resolveVideoDuration(requestConfig.videoSeconds || "5", prompt, integerDurationRange(4, 12), 5),
                size: requestConfig.size,
                images: references.map(ref => /^https?:\/\//i.test(ref.url || "") ? ref.url! : ref.dataUrl),
                videos: videoReferences.map(ref => ref.url),
                audios: audioReferences.map(ref => ref.url),
            }, options?.signal);
            task = { ...submitted, provider: "agnes", model: selectedModel };
        } else if (requestConfig.apiFormat === "dola") {
            const refs = {
                images: await Promise.all(references.map(async (ref) => ({ name: ref.name, type: ref.type || "image/png", url: await imageToDataUrl(ref) }))),
                videos: await Promise.all(videoReferences.map(async (ref) => ({ name: ref.name, type: ref.type || "video/mp4", url: await referenceMediaToDataUrl(ref) }))),
                audios: await Promise.all(audioReferences.map(async (ref) => ({ name: ref.name, type: ref.type || "audio/mpeg", url: await referenceMediaToDataUrl(ref) }))),
            };
            task = { ...await submitDolaVideo(requestConfig, prompt, refs, options?.signal), provider: "dola", model: selectedModel };
        } else if (requestConfig.apiFormat === "autodl") {
            const body = buildAutodlVideoBody({
                prompt,
                seconds: resolveVideoDuration(requestConfig.videoSeconds, prompt, integerDurationRange(1, 15), 5),
                size: requestConfig.size,
                quality: requestConfig.vquality,
                images: await Promise.all(references.map((image) => imageToDataUrl(image))),
                audios: await Promise.all(audioReferences.map(referenceMediaToDataUrl)),
                videoCount: videoReferences.length,
            });
            task = { ...await submitAutodlVideo(requestConfig, requestConfig.model, body, options?.signal), provider: "autodl-video", model: selectedModel };
        } else if (requestConfig.apiFormat === "comfyui" && isZealmanWorkflowModel(selectedModel, requestConfig)) {
            task = await createZealmanVideoTask(requestConfig, requestConfig.model, selectedModel, prompt, references, videoReferences, audioReferences, options);
        } else if (isFeimiaoModelConfig(config, selectedModel)) task = await createFeimiaoVideoTask(requestConfig, selectedModel, prompt, references, options);
        else {
            const script = resolveModelScript(config, selectedModel);
            if (script) task = await createPluginVideoTask(requestConfig, selectedModel, script, prompt, references, options);
            else if (isSeedanceVideoConfig(requestConfig)) task = await createSeedanceTask(requestConfig, selectedModel, prompt, references, videoReferences, audioReferences, options);
            else {
                if (videoReferences.length || audioReferences.length) throw new Error(apiText("videoReferencesUnsupported"));
                task = await createOpenAIVideoTask(requestConfig, selectedModel, prompt, references, options);
            }
        }
        await options?.onRemoteTask?.(task);
        return task;
    });
}

export async function pollVideoGenerationTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const state = await pollVideoGenerationTaskOnce(config, task, options);
        if (state.status === "completed") recordModelApiResult(task.model);
        if (state.status === "failed") recordModelApiResult(task.model, new Error(state.error));
        return state;
    } catch (error) {
        recordModelApiResult(task.model, error);
        throw error;
    }
}

async function pollVideoGenerationTaskOnce(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    if (task.provider === "plugin") {
        const result = pluginVideoResults.get(task.id);
        return result ? { status: "completed", result } : { status: "failed", error: apiText("pluginVideoExpired") };
    }
    const requestConfig = resolveModelRequestConfig(config, task.model);
    assertVideoConfig(requestConfig, requestConfig.model);
    if (task.provider === "runninghub") {
        const state = await pollRunningHubVideo(requestConfig, task.id, options?.signal);
        return state.status === "completed" ? { status: "completed", result: await videoResultFromUrl(state.url, options) } : state;
    }
    if (task.provider === "agnes") {
        const state = await pollAgnesVideo(requestConfig, task.id, options?.signal);
        return state.status === "completed" ? { status: "completed", result: await videoResultFromUrl(state.url, options) } : state;
    }
    if (task.provider === "dola") {
        const state = await pollDolaVideo(requestConfig, task.id, options?.signal);
        return state.status === "completed" ? { status: "completed", result: await videoResultFromUrl(state.url, options) } : state;
    }
    if (task.provider === "autodl-video") {
        const state = await pollAutodlVideo(requestConfig, task.id, options?.signal);
        return state.status === "completed" ? { status: "completed", result: await videoResultFromUrl(state.url, options) } : state;
    }
    if (task.provider === "feimiao") return pollFeimiaoVideoTask(requestConfig, task, options);
    if (task.provider === "comfyui-video") {
        const snapshot = rhSnapshot(task.inputSnapshot);
        if (snapshot) {
            const state = await pollRhWorkflow(requestConfig, task.id, snapshot, options?.signal);
            return state.status === "completed" ? { status: "completed", result: await videoResultFromUrl(state.urls[0], options) } : state;
        }
        const state = await pollZealmanVideoTaskOnce(requestConfig, task.id, options?.signal, task);
        return state.status === "completed" ? { status: "completed", result: await videoResultFromUrl(state.url, options, state.requiresAuth ? aiHeaders(requestConfig) : undefined) } : state;
    }
    return task.provider === "seedance" ? pollSeedanceTask(requestConfig, task, options) : pollOpenAIVideoTask(requestConfig, task, options);
}

async function referenceMediaToDataUrl(reference: ReferenceVideo | ReferenceAudio) {
    if (/^data:/i.test(reference.url)) return normalizeMediaDataUrl(reference.url);
    if (/^https?:\/\//i.test(reference.url)) return reference.url;
    let blob: Blob | null = null;
    if (reference.storageKey) blob = await getMediaBlob(reference.storageKey);
    if (!blob && reference.url?.startsWith("blob:")) blob = await (await fetch(reference.url)).blob();
    if (!blob) throw new Error(apiText("localAssetReadFailed"));
    return blobToDataUrl(blob);
}

async function createZealmanVideoTask(config: AiConfig, workflowId: string, modelValue: string, prompt: string, images: ReferenceImage[], videos: ReferenceVideo[], audios: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const references = [
        ...(await Promise.all(images.map(async (image) => ({ name: image.name, type: image.type || "image/png", dataUrl: await imageToDataUrl(image) })))),
        ...(await Promise.all(videos.map(async (video) => {
            const normalized = await normalizeZealmanVideoReference(await referenceMediaToDataUrl(video), options?.signal);
            return { name: video.name, type: normalized.type || video.type || "video/mp4", dataUrl: normalized.dataUrl };
        }))),
        ...(await Promise.all(audios.map(async (audio) => ({ name: audio.name, type: audio.type || "audio/mpeg", dataUrl: await referenceMediaToDataUrl(audio) })))),
    ];
    const seconds = resolveVideoDuration(config.videoSeconds, prompt, integerDurationRange(1, 20), 5);
    const task = await submitZealmanWorkflowTask(config, { workflowId, prompt, size: config.size, quality: config.vquality, seconds, references }, options?.signal);
    return { ...task, provider: "comfyui-video", model: modelValue };
}

async function createPluginVideoTask(config: AiConfig, model: string, script: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (!config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
    const refs = await Promise.all(references.map((image) => imageToDataUrl(image)));
    const result = videoPluginResult(
        await runModelPlugin({
            capability: "video",
            script,
            config,
            prompt,
            images: refs,
            params: {
                seconds: normalizeVideoSeconds(config.videoSeconds, prompt),
                size: normalizeVideoSize(config.size),
                resolution: normalizeVideoResolution(config.vquality),
                ratio: config.size,
                generateAudio: boolConfig(config.videoGenerateAudio, true),
                watermark: boolConfig(config.videoWatermark, false),
            },
            signal: options?.signal,
        }),
    );
    const id = nanoid();
    pluginVideoResults.set(id, result);
    return { id, provider: "plugin", model };
}

function videoPluginResult(result: unknown): VideoGenerationResult {
    if (result instanceof Blob) return { blob: result };
    if (typeof result === "string") return { url: result, mimeType: "video/mp4" };
    if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        if (record.blob instanceof Blob) return { blob: record.blob };
        const url = [record.url, record.video_url, record.result_url].find((value) => typeof value === "string" && value) as string | undefined;
        if (url) return { url, mimeType: "video/mp4" };
    }
    throw new Error(apiText("scriptNoVideo"));
}

export async function storeGeneratedVideo(result: VideoGenerationResult): Promise<UploadedFile> {
    if (result.blob) return uploadMediaFile(result.blob, "video");
    if (result.url) {
        try {
            return await uploadMediaFile(result.url, "video");
        } catch {
            return { url: result.url, storageKey: "", bytes: 0, mimeType: result.mimeType || "video/mp4" };
        }
    }
    throw new Error(apiText("noPlayableVideo"));
}

async function createFeimiaoVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    const feimiao = resolveFeimiaoVideoRequest(config, model, prompt);
    assertStrictVideoReferenceLimit(references.length, 9, options);
    const refs = references.length ? await Promise.all(references.slice(0, 9).map((image) => imageToDataUrl(image))) : [];
    const request = buildFeimiaoVideoCreateRequest(feimiao, prompt, refs);

    // 字字 openai 后端（满血2.0 / fast-2.0 / sora / veo）：/v1/chat/completions
    if (feimiao.backend === "openai") {
        try {
            const response = await axios.post<Record<string, unknown>>(aiApiUrl(config, request.path), request.payload, {
                headers: { ...aiHeaders(config, "application/json"), Prefer: "respond-async" },
                signal: options?.signal,
                validateStatus: (status) => status === 200 || status === 202,
            });
            const body = response.data || {};
            const taskObj = (body.task as { id?: string; status_url?: string } | undefined) || undefined;
            const id = String(body.id || taskObj?.id || body.task_id || "");
            if (!id) throw new Error(apiText("noVideoTaskId"));
            const statusUrl = String(taskObj?.status_url || "").trim() || aiApiUrl(config, `/tasks/${id}`);
            return { id, provider: "feimiao", model, feimiaoBackend: "openai", statusUrl };
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
        }
    }

    try {
        const created = unwrapVideoResponse(
            (
                await axios.post<ApiVideoResponse>(aiApiUrl(config, request.path), request.payload, {
                    headers: aiHeaders(config, "application/json"),
                    signal: options?.signal,
                    validateStatus: (status) => status === 200 || status === 201,
                })
            ).data,
        );
        const id = String(created.id || created.task_id || "");
        if (!id) throw new Error(apiText("noVideoTaskId"));
        return { id, provider: "feimiao", model, feimiaoBackend: feimiao.backend };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function pollFeimiaoVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    if (task.feimiaoBackend === "openai") {
        try {
            const url = task.statusUrl || aiApiUrl(config, `/tasks/${task.id}`);
            const response = await axios.get<Record<string, unknown>>(url, { headers: aiHeaders(config), signal: options?.signal });
            const body = response.data || {};
            const status = String(body.status || "").toLowerCase();
            if (status === "completed") {
                const videoUrl = resolveFeimiaoChatVideoUrl(config.baseUrl, body);
                if (!videoUrl) return { status: "failed", error: apiText("videoGenerationFailed") };
                return { status: "completed", result: await videoResultFromUrl(videoUrl, options) };
            }
            if (status === "failed" || status === "cancelled" || status === "error") {
                return { status: "failed", error: readApiErrorMessage(body.error) || apiText("videoGenerationFailed") };
            }
            return { status: "pending", progress: readTaskProgress(body) };
        } catch (error) {
            throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
        }
    }
    // sora_videos / fmgo：与 OpenAI videos 轮询相同
    return pollOpenAIVideoTask(config, { id: task.id, provider: "openai", model: task.model }, options);
}

function resolveFeimiaoChatVideoUrl(baseUrl: string, body: Record<string, unknown>) {
    const result = body.result;
    if (result && typeof result === "object") {
        const record = result as Record<string, unknown>;
        if (typeof record.url === "string" && record.url) return absolutizeUrl(baseUrl, record.url);
        const choices = record.choices;
        if (Array.isArray(choices) && choices[0] && typeof choices[0] === "object") {
            const message = (choices[0] as { message?: { content?: string } }).message;
            const html = message?.content || "";
            const match = html.match(/https?:\/\/[^\s"'<>]+\.(?:mp4|webm|mov)/i) || html.match(/https?:\/\/[^\s"'<>]+/i);
            if (match?.[0]) return match[0];
        }
    }
    if (typeof body.url === "string" && body.url) return absolutizeUrl(baseUrl, body.url);
    if (typeof body.video_url === "string" && body.video_url) return absolutizeUrl(baseUrl, body.video_url);
    return "";
}

function absolutizeUrl(baseUrl: string, value: string) {
    if (/^https?:\/\//i.test(value) || value.startsWith("data:")) return value;
    try {
        return new URL(value, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
    } catch {
        return value;
    }
}

async function createOpenAIVideoTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], options?: RequestOptions): Promise<VideoGenerationTask> {
    assertStrictVideoReferenceLimit(references.length, 7, options);
    const body = new FormData();
    body.append("model", modelOptionName(model));
    body.append("prompt", prompt);
    body.append("seconds", normalizeVideoSeconds(config.videoSeconds, prompt));
    if (normalizeVideoSize(config.size)) body.append("size", normalizeVideoSize(config.size)!);
    body.append("resolution_name", normalizeVideoResolution(config.vquality));
    body.append("preset", "normal");
    const files = await Promise.all(references.slice(0, 7).map(async (image) => dataUrlToFile({ ...image, dataUrl: await imageToDataUrl(image) })));
    files.forEach((file) => body.append("input_reference[]", file));
    try {
        const created = unwrapVideoResponse((await axios.post<ApiVideoResponse>(aiApiUrl(config, "/videos"), body, { headers: aiHeaders(config), signal: options?.signal })).data);
        if (!created.id) throw new Error(apiText("noVideoTaskId"));
        return { id: created.id, provider: "openai", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskCreateFailed")));
    }
}

async function pollOpenAIVideoTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const video = unwrapVideoResponse((await axios.get<ApiVideoResponse>(aiApiUrl(config, `/videos/${task.id}`), { headers: aiHeaders(config), signal: options?.signal })).data);
        const url = videoResultUrl(video);
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        if (video.status === "completed") {
            const content = await axios.get<Blob>(aiApiUrl(config, `/videos/${task.id}/content`), { headers: aiHeaders(config), responseType: "blob", signal: options?.signal });
            await assertVideoBlob(content.data);
            return { status: "completed", result: { blob: content.data } };
        }
        if (video.status === "failed" || video.status === "cancelled") return { status: "failed", error: readApiErrorMessage(video.error?.message) || apiText("videoGenerationFailed") };
        return { status: "pending", progress: readTaskProgress(video) };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("videoTaskQueryFailed")));
    }
}

async function createSeedanceTask(config: AiConfig, model: string, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[], options?: RequestOptions): Promise<VideoGenerationTask> {
    assertStrictVideoReferenceLimit(references.length, SEEDANCE_REFERENCE_LIMITS.images, options);
    if (audioReferences.length && !references.length && !videoReferences.length) {
        throw new Error(apiText("seedanceAudioRequiresVisual"));
    }
    assertSeedanceVideoReferences(videoReferences);
    assertSeedanceAudioReferences(audioReferences);
    const content = await buildSeedanceContent(config, prompt, references, videoReferences, audioReferences);
    if (!content.length) throw new Error(apiText("videoPromptRequired"));
    const payload = {
        model: modelOptionName(model),
        content,
        ratio: normalizeSeedanceRatio(config.size),
        resolution: normalizeSeedanceResolution(config.vquality),
        duration: resolveSeedanceDuration(config.videoSeconds, prompt),
        generate_audio: boolConfig(config.videoGenerateAudio, true),
        watermark: boolConfig(config.videoWatermark, false),
    };

    try {
        const created = unwrapSeedanceTask((await axios.post<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config), payload, { headers: aiHeaders(config, "application/json"), signal: options?.signal })).data);
        if (!created.id) throw new Error(apiText("seedanceNoTaskId"));
        return { id: created.id, provider: "seedance", model };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("seedanceTaskCreateFailed")));
    }
}

export function assertStrictVideoReferenceLimit(actual: number, limit: number, options?: Pick<RequestOptions, "strictReferenceCount">) {
    if (!options?.strictReferenceCount || actual <= limit) return;
    throw new Error(`严格引用模式：当前视频接口最多接收 ${limit} 张参考图，但此镜头已 @ ${actual} 张。请减少引用，或改用支持更多参考图的工作流。`);
}

async function pollSeedanceTask(config: AiConfig, task: VideoGenerationTask, options?: RequestOptions): Promise<VideoGenerationTaskState> {
    try {
        const state = unwrapSeedanceTask((await axios.get<ApiEnvelope<SeedanceTask>>(seedanceApiUrl(config, task.id), { headers: aiHeaders(config), signal: options?.signal })).data);
        const url = videoResultUrl(state);
        if (url) return { status: "completed", result: await videoResultFromUrl(url, options) };
        if (state.status === "succeeded" || state.status === "completed") return { status: "failed", error: apiText("seedanceNoVideoUrl") };
        if (state.status === "failed" || state.status === "cancelled" || state.status === "expired")
            return { status: "failed", error: readApiErrorMessage(state.error?.message) || apiText(state.status === "expired" ? "seedanceVideoTimeout" : "seedanceVideoFailed") };
        return { status: "pending", progress: readTaskProgress(state) };
    } catch (error) {
        throw new Error(readAxiosError(error, apiText("seedanceTaskQueryFailed")));
    }
}

function assertSeedanceVideoReferences(videoReferences: ReferenceVideo[]) {
    const error = seedanceVideoReferenceError(videoReferences);
    if (error) throw new Error(error);
    let total = 0;
    for (const video of videoReferences) {
        if (!video.durationMs) continue;
        if (video.durationMs < 2000 || video.durationMs > 15000) throw new Error(apiText("seedanceVideoDuration"));
        total += video.durationMs;
    }
    if (total > 15000) throw new Error(apiText("seedanceVideoTotalDuration"));
}

function assertSeedanceAudioReferences(audioReferences: ReferenceAudio[]) {
    let total = 0;
    for (const audio of audioReferences) {
        if (!audio.durationMs) continue;
        if (audio.durationMs < 2000 || audio.durationMs > 15000) throw new Error(apiText("seedanceAudioDuration"));
        total += audio.durationMs;
    }
    if (total > 15000) throw new Error(apiText("seedanceAudioTotalDuration"));
}

function seedanceApiUrl(config: AiConfig, taskId?: string) {
    return buildApiUrl(config.baseUrl, `/contents/generations/tasks${taskId ? `/${encodeURIComponent(taskId)}` : ""}`);
}

async function buildSeedanceContent(config: AiConfig, prompt: string, references: ReferenceImage[], videoReferences: ReferenceVideo[], audioReferences: ReferenceAudio[]) {
    const content: Array<Record<string, unknown>> = [];
    const text = buildSeedancePromptText(prompt, references, videoReferences, audioReferences);
    if (text) content.push({ type: "text", text });
    for (const image of references.slice(0, SEEDANCE_REFERENCE_LIMITS.images)) {
        content.push({ type: "image_url", image_url: { url: await resolveSeedanceImageUrl(config, image) }, role: "reference_image" });
    }
    for (const video of videoReferences.slice(0, SEEDANCE_REFERENCE_LIMITS.videos)) {
        content.push({ type: "video_url", video_url: { url: await resolveSeedanceVideoUrl(video) }, role: "reference_video" });
    }
    for (const audio of audioReferences.slice(0, SEEDANCE_REFERENCE_LIMITS.audios)) {
        content.push({ type: "audio_url", audio_url: { url: await resolveSeedanceAudioUrl(audio) }, role: "reference_audio" });
    }
    return content;
}

async function resolveSeedanceImageUrl(config: AiConfig, image: ReferenceImage) {
    const directUrl = image.url || image.dataUrl;
    if (isPublicMediaUrl(directUrl) || directUrl.startsWith("asset://")) return directUrl;
    const dataUrl = await imageToDataUrl(image);
    if (!dataUrl) throw new Error(apiText("referenceImageReadFailed"));
    return dataUrl;
}

async function resolveSeedanceVideoUrl(video: ReferenceVideo) {
    if (isPublicMediaUrl(video.url) || video.url.startsWith("asset://")) return video.url;
    let blob: Blob | null = null;
    if (video.storageKey) blob = await getMediaBlob(video.storageKey);
    if (!blob && video.url?.startsWith("blob:")) blob = await (await fetch(video.url)).blob();
    if (!blob) throw new Error(apiText("invalidReferenceVideo"));
    return blobToDataUrl(blob);
}

async function resolveSeedanceAudioUrl(audio: ReferenceAudio) {
    if (isPublicMediaUrl(audio.url) || audio.url.startsWith("asset://")) return audio.url;
    let blob: Blob | null = null;
    if (audio.storageKey) blob = await getMediaBlob(audio.storageKey);
    if (!blob && audio.url?.startsWith("blob:")) blob = await (await fetch(audio.url)).blob();
    if (!blob) throw new Error(apiText("invalidReferenceAudio"));
    return blobToDataUrl(blob);
}

async function videoResultFromUrl(url: string, options?: RequestOptions, headers?: Record<string, string>): Promise<VideoGenerationResult> {
    try {
        const response = await axios.get<Blob>(url, { headers, responseType: "blob", signal: options?.signal });
        await assertVideoBlob(response.data);
        return { blob: response.data };
    } catch (error) {
        if (axios.isCancel(error) || options?.signal?.aborted) throw error;
        try {
            const response = await fetch(`/__media-proxy?url=${encodeURIComponent(url)}`, { signal: options?.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            await assertVideoBlob(blob);
            return { blob };
        } catch {
            return { url, mimeType: "video/mp4" };
        }
    }
}

function assertVideoConfig(config: AiConfig, model: string) {
    if (!model) throw new Error(apiText("videoModelRequired"));
    if (!config.baseUrl.trim()) throw new Error(apiText("baseUrlRequired"));
    if (config.apiFormat !== "comfyui" && config.apiFormat !== "dola" && !config.apiKey.trim()) throw new Error(apiText("apiKeyRequired"));
    if (config.apiFormat === "gemini") throw new Error(apiText("geminiVideoUnsupported"));
}

function normalizeVideoSeconds(value: string, prompt = "") {
    if (isAutoVideoDuration(value)) return String(resolveVideoDuration(value, prompt, integerDurationRange(5, 15)));
    const seconds = Math.floor(Number(value) || 6);
    return String(Math.max(1, Math.min(20, seconds)));
}

function normalizeVideoSize(value: string) {
    if (value === "auto") return null;
    const size = value || "1280x720";
    if (/^\d+x\d+$/.test(size)) return size;
    return ["9:16", "2:3", "3:4"].includes(size) ? "720x1280" : "1280x720";
}

function normalizeVideoResolution(value: string) {
    if (value === "low") return "480p";
    if (value === "auto" || value === "high" || value === "medium") return "720p";
    const resolution = value.replace(/p$/i, "") || "720";
    return `${resolution}p`;
}

function readTaskProgress(payload: unknown): number | undefined {
    if (!payload || typeof payload !== "object") return undefined;
    const record = payload as Record<string, unknown>;
    const raw = record.progress ?? record.percent ?? record.percentage ?? record.progress_percent;
    const value = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    if (!Number.isFinite(value)) return undefined;
    return Math.max(0, Math.min(100, Math.round(value > 0 && value < 1 ? value * 100 : value)));
}

function unwrapVideoResponse(payload: ApiVideoResponse) {
    return unwrapEnvelope(payload, apiText("noVideoTask"));
}

function unwrapSeedanceTask(payload: ApiEnvelope<SeedanceTask>) {
    return unwrapEnvelope(payload, apiText("seedanceNoTask"));
}

function unwrapEnvelope<T>(payload: ApiEnvelope<T>, emptyMessage: string): T {
    if (!payload) throw new Error(emptyMessage);
    if (typeof payload === "object" && "code" in payload && payload.code !== undefined) {
        if (payload.code !== 0 && payload.code !== "0") throw new Error(readApiErrorMessage(payload) || apiText("requestFailed"));
        if (!payload.data) throw new Error(emptyMessage);
        return payload.data;
    }
    return payload as T;
}

function videoResultUrl(payload: VideoResponse | SeedanceTask) {
    return [payload.video_url, payload.result_url, payload.url, payload.content?.video_url, payload.content?.url].find((url) => typeof url === "string" && (isPublicMediaUrl(url) || /\.mp4(\?|#|$)/i.test(url)));
}

function readApiErrorMessage(value: unknown): string {
    return summarizeApiError(value);
}

function readAxiosError(error: unknown, fallback: string) {
    if (axios.isCancel(error)) return apiText("requestCanceled");
    if (axios.isAxiosError<{ error?: { message?: string }; msg?: string; message?: string; code?: number | string }>(error)) {
        const responseData = error.response?.data;
        return summarizeApiError(responseData, statusMessage(error.response?.status, fallback));
    }
    if (error instanceof DOMException && error.name === "AbortError") return apiText("requestCanceled");
    if (error instanceof Error) return summarizeApiError(error.message, error.message) || fallback;
    return summarizeApiError(error, fallback);
}

function statusMessage(status: number | undefined, fallback: string) {
    if (status === 401 || status === 403) return apiText("authenticationFailed");
    if (status === 429) return apiText("rateLimited");
    if (status === 500 || status === 502 || status === 503) {
        return apiText(status === 500 ? "serviceInternalError" : status === 502 ? "badGateway" : "serviceBusy");
    }
    return status ? `${fallback}（${status}）` : fallback;
}

async function assertVideoBlob(blob: Blob) {
    if (!blob.type.includes("json")) return;
    let payload: { code?: number; msg?: string; error?: { message?: string } };
    try {
        payload = JSON.parse(await blob.text()) as { code?: number; msg?: string; error?: { message?: string } };
    } catch {
        return;
    }
    if (typeof payload.code === "number" && payload.code !== 0) throw new Error(readApiErrorMessage(payload) || apiText("videoDownloadFailed"));
    if (payload.error?.message) throw new Error(readApiErrorMessage(payload.error.message) || payload.error.message);
}

function isPublicMediaUrl(value: string) {
    return /^https?:\/\//i.test(value || "");
}

function delay(ms: number, signal?: AbortSignal) {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            "abort",
            () => {
                clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });
}

function blobToDataUrl(blob: Blob) {
    return mediaBlobToDataUrl(blob).catch(() => {
        throw new Error(apiText("localAssetReadFailed"));
    });
}

import { useMemo } from "react";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { nanoid } from "nanoid";

import i18n from "@/i18n";
import { normalizeImageAspect, normalizeImageResolution } from "@/lib/apimart-image";
import { configPersistStorage } from "@/lib/config-persist";
import { FEIMIAO_DEFAULT_ALIASES, resolveStoredFeimiaoAlias } from "@/lib/feimiao-video";

export type ApiCallFormat = "openai" | "gemini" | "ark" | "comfyui" | "autodl" | "dola";
export type ModelCapability = "image" | "video" | "text" | "audio";
export type ReasoningEffort = "auto" | "low" | "medium" | "high" | "xhigh";

export type ChannelModel = {
    name: string;
    capability: ModelCapability;
    script?: string;
    /** 界面展示名；请求仍使用 name */
    alias?: string;
    /** 接口判定该模型当前不可用（目录消失或模型级失败） */
    unavailable?: boolean;
    unavailableReason?: string;
};

export type ModelChannel = {
    id: string;
    name: string;
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    models: ChannelModel[];
    /** 飞喵 / fmgo 风格渠道：参数与请求体对齐字字动画 video_plugin_fmgo */
    feimiao?: boolean;
};

export type AiConfig = {
    channelMode: "remote" | "local";
    baseUrl: string;
    apiKey: string;
    apiFormat: ApiCallFormat;
    channels: ModelChannel[];
    model: string;
    imageModel: string;
    storyboardImageModel: string;
    videoModel: string;
    textModel: string;
    audioModel: string;
    audioVoice: string;
    audioFormat: string;
    audioSpeed: string;
    audioInstructions: string;
    videoSeconds: string;
    vquality: string;
    videoGenerateAudio: string;
    videoWatermark: string;
    systemPrompt: string;
    reasoningEffort: ReasoningEffort;
    models: string[];
    quality: string;
    size: string;
    imageSize: string;
    videoSize: string;
    background: string;
    count: string;
    canvasImageCount: string;
};

export type WebdavSyncConfig = {
    url: string;
    username: string;
    password: string;
    directory: string;
    lastSyncedAt: string;
};
export type ConfigTabKey = "channels" | "preferences" | "prompt-sources" | "webdav" | "local-storage";

export const CONFIG_STORE_KEY = "infinite-canvas:ai_config_store";
const CHANNEL_MODEL_SEPARATOR = "::";
const OPENAI_BASE_URL = "https://api.openai.com";
const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com";
const ARK_BASE_URL = "https://ark.cn-beijing.volces.com/api/v3";
export const defaultConfig: AiConfig = {
    channelMode: "local",
    baseUrl: "",
    apiKey: "",
    apiFormat: "openai",
    channels: [],
    model: "",
    imageModel: "",
    storyboardImageModel: "",
    videoModel: "",
    textModel: "",
    audioModel: "",
    audioVoice: "alloy",
    audioFormat: "mp3",
    audioSpeed: "1",
    audioInstructions: "",
    videoSeconds: "10",
    vquality: "480p",
    videoGenerateAudio: "true",
    videoWatermark: "false",
    systemPrompt: "",
    reasoningEffort: "auto",
    models: [],
    quality: "1k",
    size: "16:9",
    imageSize: "16:9",
    videoSize: "16:9",
    background: "",
    count: "1",
    canvasImageCount: "1",
};

export const defaultWebdavSyncConfig: WebdavSyncConfig = {
    url: "",
    username: "",
    password: "",
    directory: "infinite-canvas",
    lastSyncedAt: "",
};

type ConfigStore = {
    config: AiConfig;
    webdav: WebdavSyncConfig;
    isConfigOpen: boolean;
    configTab: ConfigTabKey;
    shouldPromptContinue: boolean;
    updateConfig: <K extends keyof AiConfig>(key: K, value: AiConfig[K]) => void;
    updateWebdavConfig: <K extends keyof WebdavSyncConfig>(key: K, value: WebdavSyncConfig[K]) => void;
    isAiConfigReady: (config: AiConfig, model: string) => boolean;
    openConfigDialog: (shouldPromptContinue?: boolean, tab?: ConfigTabKey) => void;
    setConfigDialogOpen: (isOpen: boolean) => void;
    clearPromptContinue: () => void;
};

const VIDEO_KEYWORDS = ["seedance", "video", "sora", "veo", "kling", "wan", "hailuo", "feimiao", "grok-video", "omni"];
const AUDIO_KEYWORDS = ["audio", "tts", "speech", "voice", "music", "sound"];
const IMAGE_KEYWORDS = ["seedream", "gpt-image", "image", "dall-e", "dalle", "imagen", "flux", "sdxl", "stable-diffusion", "midjourney"];

/** Best-effort default capability for a freshly fetched model name; user can override in the channel editor. */
export function guessCapability(name: string): ModelCapability {
    const value = name.toLowerCase();
    if (VIDEO_KEYWORDS.some((keyword) => value.includes(keyword))) return "video";
    if (AUDIO_KEYWORDS.some((keyword) => value.includes(keyword))) return "audio";
    if (IMAGE_KEYWORDS.some((keyword) => value.includes(keyword))) return "image";
    return "text";
}

function findChannelModel(config: AiConfig, value: string): { channel: ModelChannel; model: ChannelModel } | null {
    const decoded = decodeChannelModel(value);
    const name = decoded?.model || value;
    const channel = decoded ? config.channels.find((item) => item.id === decoded.channelId) : config.channels.find((item) => item.models.some((model) => model.name === name || (item.feimiao && model.name.startsWith(`${name}-`))));
    if (!channel) return null;
    const model = channel.models.find((item) => item.name === name) || (channel.feimiao ? channel.models.find((item) => item.name.startsWith(`${name}-`)) : undefined);
    if (!model) return null;
    // 飞喵基础名：对外仍用基础名，能力取变体
    if (channel.feimiao && model.name !== name) return { channel, model: { ...model, name, alias: model.alias } };
    return { channel, model };
}

export function modelCapabilityOf(config: AiConfig, value: string): ModelCapability | undefined {
    return findChannelModel(config, value)?.model.capability;
}

export function modelMatchesCapability(config: AiConfig, value: string, capability?: ModelCapability) {
    if (!capability) return true;
    return modelCapabilityOf(config, value) === capability;
}

export function firstEncodedModelForCapability(channels: ModelChannel[], capability: ModelCapability) {
    return selectableModelsByCapability({ ...defaultConfig, channels, models: modelOptionsFromChannels(channels) }, capability)[0] || "";
}

export function resolveModelForCapability(config: AiConfig, currentModel: string | undefined, capability: ModelCapability) {
    const defaultModel = capability === "image" ? config.imageModel : capability === "video" ? config.videoModel : capability === "audio" ? config.audioModel : config.textModel;
    const liveModel = selectableModelsByCapability(config, capability)[0] || "";
    const fallbackModel = capability === "image" ? defaultConfig.imageModel : capability === "video" ? defaultConfig.videoModel : capability === "audio" ? defaultConfig.audioModel : defaultConfig.textModel;
    if (currentModel && modelMatchesCapability(config, currentModel, capability)) return currentModel;
    if (defaultModel && modelMatchesCapability(config, defaultModel, capability)) return defaultModel;
    if (liveModel) return liveModel;
    return fallbackModel;
}

export function selectableModelsByCapability(config: AiConfig, capability?: ModelCapability) {
    if (!capability) return config.models;
    return config.channels.flatMap((channel) => {
        if (channel.feimiao && capability === "video") {
            const seen = new Set<string>();
            const options: string[] = [];
            for (const model of channel.models.filter((item) => item.capability === "video")) {
                const base = model.name.replace(/-(480p|720p|1080p|4k)-(\d+)s$/i, "");
                if (seen.has(base)) continue;
                seen.add(base);
                options.push(encodeChannelModel(channel.id, base));
            }
            return options;
        }
        return channel.models.filter((model) => model.capability === capability).map((model) => encodeChannelModel(channel.id, model.name));
    });
}

/** The user script (if any) attached to a model; empty string means use the system default call. */
export function resolveModelScript(config: AiConfig, value: string) {
    return findChannelModel(config, value)?.model.script?.trim() || "";
}

export function isAiConfigReady(config: AiConfig, model: string) {
    const channel = resolveModelChannel(config, model);
    return Boolean(model.trim() && channel.baseUrl.trim() && channelHasRequiredCredentials(channel));
}

export function channelHasRequiredCredentials(channel: Pick<ModelChannel, "apiFormat" | "apiKey">) {
    return channel.apiFormat === "comfyui" || channel.apiFormat === "dola" || Boolean(channel.apiKey.trim());
}

export function hasConfigForCapability(config: AiConfig, capability: ModelCapability): boolean {
    return config.channels.some((channel) => {
        const hasCapabilityModel = channel.models.some((m) => m.capability === capability);
        const hasChannelConfig = Boolean(channel.baseUrl.trim() && channelHasRequiredCredentials(channel));
        return hasCapabilityModel && hasChannelConfig;
    });
}

export const useConfigStore = create<ConfigStore>()(
    persist(
        (set, get) => ({
            config: defaultConfig,
            webdav: defaultWebdavSyncConfig,
            isConfigOpen: false,
            configTab: "channels",
            shouldPromptContinue: false,
            updateConfig: (key, value) =>
                set((state) => ({
                    config: {
                        ...state.config,
                        [key]: value,
                    },
                })),
            updateWebdavConfig: (key, value) =>
                set((state) => ({
                    webdav: {
                        ...state.webdav,
                        [key]: value,
                    },
                })),
            isAiConfigReady: (config, model) => isAiConfigReady(config, model),
            openConfigDialog: (shouldPromptContinue = false, configTab = "channels") => set({ isConfigOpen: true, shouldPromptContinue, configTab }),
            setConfigDialogOpen: (isConfigOpen) => set({ isConfigOpen }),
            clearPromptContinue: () => set({ shouldPromptContinue: false }),
        }),
        {
            name: CONFIG_STORE_KEY,
            storage: createJSONStorage(() => configPersistStorage),
            partialize: (state) => ({ config: state.config, webdav: state.webdav }),
            merge: (persisted, current) => {
                try {
                    const persistedState = (persisted || {}) as Partial<ConfigStore>;
                    const persistedConfig = (persistedState.config || {}) as Partial<AiConfig>;
                    const persistedWebdav = (persistedState.webdav || {}) as Partial<WebdavSyncConfig>;
                    const hasPersistedChannels = Array.isArray(persistedConfig.channels) && persistedConfig.channels.length > 0;
                    const hasCurrentChannels = Array.isArray(current.config?.channels) && current.config.channels.some((channel) => channel.apiKey?.trim() || channel.feimiao || (channel.baseUrl && !channel.baseUrl.includes("api.openai.com")));
                    // 持久化里没有渠道时，绝不能用空默认盖掉内存里已有的真实渠道
                    if (!hasPersistedChannels && hasCurrentChannels) {
                        return current;
                    }
                    const config = {
                        ...defaultConfig,
                        ...persistedConfig,
                        channels: hasPersistedChannels ? persistedConfig.channels! : hasCurrentChannels ? current.config.channels : [],
                    };
                    const channels = normalizeChannels(config);
                    // 归一化后若变成「无 Key 的默认空渠道」，但持久化原文曾带 Key，则回退原文渠道
                    const persistedHasKey = (persistedConfig.channels || []).some((channel) => channel.apiKey?.trim());
                    const normalizedHasKey = channels.some((channel) => channel.apiKey?.trim());
                    let finalChannels = persistedHasKey && !normalizedHasKey && Array.isArray(persistedConfig.channels) ? persistedConfig.channels : channels;
                    // 过滤掉没有 apiKey、没有模型、也不是飞喵的空壳渠道，防止自动创建的默认渠道混入
                    finalChannels = finalChannels.filter((channel) => {
                        const hasKey = Boolean(channel.apiKey?.trim());
                        const hasModels = channel.models.length > 0;
                        const isFeimiao = Boolean(channel.feimiao);
                        const customBase = Boolean(channel.baseUrl?.trim() && !/api\.openai\.com$/i.test(channel.baseUrl));
                        return hasKey || hasModels || isFeimiao || customBase;
                    });
                    const models = modelOptionsFromChannels(finalChannels);
                    return {
                        ...current,
                        webdav: { ...defaultWebdavSyncConfig, ...persistedWebdav },
                        config: {
                            ...config,
                            channelMode: "local",
                            apiFormat: normalizeApiFormat(config.apiFormat),
                            channels: finalChannels,
                            models,
                            imageModel: normalizeModelOptionValue(config.imageModel || config.model, finalChannels) || firstEncodedModelForCapability(finalChannels, "image"),
                            storyboardImageModel: normalizeModelOptionValue(config.storyboardImageModel || config.imageModel || config.model, finalChannels) || firstEncodedModelForCapability(finalChannels, "image"),
                            videoModel: normalizeModelOptionValue(config.videoModel, finalChannels) || firstEncodedModelForCapability(finalChannels, "video"),
                            textModel: normalizeModelOptionValue(config.textModel || config.model, finalChannels) || firstEncodedModelForCapability(finalChannels, "text"),
                            audioModel: normalizeModelOptionValue(config.audioModel || defaultConfig.audioModel, finalChannels) || firstEncodedModelForCapability(finalChannels, "audio"),
                            audioVoice: config.audioVoice || defaultConfig.audioVoice,
                            audioFormat: config.audioFormat || defaultConfig.audioFormat,
                            audioSpeed: config.audioSpeed || defaultConfig.audioSpeed,
                            audioInstructions: config.audioInstructions || "",
                            reasoningEffort: config.reasoningEffort || "auto",
                            videoSeconds: config.videoSeconds || "6",
                            vquality: config.vquality || "720",
                            videoGenerateAudio: config.videoGenerateAudio || "true",
                            videoWatermark: config.videoWatermark || "false",
                            canvasImageCount: config.canvasImageCount || "3",
                            quality: normalizeImageResolution(config.quality || "1k"),
                            size: config.size || "16:9",
                            imageSize: normalizeImageAspect(config.imageSize || config.size || "16:9"),
                            videoSize: config.videoSize || config.size || "16:9",
                        },
                    };
                } catch (error) {
                    console.error("[config] merge failed, keeping current state", error);
                    return current;
                }
            },
        },
    ),
);

export function useEffectiveConfig() {
    const config = useConfigStore((state) => state.config);
    return useMemo(() => ({ ...config, channelMode: "local" as const }), [config]);
}

/** 完整重开页面时，生成订单续轮询必须等渠道/API Key 从 IndexedDB 恢复完成。 */
export async function waitForConfigHydration() {
    if (useConfigStore.persist.hasHydrated()) return;
    await new Promise<void>((resolve) => {
        let unsubscribe = () => {};
        const done = () => {
            unsubscribe();
            resolve();
        };
        unsubscribe = useConfigStore.persist.onFinishHydration(done);
        if (useConfigStore.persist.hasHydrated()) done();
    });
}

/** Normalize a mixed list of raw model names or model objects into deduped ChannelModel entries. */
export function normalizeChannelModels(models: Array<string | ChannelModel> | undefined): ChannelModel[] {
    const seen = new Set<string>();
    const result: ChannelModel[] = [];
    for (const item of models || []) {
        const name = (typeof item === "string" ? item : item?.name || "").trim();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const capability = typeof item === "string" ? guessCapability(name) : item.capability || guessCapability(name);
        const script = typeof item === "string" ? undefined : item.script?.trim() || undefined;
        const alias = typeof item === "string" ? undefined : item.alias?.trim() || undefined;
        const unavailable = typeof item !== "string" && item.unavailable === true;
        const unavailableReason = typeof item === "string" ? undefined : item.unavailableReason?.trim() || undefined;
        result.push({
            name,
            capability,
            script,
            ...(alias ? { alias } : {}),
            ...(unavailable ? { unavailable: true, ...(unavailableReason ? { unavailableReason } : {}) } : {}),
        });
    }
    return result;
}

export function createModelChannel(channel?: Partial<ModelChannel>): ModelChannel {
    const apiFormat = normalizeApiFormat(channel?.apiFormat);
    return {
        id: channel?.id?.trim() || nanoid(),
        name: channel?.name?.trim() || i18n.t("config.channels.newName"),
        baseUrl: channel?.baseUrl?.trim() || defaultBaseUrlForApiFormat(apiFormat),
        apiKey: channel?.apiKey || "",
        apiFormat,
        models: normalizeChannelModels(channel?.models),
        feimiao: Boolean(channel?.feimiao),
    };
}

export function encodeChannelModel(channelId: string, model: string) {
    return `${channelId}${CHANNEL_MODEL_SEPARATOR}${model.trim()}`;
}

export function isChannelModelValue(value: string) {
    return value.includes(CHANNEL_MODEL_SEPARATOR);
}

export function decodeChannelModel(value: string) {
    const index = value.indexOf(CHANNEL_MODEL_SEPARATOR);
    if (index < 0) return null;
    return { channelId: value.slice(0, index), model: value.slice(index + CHANNEL_MODEL_SEPARATOR.length) };
}

export function modelOptionName(value: string) {
    return decodeChannelModel(value)?.model || value;
}

export function modelOptionLabel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    if (!decoded) return value;
    const channel = config.channels.find((item) => item.id === decoded.channelId);
    if (!channel) return decoded.model;
    const feimiaoAliasMap: Record<string, string> = {
        "grok-1.5": "grok-1.5",
        "grok-1.5-fast": "grok-1.5-fast",
        "sora-2": "sora-2",
        "sora-2-pro": "sora-2-pro",
        "veo-3.1": "veo-3.1",
        "veo-3.1-fast": "veo-3.1-fast",
        omni: "omni",
        "feimiao-v2": "满血2.0",
        "feimiao-v2-fast": "fast-2.0",
        "feimiao-v2-431": "满血-2.0-431",
        "feimiao-v2-431-fast": "fast-2.0-431",
    };
    if (channel.feimiao) {
        const base = decoded.model.replace(/-(480p|720p|1080p|4k)-(\d+)s$/i, "");
        const model =
            channel.models.find((item) => item.name === decoded.model) ||
            channel.models.find((item) => item.name === base) ||
            // 仅匹配「base-清晰度-时长」变体，避免 feimiao-v2 误命中 feimiao-v2-431
            channel.models.find((item) => /-(480p|720p|1080p|4k)-\d+s$/i.test(item.name) && item.name.replace(/-(480p|720p|1080p|4k)-(\d+)s$/i, "") === base);
        const alias = resolveStoredFeimiaoAlias(model?.alias, base) || feimiaoAliasMap[base] || feimiaoAliasMap[decoded.model];
        // 飞喵：只显示别名，不拼秒数/渠道名
        if (alias) return alias.replace(/\s+\d+p\s+\d+s$/i, "").trim();
        return base;
    }
    const model = channel.models.find((item) => item.name === decoded.model);
    // 所有渠道：有别名只显示别名，绝不拼「（渠道名）」
    if (model?.alias?.trim()) return model.alias.trim();
    return decoded.model;
}

export function modelOptionsFromChannels(channels: ModelChannel[]) {
    return uniqueModelOptions(channels.flatMap((channel) => channel.models.map((model) => encodeChannelModel(channel.id, model.name))));
}

export function normalizeModelOptionValue(value: string | undefined, channels: ModelChannel[]) {
    const model = (value || "").trim();
    if (!model) return "";
    const decoded = decodeChannelModel(model);
    if (decoded) {
        const channel = channels.find((item) => item.id === decoded.channelId);
        if (!channel) return "";
        if (channel.models.some((item) => item.name === decoded.model)) return model;
        if (channel.feimiao) {
            const base = decoded.model.replace(/-(480p|720p|1080p|4k)-(\d+)s$/i, "");
            // 旧配置里的变体名自动落到字字基础模型
            if (base !== decoded.model && channel.models.some((item) => item.name === base)) {
                return encodeChannelModel(channel.id, base);
            }
            if (channel.models.some((item) => item.name === decoded.model || item.name.startsWith(`${decoded.model}-`))) return model;
        }
        return "";
    }
    const channel = channels.find((item) => item.models.some((entry) => entry.name === model)) || channels[0];
    return channel && channel.models.some((item) => item.name === model) ? encodeChannelModel(channel.id, model) : model;
}

export function resolveModelChannel(config: AiConfig, value: string) {
    const decoded = decodeChannelModel(value);
    const model = decoded?.model || value;
    const matched = decoded ? config.channels.find((channel) => channel.id === decoded.channelId) : config.channels.find((channel) => channel.models.some((item) => item.name === model));
    return (
        matched ||
        config.channels[0] ||
        createModelChannel({
            id: "default",
            name: i18n.t("config.channels.defaultName"),
            baseUrl: config.baseUrl,
            apiKey: config.apiKey,
            apiFormat: config.apiFormat,
            models: config.models.map(modelOptionName).map((name) => ({ name, capability: guessCapability(name) })),
        })
    );
}

export function resolveModelRequestConfig(config: AiConfig, value: string) {
    const channel = resolveModelChannel(config, value);
    return {
        ...config,
        model: modelOptionName(value || config.model),
        baseUrl: channel.baseUrl,
        apiKey: channel.apiKey,
        apiFormat: channel.apiFormat,
    };
}

/** 飞喵渠道：按字字插件折叠 480p-10s 变体；别名为空或误等于模型 ID 时回填默认，不覆盖真正手改 */
function withFeimiaoAliases(models: ChannelModel[], feimiao?: boolean) {
    if (!feimiao) return models;
    const kept: ChannelModel[] = [];
    const videoByBase = new Map<string, ChannelModel>();
    for (const model of models) {
        const base = model.name.replace(/-(480p|720p|1080p|4k)-(\d+)s$/i, "");
        if (!(base in FEIMIAO_DEFAULT_ALIASES)) {
            kept.push(model);
            continue;
        }
        const alias = resolveStoredFeimiaoAlias(model.alias, base);
        const existing = videoByBase.get(base);
        if (existing) {
            let next = existing;
            if (!resolveStoredFeimiaoAlias(existing.alias, base) && alias) next = { ...next, alias };
            if (model.unavailable && !existing.unavailable) {
                next = { ...next, unavailable: true, ...(model.unavailableReason ? { unavailableReason: model.unavailableReason } : {}) };
            }
            if (next !== existing) videoByBase.set(base, next);
            continue;
        }
        videoByBase.set(base, {
            ...model,
            name: base,
            capability: "video",
            ...(alias ? { alias } : {}),
        });
    }
    return [...kept, ...videoByBase.values()];
}

function normalizeChannels(config: AiConfig) {
    const persistedChannels = Array.isArray(config.channels) ? config.channels : [];
    const channels = persistedChannels.map((channel, index) => {
        const baseUrl = channel.baseUrl?.trim() || "";
        const feimiaoUrl = channel.feimiao && (!baseUrl || /api\.openai\.com/i.test(baseUrl)) ? "https://api.fmgo.top" : channel.baseUrl;
        return createModelChannel({
            ...channel,
            id: channel.id || (index === 0 ? "default" : `channel-${index + 1}`),
            name: channel.name || (index === 0 ? i18n.t("config.channels.defaultName") : i18n.t("config.channels.indexedName", { index: index + 1 })),
            baseUrl: feimiaoUrl,
            models: withFeimiaoAliases(normalizeChannelModels(channel.models), channel.feimiao),
        });
    });
    return channels;
}

export function defaultBaseUrlForApiFormat(apiFormat: ApiCallFormat) {
    if (apiFormat === "dola") return "http://127.0.0.1:5600/api";
    if (apiFormat === "autodl") return "https://autodl.art";
    if (apiFormat === "comfyui") return "";
    if (apiFormat === "gemini") return GEMINI_BASE_URL;
    if (apiFormat === "ark") return ARK_BASE_URL;
    return OPENAI_BASE_URL;
}

function normalizeApiFormat(apiFormat: unknown): ApiCallFormat {
    return apiFormat === "gemini" || apiFormat === "ark" || apiFormat === "comfyui" || apiFormat === "autodl" || apiFormat === "dola" ? apiFormat : "openai";
}

function uniqueModelOptions(models: string[]) {
    return Array.from(new Set((models || []).map((model) => model.trim()).filter(Boolean)));
}

export function buildApiUrl(baseUrl: string, path: string) {
    let normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, "");
    normalizedBaseUrl = normalizeArkPlanBaseUrl(normalizedBaseUrl);
    const lowerBaseUrl = normalizedBaseUrl.toLowerCase();
    const apiBaseUrl = lowerBaseUrl.endsWith("/v1") || lowerBaseUrl.endsWith("/api/v3") || lowerBaseUrl.endsWith("/api/plan/v3") ? normalizedBaseUrl : `${normalizedBaseUrl}/v1`;
    return `${apiBaseUrl}${path}`;
}

function normalizeArkPlanBaseUrl(baseUrl: string) {
    try {
        const url = new URL(baseUrl);
        const path = url.pathname.replace(/\/+$/, "");
        const lowerPath = path.toLowerCase();
        const arkPlanIndex = lowerPath.indexOf("/api/plan/v3");
        if (arkPlanIndex < 0) return baseUrl;
        const end = arkPlanIndex + "/api/plan/v3".length;
        if (lowerPath.length !== end && lowerPath[end] !== "/") return baseUrl;
        url.pathname = path.slice(0, end);
        url.search = "";
        url.hash = "";
        return url.toString().replace(/\/+$/, "");
    } catch {
        return baseUrl;
    }
}

import type { AiConfig, ChannelModel, ModelChannel } from "@/stores/use-config-store";
import { decodeChannelModel, modelOptionName, resolveModelChannel } from "@/stores/use-config-store";
import { integerDurationRange, resolveVideoDuration } from "@/lib/video-duration";

export type FeimiaoBackend = "sora_videos" | "openai" | "fmgo";

export type FeimiaoModelSpec = {
    durations: number[];
    aspectRatios: string[];
    resolutions: string[];
    defaultResolution: string;
    backend: FeimiaoBackend;
};

/** 与字字动画 video_plugin_fmgo MODEL_SPECS 对齐 */
export const FEIMIAO_MODEL_SPECS: Record<string, FeimiaoModelSpec> = {
    "minimax-h3-768p": { durations: integerDurationRange(4, 15), aspectRatios: ["16:9", "9:16", "1:1", "4:3", "3:4", "21:9"], resolutions: ["768p"], defaultResolution: "768p", backend: "sora_videos" },
    "grok-1.5": { durations: [10, 15], aspectRatios: ["16:9", "9:16", "1:1", "2:3", "3:2"], resolutions: ["480p", "720p"], defaultResolution: "720p", backend: "fmgo" },
    "grok-1.5-fast": { durations: [6, 10], aspectRatios: ["16:9", "9:16", "1:1", "2:3", "3:2"], resolutions: ["480p", "720p"], defaultResolution: "720p", backend: "fmgo" },
    "sora-2": { durations: [4, 8, 12], aspectRatios: ["16:9", "9:16"], resolutions: [], defaultResolution: "", backend: "openai" },
    "sora-2-pro": { durations: [4, 8, 12], aspectRatios: ["16:9", "9:16"], resolutions: [], defaultResolution: "", backend: "openai" },
    "veo-3.1": { durations: [4, 6, 8], aspectRatios: ["16:9", "9:16"], resolutions: ["720p", "1080p"], defaultResolution: "720p", backend: "openai" },
    "veo-3.1-fast": { durations: [4, 6, 8], aspectRatios: ["16:9", "9:16"], resolutions: ["720p", "1080p"], defaultResolution: "720p", backend: "openai" },
    omni: { durations: [8, 10], aspectRatios: ["16:9", "9:16"], resolutions: ["720p"], defaultResolution: "720p", backend: "sora_videos" },
    "feimiao-v2": { durations: [6, 8, 10, 12, 15], aspectRatios: ["16:9", "9:16", "1:1", "2:3", "3:2"], resolutions: ["480p", "720p"], defaultResolution: "720p", backend: "openai" },
    "feimiao-v2-fast": { durations: [6, 8, 10, 12, 15], aspectRatios: ["16:9", "9:16", "1:1", "2:3", "3:2"], resolutions: ["480p", "720p"], defaultResolution: "720p", backend: "openai" },
    "feimiao-v2.5": { durations: [5], aspectRatios: ["16:9", "9:16", "1:1", "2:3", "3:2"], resolutions: ["480p"], defaultResolution: "480p", backend: "sora_videos" },
    "feimiao-v2-431": { durations: [10, 15], aspectRatios: ["16:9", "9:16", "1:1"], resolutions: ["480p", "720p"], defaultResolution: "720p", backend: "sora_videos" },
    "feimiao-v2-431-fast": { durations: [10, 15], aspectRatios: ["16:9", "9:16", "1:1"], resolutions: ["480p", "720p"], defaultResolution: "720p", backend: "sora_videos" },
};

/** 非变体 ID 的飞喵 2.x（v2.5 / mini 等）按时长字段提交，允许 5–15 秒。 */
export const FEIMIAO_V2_FLEX_DURATIONS = integerDurationRange(5, 15);

/** 与字字动画 _MODEL_DISPLAY_MAP 对齐（431-fast 界面别名用 fast-2.0-431） */
export const FEIMIAO_DEFAULT_ALIASES: Record<string, string> = {
    "grok-1.5": "grok-1.5",
    "grok-1.5-fast": "grok-1.5-fast",
    "sora-2": "sora-2",
    "sora-2-pro": "sora-2-pro",
    "veo-3.1": "veo-3.1",
    "veo-3.1-fast": "veo-3.1-fast",
    omni: "omni",
    "feimiao-v2": "满血2.0",
    "feimiao-v2-fast": "fast-2.0",
    "feimiao-v2.5": "feimiao-v2.5-480p-5s",
    "feimiao-v2-431": "满血-2.0-431",
    "feimiao-v2-431-fast": "fast-2.0-431",
};

export const FEIMIAO_DEFAULT_BASE_URL = "https://api.fmgo.top";

/** 上游真实模型 ID → 字字基础名。目录拉取到 gemini-omni-flash 时必须折回 omni，否则会按默认 480p 提交并触发接口 500。 */
const FEIMIAO_UPSTREAM_BASE: Record<string, string> = {
    "gemini-omni-flash": "omni",
};

const VARIANT_SUFFIX_RE = /-(480p|720p|1080p|4k)-(\d+)s$/i;

/**
 * 目录常返回 grok-video-1.5-15s / grok-video-10s 等完整上游 ID。
 * 必须折回字字基础名，否则会落到默认 sora_videos，发出 aspect_ratio/seconds，
 * 上游再解析模型名里的 1.5-15 时出现 invalid character '-' in numeric literal。
 */
function parseGrokUpstreamModel(modelName: string): { base: "grok-1.5" | "grok-1.5-fast"; duration: number } | null {
    const name = modelName.trim();
    const full = name.match(/^grok-video-1\.5(?:-(\d+)s)?$/i);
    if (full) return { base: "grok-1.5", duration: Number(full[1]) || 0 };
    const fast = name.match(/^grok-video(?:-(\d+)s)?$/i);
    if (fast) return { base: "grok-1.5-fast", duration: Number(fast[1]) || 0 };
    return null;
}

export function isFeimiaoChannel(channel: ModelChannel | null | undefined) {
    if (channel?.feimiao) return true;
    if (!channel || channel.apiFormat !== "openai") return false;
    try {
        // 仅匹配真实飞喵域名，不改写用户的地址或密钥。
        const url = new URL(channel.baseUrl);
        return ["https:", "http:"].includes(url.protocol) && ["fmgo.top", "www.fmgo.top", "api.fmgo.top"].includes(url.hostname);
    } catch {
        return false;
    }
}

/** 按模型 ID 识别飞喵视频，不改用户当前渠道的 Base URL / Key。 */
export function isFeimiaoVideoModelName(modelName: string) {
    const base = feimiaoBaseName(modelName);
    // H3 也存在于其他服务商；仅通过飞喵渠道识别，不能按名字接管其他渠道。
    if (base === "minimax-h3-768p") return false;
    return Boolean(FEIMIAO_MODEL_SPECS[base]) || /^feimiao(?:-v2)?(?:-|$)/i.test(base) || /^gemini-omni/i.test(modelName.trim());
}

export function isFeimiaoModelConfig(config: AiConfig, modelValue?: string) {
    const value = modelValue || config.videoModel || config.model;
    if (isFeimiaoChannel(resolveModelChannel(config, value))) return true;
    return isFeimiaoVideoModelName(modelOptionName(value));
}

export function feimiaoBaseName(modelName: string) {
    const name = modelName.trim();
    const grok = parseGrokUpstreamModel(name);
    if (grok) return grok.base;
    const stripped = name.replace(VARIANT_SUFFIX_RE, "");
    if (FEIMIAO_UPSTREAM_BASE[stripped]) return FEIMIAO_UPSTREAM_BASE[stripped];
    if (FEIMIAO_UPSTREAM_BASE[name]) return FEIMIAO_UPSTREAM_BASE[name];
    if (FEIMIAO_MODEL_SPECS[stripped]) return stripped;
    if (FEIMIAO_MODEL_SPECS[name]) return name;
    // 别名 / 错误存成别名时，反查回字字基础模型名
    for (const [base, alias] of Object.entries(FEIMIAO_DEFAULT_ALIASES)) {
        if (alias === stripped || alias === name) return base;
    }
    return stripped || name;
}

/** 结合渠道里用户手改别名，解析出字字基础模型名 */
export function resolveFeimiaoBaseModel(modelName: string, channel?: ModelChannel | null) {
    const raw = modelOptionName(modelName).trim();
    const base = feimiaoBaseName(raw);
    if (FEIMIAO_MODEL_SPECS[base]) return base;
    if (channel) {
        for (const model of channel.models) {
            const alias = model.alias?.trim();
            if (alias && (alias === raw || alias === base)) return feimiaoBaseName(model.name);
            if (model.name === raw || feimiaoBaseName(model.name) === raw) return feimiaoBaseName(model.name);
        }
    }
    return base;
}

export function parseFeimiaoVariant(modelName: string) {
    const name = modelName.trim();
    const grok = parseGrokUpstreamModel(name);
    if (grok) return { base: grok.base, resolution: "", duration: grok.duration };
    const match = name.match(VARIANT_SUFFIX_RE);
    if (!match) return { base: feimiaoBaseName(modelName), resolution: "", duration: 0 };
    return { base: feimiaoBaseName(modelName), resolution: match[1].toLowerCase(), duration: Number(match[2]) || 0 };
}

export function getFeimiaoSpec(modelName: string): FeimiaoModelSpec {
    const base = feimiaoBaseName(modelName);
    if (FEIMIAO_MODEL_SPECS[base]) return FEIMIAO_MODEL_SPECS[base];
    if (/^feimiao-v2-431/i.test(base)) return FEIMIAO_MODEL_SPECS["feimiao-v2-431"];
    // mini 等未文档化的新模型暂沿用满血2.0；v2.5 已有独立 /videos 固定规格。
    if (/^feimiao-v2/i.test(base)) return { ...FEIMIAO_MODEL_SPECS["feimiao-v2"], durations: FEIMIAO_V2_FLEX_DURATIONS };
    return {
        durations: [10, 15],
        aspectRatios: ["16:9", "9:16", "1:1"],
        resolutions: ["480p", "720p"],
        defaultResolution: "720p",
        backend: "sora_videos",
    };
}

export function feimiaoAliasOf(model: ChannelModel | string, fallbackName?: string) {
    if (typeof model === "string") {
        const base = feimiaoBaseName(model);
        return FEIMIAO_DEFAULT_ALIASES[base] || fallbackName || model;
    }
    if (model.alias?.trim()) return model.alias.trim();
    const base = feimiaoBaseName(model.name);
    return FEIMIAO_DEFAULT_ALIASES[base] || model.name;
}

export function normalizeFeimiaoAspectRatio(value: string, modelName: string) {
    const spec = getFeimiaoSpec(modelName);
    const text = (value || "").trim();
    return spec.aspectRatios.includes(text) ? text : spec.aspectRatios[0] || "16:9";
}

export function normalizeFeimiaoResolution(value: string, modelName: string) {
    const spec = getFeimiaoSpec(modelName);
    if (!spec.resolutions.length) return "";
    let text = (value || "").trim().toLowerCase();
    if (!text.endsWith("p") && /^\d+$/.test(text)) text = `${text}p`;
    if (text === "sd") text = "480p";
    if (spec.resolutions.includes(text)) return text;
    return spec.defaultResolution || spec.resolutions[0];
}

export function normalizeFeimiaoDuration(value: string, modelName: string) {
    const spec = getFeimiaoSpec(modelName);
    const duration = Math.floor(Number(String(value).replace(/s$/i, "")) || spec.durations[0]);
    return spec.durations.includes(duration) ? duration : spec.durations[0];
}

export function resolveFeimiaoDuration(value: string, modelName: string, prompt = "") {
    return resolveVideoDuration(value, prompt, getFeimiaoSpec(modelName).durations);
}

/** 仅对飞喵目录已确认使用清晰度/时长后缀的基础名恢复真实上游模型 ID。 */
const FEIMIAO_SUFFIXED_BASES = new Set(["feimiao-v2", "feimiao-v2-fast", "feimiao-v2.5", "feimiao-v2-431", "feimiao-v2-431-fast"]);

export function buildFeimiaoUpstreamModel(modelName: string, resolution: string, duration: number) {
    const base = feimiaoBaseName(modelName);
    const resolved = normalizeFeimiaoResolution(resolution, base);
    if (base === "omni") return "gemini-omni-flash";
    if (base === "grok-1.5") return `grok-video-1.5-${duration}s`;
    if (base === "grok-1.5-fast") return `grok-video-${duration}s`;
    if (FEIMIAO_SUFFIXED_BASES.has(base) && resolved) return `${base}-${resolved}-${duration}s`;
    return base;
}

export function listFeimiaoBaseModels(channel: ModelChannel) {
    const map = new Map<string, ChannelModel>();
    for (const model of channel.models) {
        if (model.capability !== "video") continue;
        const base = feimiaoBaseName(model.name);
        const current = map.get(base);
        if (!current || (model.alias && !current.alias)) {
            map.set(base, { ...model, name: base, alias: model.alias || FEIMIAO_DEFAULT_ALIASES[base] || current?.alias });
        }
    }
    return Array.from(map.values());
}

export function resolveFeimiaoVideoRequest(config: AiConfig, modelValue: string, prompt = "") {
    const channel = resolveModelChannel(config, modelValue);
    const rawName = modelOptionName(modelValue);
    const parsed = parseFeimiaoVariant(rawName);
    const base = resolveFeimiaoBaseModel(parsed.base, channel);
    const resolution = normalizeFeimiaoResolution(config.vquality || parsed.resolution, base);
    const duration = resolveFeimiaoDuration(config.videoSeconds || String(parsed.duration || ""), base, prompt);
    const aspectRatio = normalizeFeimiaoAspectRatio(config.size, base);
    const upstreamModel = buildFeimiaoUpstreamModel(base, resolution, duration);
    const spec = getFeimiaoSpec(base);
    return { channel, base, resolution, duration, aspectRatio, upstreamModel, backend: spec.backend };
}

/** 构造飞喵创建任务请求；保持为纯函数，便于锁定端点、模型 ID 与参考图字段。 */
export function buildFeimiaoVideoCreateRequest(feimiao: ReturnType<typeof resolveFeimiaoVideoRequest>, prompt: string, refs: string[]) {
    if (feimiao.backend === "openai") {
        const content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [{ type: "text", text: prompt }];
        refs.forEach((url) => content.push({ type: "image_url", image_url: { url } }));
        const videoConfig: Record<string, unknown> = {
            duration: feimiao.duration,
            aspectRatio: feimiao.aspectRatio,
        };
        if (feimiao.resolution) videoConfig.resolution = feimiao.resolution;
        const payload: Record<string, unknown> = {
            model: feimiao.upstreamModel,
            messages: [{ role: "user", content }],
            generationConfig: { videoConfig },
            async: true,
        };
        if (feimiao.base.startsWith("veo-3.1") && refs.length) payload.reference_mode = "image";
        return { path: "/chat/completions" as const, payload };
    }

    const payload: Record<string, unknown> =
        feimiao.backend === "sora_videos"
            ? {
                  model: feimiao.upstreamModel,
                  prompt,
                  aspect_ratio: feimiao.aspectRatio,
                  resolution: feimiao.resolution,
                  seconds: String(feimiao.duration),
              }
            : {
                  model: feimiao.upstreamModel,
                  prompt,
                  ratio: feimiao.aspectRatio,
                  resolution: feimiao.resolution,
                  duration: feimiao.duration,
                  response_format: "url",
              };

    const validRefs = refs.filter((url) => typeof url === "string" && (url.startsWith("data:image/") || /^https?:\/\//i.test(url)));
    if (validRefs.length) {
        if (feimiao.backend === "sora_videos") {
            payload.image_url = validRefs[0];
            if (validRefs.length > 1) payload.images = validRefs.slice(1);
        } else {
            payload.reference_images = validRefs;
        }
    }
    return { path: "/videos" as const, payload };
}

export function suggestFeimiaoAlias(modelName: string) {
    const base = feimiaoBaseName(modelName);
    return FEIMIAO_DEFAULT_ALIASES[base] || "";
}

/**
 * 别名为空、或误存成模型 ID 本身时，视为未设置，回填默认别名。
 * 曾出现 alias=feimiao-v2-431 被当成「已手改」而永久挡住 满血-2.0-431。
 */
export function resolveStoredFeimiaoAlias(alias: string | undefined, modelName: string) {
    const base = feimiaoBaseName(modelName);
    const text = alias?.trim() || "";
    const defaultAlias = FEIMIAO_DEFAULT_ALIASES[base] || "";
    if (!text || text === base || text === modelName.trim()) return defaultAlias || undefined;
    return text;
}

/** 字字风格：去掉 480p-10s 等变体后缀，只保留基础模型名 + 显示别名 */
export function normalizeFeimiaoChannelModels(models: ChannelModel[]) {
    const kept: ChannelModel[] = [];
    const videoByBase = new Map<string, ChannelModel>();
    for (const model of models) {
        const base = feimiaoBaseName(model.name);
        const isFeimiaoVideo = Boolean(FEIMIAO_MODEL_SPECS[base]) && (model.capability === "video" || !model.capability);
        if (!isFeimiaoVideo) {
            kept.push(model);
            continue;
        }
        const alias = resolveStoredFeimiaoAlias(model.alias, base);
        const existing = videoByBase.get(base);
        if (existing) {
            const existingAlias = resolveStoredFeimiaoAlias(existing.alias, base);
            if (!existingAlias && alias) videoByBase.set(base, { ...existing, alias });
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

export function applyFeimiaoAliases(models: ChannelModel[]) {
    return normalizeFeimiaoChannelModels(models).map((model) => {
        const alias = resolveStoredFeimiaoAlias(model.alias, model.name);
        return alias ? { ...model, alias } : model;
    });
}

/** 勾选飞喵：折叠变体；别名为空时填字字默认；空地址或官方 OpenAI 默认址时改为 fmgo */
export function applyFeimiaoChannelDefaults(channel: ModelChannel): ModelChannel {
    const baseUrl = channel.baseUrl.trim();
    const useFmgoUrl = !baseUrl || /api\.openai\.com/i.test(baseUrl);
    return {
        ...channel,
        feimiao: true,
        baseUrl: useFmgoUrl ? FEIMIAO_DEFAULT_BASE_URL : baseUrl,
        models: applyFeimiaoAliases(channel.models),
    };
}

export function channelHasFeimiaoModel(config: AiConfig, modelValue: string) {
    const decoded = decodeChannelModel(modelValue);
    const channel = resolveModelChannel(config, modelValue);
    if (!isFeimiaoChannel(channel)) return false;
    if (!decoded) return true;
    return channel.models.some((model) => model.name === decoded.model || feimiaoBaseName(model.name) === decoded.model);
}

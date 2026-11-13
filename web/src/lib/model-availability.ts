import type { AiConfig, ChannelModel, ModelChannel } from "@/stores/use-config-store";

const CHANNEL_MODEL_SEPARATOR = "::";
const VARIANT_SUFFIX_RE = /-(480p|720p|1080p|4k)-\d+s$/i;

const MODEL_UNAVAILABLE_RE =
    /distributor|model.?not.?found|unknown model|invalid model|does not exist|no such model|model_not_found|model.?unavailable|not a valid model|unsupported model|无可用|模型不存在|模型不可用|模型已下线|模型失效/i;

const NOT_MODEL_FAILURE_RE =
    /string_too_long|at most\s*\d+\s*characters|content.?safety|prompt.?too.?long|rate.?limit|quota|insufficient.?quota|鉴权|api key|invalid.?token|无效的令牌|canceled|cancelled|aborted|参考图|超时|timeout|abort/i;

export function stripModelVariant(name: string) {
    return String(name || "").trim().replace(VARIANT_SUFFIX_RE, "");
}

export function namesMatchForAvailability(stored: string, query: string) {
    const left = String(stored || "").trim();
    const right = String(query || "").trim();
    if (!left || !right) return false;
    if (left === right) return true;
    return stripModelVariant(left) === stripModelVariant(right);
}

function decodeChannelModel(value: string) {
    const index = String(value || "").indexOf(CHANNEL_MODEL_SEPARATOR);
    if (index < 0) return null;
    return { channelId: value.slice(0, index), model: value.slice(index + CHANNEL_MODEL_SEPARATOR.length) };
}

function modelOptionName(value: string) {
    return decodeChannelModel(value)?.model || value;
}

function collectErrorText(value: unknown, depth = 0): string {
    if (!value || depth > 4) return "";
    if (typeof value === "string") return value;
    if (typeof value !== "object") return "";
    if (value instanceof Error) return [value.name, value.message, collectErrorText((value as Error & { cause?: unknown }).cause, depth + 1)].filter(Boolean).join(" ");
    const payload = value as {
        name?: unknown;
        message?: unknown;
        msg?: unknown;
        error?: unknown;
        detail?: unknown;
        response?: { data?: unknown };
        data?: unknown;
    };
    return [payload.name, payload.message, payload.msg, payload.error, payload.detail, payload.response?.data, payload.data]
        .map((item) => (typeof item === "string" ? item : collectErrorText(item, depth + 1)))
        .filter(Boolean)
        .join(" ");
}

export function isModelUnavailableError(error: unknown) {
    if (error && typeof error === "object" && "name" in error && (error as { name?: string }).name === "AbortError") return false;
    const text = collectErrorText(error);
    if (!text || NOT_MODEL_FAILURE_RE.test(text)) return false;
    return MODEL_UNAVAILABLE_RE.test(text);
}

function matchingChannel(config: AiConfig, modelValue: string) {
    const decoded = decodeChannelModel(modelValue);
    const name = decoded?.model || modelOptionName(modelValue);
    return decoded ? config.channels.find((channel) => channel.id === decoded.channelId) : config.channels.find((channel) => channel.models.some((model) => namesMatchForAvailability(model.name, name)));
}

export function isModelMarkedUnavailable(config: AiConfig, modelValue: string) {
    const name = modelOptionName(modelValue);
    const channel = matchingChannel(config, modelValue);
    return Boolean(channel?.models.some((model) => model.unavailable && namesMatchForAvailability(model.name, name)));
}

function withAvailability(model: ChannelModel, unavailable: boolean, reason = ""): ChannelModel {
    if (!unavailable) {
        const next = { ...model };
        delete next.unavailable;
        delete next.unavailableReason;
        return next;
    }
    return { ...model, unavailable: true, ...(reason ? { unavailableReason: reason.slice(0, 180) } : {}) };
}

export function applyModelAvailability(config: AiConfig, modelValue: string, unavailable: boolean, reason = ""): AiConfig {
    const decoded = decodeChannelModel(modelValue);
    const name = decoded?.model || modelOptionName(modelValue);
    const channelId = decoded?.channelId;
    let changed = false;
    const channels = config.channels.map((channel) => {
        if (channelId && channel.id !== channelId) return channel;
        let matched = false;
        const models = channel.models.map((model) => {
            if (!namesMatchForAvailability(model.name, name)) return model;
            matched = true;
            const next = withAvailability(model, unavailable, reason);
            if (next.unavailable !== model.unavailable || next.unavailableReason !== model.unavailableReason) changed = true;
            return next;
        });
        if (!matched) return channel;
        return { ...channel, models };
    });
    return changed ? { ...config, channels } : config;
}

export function applyCatalogPresence(channel: ModelChannel, liveNames: string[]): ModelChannel {
    if (!liveNames.length) return channel;
    const live = new Set(liveNames);
    const liveBases = new Set(liveNames.map(stripModelVariant));
    let changed = false;
    const models = channel.models.map((model) => {
        const present = live.has(model.name) || liveBases.has(stripModelVariant(model.name));
        if (present) return model;
        changed = true;
        return withAvailability(model, true, "接口目录中已不存在");
    });
    return changed ? { ...channel, models } : channel;
}

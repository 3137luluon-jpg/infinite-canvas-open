import { applyCatalogPresence, applyModelAvailability, isModelUnavailableError } from "@/lib/model-availability";
import { useConfigStore } from "@/stores/use-config-store";

function errorReason(error: unknown) {
    if (!error) return "";
    if (error instanceof Error) return error.message.slice(0, 180);
    return String(error).slice(0, 180);
}

export function recordModelApiResult(modelValue: string, error?: unknown) {
    if (!modelValue.trim()) return;
    if (error && !isModelUnavailableError(error)) return;
    const unavailable = Boolean(error);
    const { config, updateConfig } = useConfigStore.getState();
    const next = applyModelAvailability(config, modelValue, unavailable, unavailable ? errorReason(error) : "");
    if (next.channels === config.channels) return;
    updateConfig("channels", next.channels);
}

export function recordCatalogPresence(channelId: string, liveNames: string[]) {
    if (!channelId || !liveNames.length) return;
    const { config, updateConfig } = useConfigStore.getState();
    const channels = config.channels.map((channel) => (channel.id === channelId ? applyCatalogPresence(channel, liveNames) : channel));
    if (channels.every((channel, index) => channel === config.channels[index])) return;
    updateConfig("channels", channels);
}

export async function withModelAvailability<T>(modelValue: string, run: () => Promise<T>): Promise<T> {
    try {
        const result = await run();
        recordModelApiResult(modelValue);
        return result;
    } catch (error) {
        recordModelApiResult(modelValue, error);
        throw error;
    }
}

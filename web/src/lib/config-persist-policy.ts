/**
 * 渠道配置恢复策略：空默认不能盖掉带 Key 的配置，
 * 但用户主动删渠道后，不能因为「渠道变少、分量变轻」被保险库救回。
 */

const SOURCE_ORDER: Record<string, number> = { main: 0, backup: 1, vault: 2, legacy: 3, none: 4 };

type PersistChannel = {
    id?: string;
    apiKey?: string;
    feimiao?: boolean;
    baseUrl?: string;
    models?: unknown[];
};

type PersistEnvelope = {
    persistedAt?: number;
    state?: { config?: { channels?: PersistChannel[] }; webdav?: { url?: string } };
    config?: { channels?: PersistChannel[] };
    webdav?: { url?: string };
};

export type ConfigPersistSource = "main" | "backup" | "vault" | "legacy" | "none";

export type ConfigPersistCandidate = {
    raw: string | null;
    from: ConfigPersistSource;
    weight: number;
};

function parseEnvelope(raw: string | null): PersistEnvelope | null {
    if (!raw) return null;
    try {
        return JSON.parse(raw) as PersistEnvelope;
    } catch {
        return null;
    }
}

function persistChannels(parsed: PersistEnvelope | null): PersistChannel[] {
    const channels = parsed?.state?.config?.channels || parsed?.config?.channels;
    return Array.isArray(channels) ? channels : [];
}

export function configPersistTime(raw: string | null): number {
    const parsed = parseEnvelope(raw);
    return typeof parsed?.persistedAt === "number" && Number.isFinite(parsed.persistedAt) ? parsed.persistedAt : 0;
}

export function stampConfigPersistTime(raw: string, at = Date.now()): string {
    const parsed = parseEnvelope(raw);
    if (!parsed) return raw;
    return JSON.stringify({ ...parsed, persistedAt: at });
}

export function configPersistHasApiKey(raw: string | null): boolean {
    return persistChannels(parseEnvelope(raw)).some((channel) => Boolean(channel.apiKey?.trim()));
}

export function configPersistLooksFactoryDefault(raw: string | null): boolean {
    if (configPersistHasApiKey(raw)) return false;
    const parsed = parseEnvelope(raw);
    const channels = persistChannels(parsed);
    if (!channels.length) return true;
    return channels.every((channel) => !channel.id);
}

/** 配置「分量」：渠道数、模型数、API Key、飞喵、自定义地址 */
export function configPersistWeight(raw: string | null): number {
    if (!raw) return 0;
    const parsed = parseEnvelope(raw);
    if (!parsed) return 0;
    const channels = persistChannels(parsed);
    if (!channels.length) return 0;
    const webdav = parsed.state?.webdav || parsed.webdav;
    let weight = channels.length * 1000;
    for (const channel of channels) {
        weight += Array.isArray(channel.models) ? channel.models.length : 0;
        if (channel.apiKey?.trim()) weight += 800;
        if (channel.feimiao) weight += 200;
        const base = (channel.baseUrl || "").toLowerCase();
        if (base && !base.includes("api.openai.com") && !base.includes("generativelanguage.googleapis.com")) weight += 400;
    }
    if (webdav?.url?.trim()) weight += 150;
    return weight;
}

function isPresent(candidate: ConfigPersistCandidate): candidate is ConfigPersistCandidate & { raw: string } {
    return Boolean(candidate.raw) && candidate.weight > 0;
}

/** 在带 Key 的真实配置之间，新快照优先于「渠道更多」的旧保险库。 */
export function selectConfigPersistCandidate(candidates: ConfigPersistCandidate[]): ConfigPersistCandidate {
    const present = candidates.filter(isPresent);
    if (!present.length) return { raw: null, from: "none", weight: 0 };

    const withKeys = present.filter((candidate) => configPersistHasApiKey(candidate.raw));
    const nonFactory = present.filter((candidate) => !configPersistLooksFactoryDefault(candidate.raw));
    const pool = withKeys.length ? withKeys : nonFactory.length ? nonFactory : present;

    return [...pool].sort((left, right) => {
        const timeDelta = configPersistTime(right.raw) - configPersistTime(left.raw);
        if (timeDelta) return timeDelta;
        return (SOURCE_ORDER[left.from] ?? 9) - (SOURCE_ORDER[right.from] ?? 9);
    })[0];
}

export function pickNewerPersistRaw(left: string | null, right: string | null): string | null {
    const selected = selectConfigPersistCandidate([
        { raw: left, from: "main", weight: configPersistWeight(left) },
        { raw: right, from: "backup", weight: configPersistWeight(right) },
    ]);
    return selected.raw;
}

export function shouldBlockConfigPersistWrite(nextRaw: string, vaultRaw: string | null): "empty" | "factory" | null {
    const nextWeight = configPersistWeight(nextRaw);
    const vaultWeight = configPersistWeight(vaultRaw);
    const vaultHasKey = configPersistHasApiKey(vaultRaw);
    if (nextWeight === 0 && vaultWeight > 0) return "empty";
    if (configPersistLooksFactoryDefault(nextRaw) && !configPersistHasApiKey(nextRaw) && vaultHasKey) return "factory";
    return null;
}

export function shouldUpdateConfigPersistVault(nextRaw: string, vaultRaw: string | null): boolean {
    if (shouldBlockConfigPersistWrite(nextRaw, vaultRaw)) return false;
    if (configPersistHasApiKey(nextRaw)) return true;
    if (!configPersistHasApiKey(vaultRaw)) return true;
    return configPersistWeight(nextRaw) >= configPersistWeight(vaultRaw);
}

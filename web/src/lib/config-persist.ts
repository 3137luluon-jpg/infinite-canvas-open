/**
 * 配置安全持久化：localStorage + IndexedDB 双写，主存/备份/保险库。
 * 禁止用「空默认渠道」覆盖带 API Key 的真实配置。
 * 用户主动删除渠道后，不得因渠道变少被更「满」的保险库救回。
 */
import { localForageStorage } from "@/lib/localforage-storage";
import type { StateStorage } from "zustand/middleware";
import {
    configPersistHasApiKey,
    configPersistWeight,
    pickNewerPersistRaw,
    selectConfigPersistCandidate,
    shouldBlockConfigPersistWrite,
    shouldUpdateConfigPersistVault,
    stampConfigPersistTime,
} from "@/lib/config-persist-policy";

export { configPersistHasApiKey, configPersistWeight } from "@/lib/config-persist-policy";

export const CONFIG_STORE_KEY = "infinite-canvas:ai_config_store";

function backupKey(key: string) {
    return `${key}__backup`;
}
function vaultKey(key: string) {
    return `${key}__vault`;
}
function pendingKey(key: string) {
    return `${key}__pending`;
}

export type ConfigPersistRecovery = {
    recovered: boolean;
    from: "main" | "backup" | "vault" | "legacy" | "none";
    message?: string;
};

let lastRecovery: ConfigPersistRecovery = { recovered: false, from: "none" };

export function getConfigPersistRecovery() {
    return lastRecovery;
}

export function clearConfigPersistRecovery() {
    lastRecovery = { recovered: false, from: "none" };
}

async function readLocalStorage(key: string) {
    if (typeof window === "undefined") return null;
    try {
        return window.localStorage.getItem(key);
    } catch {
        return null;
    }
}

async function writeLocalStorage(key: string, value: string) {
    if (typeof window === "undefined") return;
    try {
        window.localStorage.setItem(key, value);
    } catch (error) {
        console.error("[config-persist] localStorage write failed", key, error);
    }
}

async function readForage(key: string) {
    try {
        return (await localForageStorage.getItem(key)) || null;
    } catch {
        return null;
    }
}

async function writeForage(key: string, value: string) {
    try {
        await localForageStorage.setItem(key, value);
        const verify = await readForage(key);
        if (verify !== value) throw new Error(`verify failed: ${key}`);
    } catch (error) {
        console.error("[config-persist] localforage write failed", key, error);
        throw error;
    }
}

async function readCandidate(key: string) {
    const [ls, idb] = await Promise.all([readLocalStorage(key), readForage(key)]);
    return pickNewerPersistRaw(ls, idb) || ls || idb;
}

async function chooseBest(): Promise<{ raw: string | null; from: ConfigPersistRecovery["from"] }> {
    const main = await readCandidate(CONFIG_STORE_KEY);
    const backup = await readCandidate(backupKey(CONFIG_STORE_KEY));
    const vault = await readCandidate(vaultKey(CONFIG_STORE_KEY));
    // 兼容旧版仅 localStorage、以及误写到带 state 包裹的情况已在 weight 里处理
    const legacyKeys = ["infinite-canvas:ai_config_store", "ai_config_store"];
    let legacy: string | null = null;
    for (const key of legacyKeys) {
        if (key === CONFIG_STORE_KEY) continue;
        const value = await readLocalStorage(key);
        if (configPersistWeight(value) > configPersistWeight(legacy)) legacy = value;
    }

    const best = selectConfigPersistCandidate([
        { raw: main, from: "main", weight: configPersistWeight(main) },
        { raw: backup, from: "backup", weight: configPersistWeight(backup) },
        { raw: vault, from: "vault", weight: configPersistWeight(vault) },
        { raw: legacy, from: "legacy", weight: configPersistWeight(legacy) },
    ]);
    if (!best.raw || best.weight <= 0) return { raw: null, from: "none" };
    return { raw: best.raw, from: best.from };
}

async function commit(raw: string) {
    const stamped = stampConfigPersistTime(raw);
    const vault = await readCandidate(vaultKey(CONFIG_STORE_KEY));
    const block = shouldBlockConfigPersistWrite(stamped, vault);

    if (block === "empty") {
        console.warn("[config-persist] blocked empty config overwrite");
        return;
    }
    if (block === "factory") {
        console.warn(`[config-persist] blocked factory default overwrite (vault still has API keys)`);
        await writeLocalStorage(pendingKey(CONFIG_STORE_KEY), stamped);
        return;
    }

    await writeLocalStorage(pendingKey(CONFIG_STORE_KEY), stamped);
    await writeLocalStorage(CONFIG_STORE_KEY, stamped);
    await writeLocalStorage(backupKey(CONFIG_STORE_KEY), stamped);
    try {
        await writeForage(pendingKey(CONFIG_STORE_KEY), stamped);
        await writeForage(CONFIG_STORE_KEY, stamped);
        await writeForage(backupKey(CONFIG_STORE_KEY), stamped);
    } catch {
        /* localStorage 已落下，IndexedDB 失败不阻断 */
    }

    if (shouldUpdateConfigPersistVault(stamped, vault)) {
        await writeLocalStorage(vaultKey(CONFIG_STORE_KEY), stamped);
        try {
            await writeForage(vaultKey(CONFIG_STORE_KEY), stamped);
        } catch {
            /* ignore */
        }
    }
}

/** 启动时尽量捞回更完整的配置快照（供手动调试） */
export async function inspectConfigPersistCandidates() {
    const keys = [CONFIG_STORE_KEY, backupKey(CONFIG_STORE_KEY), vaultKey(CONFIG_STORE_KEY), pendingKey(CONFIG_STORE_KEY)];
    const rows = [];
    for (const key of keys) {
        const ls = await readLocalStorage(key);
        const idb = await readForage(key);
        rows.push({ key, localStorageWeight: configPersistWeight(ls), idbWeight: configPersistWeight(idb), localStorageBytes: ls?.length || 0, idbBytes: idb?.length || 0 });
    }
    return rows;
}

export const configPersistStorage: StateStorage = {
    getItem: async (_name) => {
        const best = await chooseBest();
        if (best.raw && best.from !== "main") {
            lastRecovery = {
                recovered: true,
                from: best.from,
                message: `已从${best.from === "vault" ? "保险库" : best.from === "backup" ? "备份" : "旧存档"}恢复渠道配置，数据未丢失`,
            };
            try {
                await commit(best.raw);
            } catch {
                /* 展示优先 */
            }
        } else {
            lastRecovery = { recovered: false, from: best.from };
        }
        return best.raw;
    },
    setItem: async (_name, value) => {
        await commit(value);
    },
    removeItem: async (_name) => {
        const keys = [CONFIG_STORE_KEY, backupKey(CONFIG_STORE_KEY), pendingKey(CONFIG_STORE_KEY)];
        for (const key of keys) {
            try {
                window.localStorage.removeItem(key);
            } catch {
                /* ignore */
            }
            try {
                await localForageStorage.removeItem(key);
            } catch {
                /* ignore */
            }
        }
        // 故意保留 vault，防止误删后无可恢复
    },
};

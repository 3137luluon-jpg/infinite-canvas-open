/**
 * 安全 JSON 持久化（IndexedDB / localforage）
 * - 主存 + 备份双写 + 保险库（只保留更「满」的快照）
 * - 禁止用空数据覆盖非空数据（除非显式允许空写）
 * - 写后回读校验
 * - 启动时若主存损坏/为空，自动从备份或保险库恢复
 */
import type { StateStorage } from "zustand/middleware";

import { localForageStorage } from "./localforage-storage.ts";
import { clearPersistError, reportPersistError } from "./persist-health.ts";

export type SafePersistRecovery = {
    recovered: boolean;
    from: "main" | "backup" | "vault" | "none";
    message?: string;
};

type WeightFn = (raw: string | null) => number;

type SafeJsonPersistOptions = {
    key: string;
    weightOf: WeightFn;
    debounceMs?: number;
    storage?: StateStorage;
    onProgress?: (event: { stage: string; at: number; chars?: number }) => void;
};

const recoveryByKey = new Map<string, SafePersistRecovery>();

export function getSafePersistRecovery(key: string): SafePersistRecovery | undefined {
    return recoveryByKey.get(key);
}

export function clearSafePersistRecovery(key: string) {
    recoveryByKey.delete(key);
}

function backupKey(key: string) {
    return `${key}__backup`;
}

function vaultKey(key: string) {
    return `${key}__vault`;
}

function pendingKey(key: string) {
    return `${key}__pending`;
}

async function readRaw(key: string, storage: StateStorage) {
    try {
        return (await storage.getItem(key)) || null;
    } catch (error) {
        reportPersistError(key, error);
        throw error;
    }
}

async function writeRaw(key: string, value: string, storage: StateStorage) {
    await storage.setItem(key, value);
    const verify = await readRaw(key, storage);
    if (verify !== value) throw new Error(`persist verify failed: ${key}`);
}

export function createSafeJsonPersistStorage(options: SafeJsonPersistOptions) {
    const { key, weightOf, debounceMs = 300, storage: persistenceStorage = localForageStorage } = options;
    const progress = (stage: string, chars?: number) => { try { options.onProgress?.({stage, at: Date.now(), ...(chars === undefined ? {} : {chars})}); } catch { /* diagnostic only */ } };
    const writeVerified = async (name: string, raw: string, stage: string) => {
        progress(stage + ":write", raw.length);
        await persistenceStorage.setItem(name, raw);
        progress(stage + ":verify", raw.length);
        const verified = await readRaw(name, persistenceStorage);
        if (verified !== raw) throw new Error(`persist verify failed: ${name}`);
        progress(stage + ":complete", raw.length);
    };
    let ready = false;
    let allowEmptyOnce = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Keep the latest immutable state by reference until debounce/flush. Large
    // media-bearing libraries must not be stringified on every pointer event.
    let queued: string | (() => string) | null = null;
    let writing: Promise<void> | null = null;
    let revision = 0, savedRevision = 0;
    const barriers = new Set<{ revision: number; resolve: () => void; reject: (error: unknown) => void }>();
    // A caller waits for its own durable revision, not future unrelated edits.
    const settleBarriers = (error?: unknown) => {
        for (const barrier of barriers) {
            if (error !== undefined || barrier.revision <= savedRevision) {
                barriers.delete(barrier);
                if (error !== undefined) barrier.reject(error); else barrier.resolve();
            }
        }
    };

    let lastGoodWeight = 0;

    const markReady = () => {
        ready = true;
    };

    const allowNextEmptyWrite = () => {
        allowEmptyOnce = true;
    };

    const chooseBest = async (): Promise<{ raw: string | null; from: "main" | "backup" | "vault" | "none" }> => {
        const main = await readRaw(key, persistenceStorage);
        const backup = await readRaw(backupKey(key), persistenceStorage);
        const mainW = weightOf(main);
        const backupW = weightOf(backup);

        // 主存有内容且不弱于备份时优先主存
        if (mainW > 0 && mainW >= backupW) return { raw: main, from: "main" };
        const vault = await readRaw(vaultKey(key), persistenceStorage);
        const vaultW = weightOf(vault);
        if (backupW > 0 && backupW >= vaultW) return { raw: backup, from: "backup" };
        if (vaultW > 0) return { raw: vault, from: "vault" };
        if (mainW > 0) return { raw: main, from: "main" };
        if (main && main === backup) return { raw: main, from: "main" };
        if (backup) return { raw: backup, from: "backup" };
        if (main) return { raw: main, from: "main" };
        return { raw: null, from: "none" };
    };

    const commit = async (raw: string) => {
        progress("weight", raw.length);
        const nextWeight = weightOf(raw);
        if (nextWeight === 0 && lastGoodWeight > 0 && !allowEmptyOnce) {
            throw new Error("已阻止空数据覆盖历史存档，请先备份当前页面");
        }
        const forceEmpty = allowEmptyOnce && nextWeight === 0;
        allowEmptyOnce = false;

        await writeVerified(pendingKey(key), raw, "pending");
        await writeVerified(key, raw, "main");
        await writeVerified(backupKey(key), raw, "backup");

        // 保险库：只在「更满」或用户明确清空时更新，防止误空写后无可恢复
        progress("vault:read", raw.length);
        const vault = await readRaw(vaultKey(key), persistenceStorage);
        const vaultW = weightOf(vault);
        if (forceEmpty || nextWeight >= vaultW) {
            await writeVerified(vaultKey(key), raw, "vault");
        }

        try {
            await persistenceStorage.removeItem(pendingKey(key));
        } catch {
            /* ignore */
        }
        lastGoodWeight = nextWeight;
        progress("commit:complete", raw.length);
        clearPersistError(key);
    };

    const flush = (): Promise<void> => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        // All callers join one writer. Edits arriving during disk IO replace
        // only the pending snapshot instead of retaining a chain of big JSONs.
        if (writing) return writing;
        if (queued === null) return Promise.resolve();
        let resolveWrite!: () => void;
        let rejectWrite!: (error: unknown) => void;
        const result = new Promise<void>((resolve, reject) => { resolveWrite = resolve; rejectWrite = reject; });
        writing = result;
        void (async () => {
            try {
                while (queued !== null) {
                    const payload = queued;
                    const savingRevision = revision;
                    queued = null;
                    try {
                        await commit(typeof payload === "function" ? payload() : payload);
                        savedRevision = savingRevision;
                        settleBarriers();
                    } catch (error) {
                        settleBarriers(error);
                        console.error(`[safe-persist] write failed for ${key}`, error);
                        if (queued === null) queued = payload;
                        reportPersistError(key, error);
                        throw error;
                    }
                }
            } finally {
                // Clear synchronously with the empty-queue check. A .finally()
                // microtask would let a new flush join an already drained run.
                writing = null;
            }
        })().then(resolveWrite, rejectWrite);
        return result;
    };

    const flushSnapshot = (): Promise<void> => {
        if (!ready) return Promise.reject(new Error("画布存储尚未完成水合，未提交生成"));
        if (savedRevision >= revision) return Promise.resolve();
        const promise = new Promise<void>((resolve, reject) => barriers.add({ revision, resolve, reject }));
        void flush().catch(() => undefined);
        return promise;
    };

    const enqueue = (raw: string | (() => string)) => {
        if (!ready) return;
        queued = raw;
        revision++;
        if (debounceMs <= 0) {
            void flush().catch(() => undefined);
            return;
        }
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
            timer = null;
            void flush().catch(() => undefined);
        }, debounceMs);
    };

    if (typeof window !== "undefined") {
        const onHide = () => {
            void flush().catch(() => undefined);
        };
        window.addEventListener("beforeunload", onHide);
        window.addEventListener("pagehide", onHide);
        document.addEventListener("visibilitychange", () => {
            if (document.visibilityState === "hidden") onHide();
        });
        // 周期性落盘，防止长时间编辑后异常退出
        window.setInterval(() => {
            void flush().catch(() => undefined);
        }, 5000);
    }

    return {
        markReady,
        allowNextEmptyWrite,
        enqueueSnapshot: (serialize: () => string) => enqueue(serialize),
        flush,
        flushSnapshot,
        getLastRecovery: () => recoveryByKey.get(key),
        storage: {
            getItem: async (_name: string) => {
                const best = await chooseBest();
                if ((best.from === "backup" || best.from === "vault") && best.raw) {
                    const label = best.from === "vault" ? "保险库" : "备份";
                    recoveryByKey.set(key, {
                        recovered: true,
                        from: best.from,
                        message: `已从${label}恢复画布存档（主存档异常或为空，数据未丢失）`,
                    });
                    try {
                        await writeRaw(key, best.raw, persistenceStorage);
                        await writeRaw(backupKey(key), best.raw, persistenceStorage);
                    } catch {
                        /* 展示优先 */
                    }
                } else {
                    recoveryByKey.set(key, { recovered: false, from: best.from });
                }
                if (best.raw) lastGoodWeight = weightOf(best.raw);
                markReady();
                return best.raw;
            },
            setItem: async (_name: string, value: string) => {
                enqueue(value);
            },
            removeItem: async (_name: string) => {
                allowEmptyOnce = true;
                await persistenceStorage.removeItem(key);
                await persistenceStorage.removeItem(backupKey(key));
                await persistenceStorage.removeItem(pendingKey(key));
                // 故意不删 vault，除非业务层明确允许空写并再写空
                lastGoodWeight = 0;
            },
        },
    };
}

/** 画布权重：项目数 + 节点数 */
export function canvasPersistWeight(raw: string | null): number {
    if (!raw) return 0;
    try {
        const parsed = JSON.parse(raw) as { state?: { projects?: Array<{ nodes?: unknown[] }> } };
        const projects = parsed?.state?.projects;
        if (!Array.isArray(projects)) return 0;
        const nodeCount = projects.reduce((sum, project) => sum + (Array.isArray(project?.nodes) ? project.nodes.length : 0), 0);
        return projects.length * 1000 + nodeCount;
    } catch {
        return 0;
    }
}

export function assetPersistWeight(raw: string | null): number {
    if (!raw) return 0;
    try {
        const parsed = JSON.parse(raw) as { state?: { assets?: unknown[] } };
        const assets = parsed?.state?.assets;
        return Array.isArray(assets) ? assets.length : 0;
    } catch {
        return 0;
    }
}

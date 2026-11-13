import { canvasInteractionActive } from "./canvas-interaction";
import { clearPersistError, reportPersistError } from "../persist-health";
import type { createSafeJsonPersistStorage, SafePersistRecovery } from "../safe-json-persist";

export type CanvasPersistPayload = { snapshot: unknown } | { raw: string };
export type CanvasPersistRequest = { id: number; op: "load" | "save" | "allow-empty" | "remove"; payload?: CanvasPersistPayload };
export type CanvasPersistReply = { id: number; ok: boolean; raw?: Blob | null; recovery?: SafePersistRecovery; error?: string; progress?: {stage:string; at:number; chars?:number} };

/** Only the latest immutable snapshot crosses to the writer; disk strings stay off the UI thread. */
export function createCanvasWorkerPersist({ key, worker, fallback, debounceMs = 250 }: { key: string; worker: Worker; fallback?: ReturnType<typeof createSafeJsonPersistStorage>; debounceMs?: number }) {
    let useFallback = false;
    let ready = false;
    let loaded = false;
    let queued: CanvasPersistPayload | null = null;
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

    let timer: ReturnType<typeof setTimeout> | null = null;
    let recovery: SafePersistRecovery | undefined;
    let sequence = 0;
    let workerError: Error | null = null;
    const progressHistory: Array<{id:number; stage:string; at:number; chars?:number}> = [];
    const pendingSince = new Map<number, {op:string; at:number}>();
    const requests = new Map<number, { resolve: (reply: CanvasPersistReply) => void; reject: (error: Error) => void }>();
    worker.addEventListener("message", (event: MessageEvent<CanvasPersistReply>) => {
        const reply = event.data, request = requests.get(reply.id);
        if (!request) return;
        if (reply.progress) { progressHistory.push({id:reply.id,...reply.progress}); if(progressHistory.length>40)progressHistory.shift(); return; }
        requests.delete(reply.id);
        pendingSince.delete(reply.id);
        if (reply.ok) request.resolve(reply);
        else request.reject(new Error(reply.error || "画布后台保存失败"));
    });
    worker.addEventListener("error", () => {
        workerError = new Error("画布后台保存进程异常，请保留页面并导出备份");
        reportPersistError(key, workerError);
        for (const request of requests.values()) request.reject(workerError);
        requests.clear();
        pendingSince.clear();
    });
    const request = (op: CanvasPersistRequest["op"], payload?: CanvasPersistPayload) => new Promise<CanvasPersistReply>((resolve, reject) => {
        if (workerError) { reject(workerError); return; }
        const id = ++sequence;
        pendingSince.set(id,{op,at:Date.now()});
        requests.set(id, { resolve, reject });
        try { worker.postMessage({ id, op, payload } satisfies CanvasPersistRequest); }
        catch (error) { requests.delete(id); pendingSince.delete(id); reject(error); }
    });
    const flush = (): Promise<void> => {
        if (useFallback && fallback) return fallback.flush();
        if (timer) { clearTimeout(timer); timer = null; }
        if (writing) return writing;
        if (!queued || !ready) return Promise.resolve();
        // Assign before running: synchronous callers must join the same drain.
        let resolve!: () => void, reject!: (error: unknown) => void;
        const result = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
        writing = result;
        void (async () => {
            try {
                while (queued) {
                    const payload = queued;
                    const savingRevision = revision;
                    queued = null;
                    try { await request("save", payload); savedRevision = savingRevision; settleBarriers(); clearPersistError(key); }
                    catch (error) {
                        if (!queued) queued = payload;
                        settleBarriers(error);
                        reportPersistError(key, error);
                        throw error;
                    }
                }
            } finally { writing = null; }
        })().then(resolve, reject);
        return result;
    };
    const flushSnapshot = (): Promise<void> => {
        if (useFallback && fallback) return fallback.flushSnapshot();
        if (!ready) return Promise.reject(new Error("画布存储尚未完成水合，未提交生成"));
        if (savedRevision >= revision) return Promise.resolve();
        const promise = new Promise<void>((resolve, reject) => barriers.add({ revision, resolve, reject }));
        void flush().catch(() => undefined);
        return promise;
    };

    const autoFlush = () => {
        timer = null;
        if (!queued) return;
        if (canvasInteractionActive()) { timer = setTimeout(autoFlush, debounceMs); return; }
        void flush().catch(() => undefined);
    };
    const enqueue = (payload: CanvasPersistPayload) => {
        if (!ready) return;
        queued = payload;
        revision++;
        if (timer) clearTimeout(timer);
        timer = setTimeout(autoFlush, debounceMs);
    };
    if (typeof window !== "undefined") {
        const onHide = () => { void flush().catch(() => undefined); };
        window.addEventListener("pagehide", onHide);
        window.addEventListener("beforeunload", onHide);
        document.addEventListener("visibilitychange", () => { if (document.hidden) onHide(); });
        window.setInterval(() => { if (!canvasInteractionActive()) void flush().catch(() => undefined); }, 5000);
    }
    return {
        markReady: () => { if (useFallback) fallback?.markReady(); else if (loaded) ready = true; },
        allowNextEmptyWrite: () => { if (useFallback) fallback?.allowNextEmptyWrite(); else void request("allow-empty").catch(error => reportPersistError(key, error)); },
        enqueueState: (snapshot: unknown) => { if (useFallback) fallback?.enqueueSnapshot(() => JSON.stringify(snapshot)); else enqueue({ snapshot }); },
        flush,
        flushSnapshot,
        getLastRecovery: () => useFallback ? fallback?.getLastRecovery() : recovery,
        getDiagnostics: () => ({transport:useFallback?"fallback":"worker",ready,loaded,revision,savedRevision,queued:!!queued,writing:!!writing,barriers:barriers.size,requests:[...pendingSince].map(([id,data])=>({id,...data})),progress:progressHistory.slice(),error:workerError?.message}),
        storage: {
            getItem: async (_name: string) => {
                if (useFallback && fallback) return fallback.storage.getItem(_name);
                try {
                    const reply = await request("load");
                    const raw = reply.raw ? await reply.raw.text() : null;
                    recovery = reply.recovery;
                    loaded = ready = true;
                    return raw;
                } catch (error) {
                    // Switch only before hydration: never race two writers after edits begin.
                    if (!loaded && fallback) {
                        const raw = await fallback.storage.getItem(_name);
                        useFallback = true;
                        clearPersistError(key);
                        return raw;
                    }
                    reportPersistError(key, error); throw error;
                }
            },
            setItem: async (_name: string, raw: string) => { if (useFallback && fallback) await fallback.storage.setItem(_name, raw); else enqueue({ raw }); },
            removeItem: async (_name: string) => { if (useFallback && fallback) return fallback.storage.removeItem(_name); queued = null; if (timer) clearTimeout(timer); await request("remove"); },
        },
    };
}

import type { CanvasAgentSnapshot } from "./canvas-agent-ops";

let worker: Worker | null = null;
let sequence = 0;
const pending = new Map<number, { resolve: (ok: boolean | null) => void; timer: ReturnType<typeof setTimeout> }>();
function failed() {
    worker?.terminate();
    worker = null;
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.resolve(null); }
    pending.clear();
}

/** Null means worker setup failed; the caller can use its existing request path. */
export function postCanvasStateInWorker(endpoint: string, token: string, clientId: string, snapshot: CanvasAgentSnapshot | null): Promise<boolean | null> {
    try {
        if (!worker) {
            worker = new Worker(new URL("./canvas-state-post.worker.ts", import.meta.url), { type: "module" });
            worker.addEventListener("message", ({ data }: MessageEvent<{ id: number; ok: boolean }>) => {
                const entry = pending.get(data.id);
                if (!entry) return;
                pending.delete(data.id); clearTimeout(entry.timer); entry.resolve(data.ok);
            });
            const currentWorker = worker;
            worker.addEventListener("error", () => { if (worker === currentWorker) failed(); });
        }
        return new Promise(resolve => {
            const id = ++sequence;
            pending.set(id, { resolve, timer: setTimeout(() => { if (pending.has(id)) failed(); }, 20000) });
            try { worker!.postMessage({ id, endpoint, token, clientId, snapshot }); }
            catch { failed(); }
        });
    } catch { failed(); return Promise.resolve(null); }
}

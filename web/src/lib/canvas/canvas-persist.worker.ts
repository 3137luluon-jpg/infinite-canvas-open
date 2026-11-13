import localforage from "localforage";
import { canvasPersistWeight, createSafeJsonPersistStorage } from "../safe-json-persist";
import type { CanvasPersistReply, CanvasPersistRequest } from "./canvas-worker-persist";

const storage = localforage.createInstance({ name: "infinite-canvas", storeName: "app_state" });
let activeRequestId = 0;
const persist = createSafeJsonPersistStorage({
    key: "infinite-canvas:canvas_store",
    weightOf: canvasPersistWeight,
    debounceMs: 0,
    onProgress: progress => scope.postMessage({id: activeRequestId, ok:true, progress}),
    storage: {
        getItem: async key => (await storage.getItem<string>(key)) || null,
        setItem: async (key, raw) => { await storage.setItem(key, raw); },
        removeItem: async key => { await storage.removeItem(key); },
    },
});
const scope = self as unknown as { onmessage: ((event: MessageEvent<CanvasPersistRequest>) => void) | null; postMessage: (reply: CanvasPersistReply) => void };
scope.onmessage = event => {
    const { id, op, payload } = event.data;
    activeRequestId = id;
    scope.postMessage({id,ok:true,progress:{stage:"received:" + op,at:Date.now()}});
    void (async () => {
        if (op === "load") {
            const raw = await persist.storage.getItem("");
            // A Blob is cloned by reference; a 97 MB reply must not be copied as a giant message string.
            scope.postMessage({ id, ok: true, raw: raw ? new Blob([raw], { type: "application/json" }) : null, recovery: persist.getLastRecovery() });
            return;
        }
        if (op === "allow-empty") persist.allowNextEmptyWrite();
        else if (op === "remove") await persist.storage.removeItem("");
        else if (payload) {
            scope.postMessage({id, ok:true, progress:{stage:"serialize", at:Date.now()}});
            persist.enqueueSnapshot(() => "raw" in payload ? payload.raw : JSON.stringify(payload.snapshot));
            await persist.flush();
        }
        scope.postMessage({ id, ok: true });
    })().catch(error => scope.postMessage({ id, ok: false, error: error instanceof Error ? error.message : String(error) }));
};

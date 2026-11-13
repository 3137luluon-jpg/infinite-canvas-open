import axios from "axios";

export type ZealmanRecoveryReceipt = { submittedAt?: number; workflowId?: string; inputSnapshot?: Record<string, unknown> };
export type ZealmanOutputFile = { path: string; size: number; creationDate?: string; modificationDate?: string };
type IndexedOutput = { file: ZealmanOutputFile; url: string; graph: unknown };
const indexes = new Map<string, { expires: number; value: Promise<IndexedOutput[]> }>();

export function matchesZealmanSnapshot(graph: unknown, snapshot: Record<string, unknown> | undefined) {
    if (!graph || typeof graph !== "object" || !snapshot) return false;
    const values = Object.entries(snapshot).filter(([, value]) => ["string", "number", "boolean"].includes(typeof value) && !(typeof value === "string" && value.startsWith("[已上传")));
    // A prompt alone cannot distinguish a previous attempt of the same shot.
    if (!values.some(([key, value]) => /:seed$/.test(key) && typeof value === "number") || !values.some(([, value]) => typeof value === "string" && value.length > 200)) return false;
    return values.every(([key, expected]) => {
        const colon = key.indexOf(":");
        if (colon < 1) return false;
        const node = (graph as Record<string, { inputs?: Record<string, unknown> }>)[key.slice(0, colon)];
        const actual = node?.inputs?.[key.slice(colon + 1)];
        return typeof expected === "string" && typeof actual === "string" ? actual.replace(/\r\n/g, "\n") === expected.replace(/\r\n/g, "\n") : actual === expected;
    });
}

export function zealmanRecoveryCandidates(files: ZealmanOutputFile[], submittedAt: number) {
    const eligible = files.filter(file => {
        const stamp = Date.parse(file.creationDate || file.modificationDate || "");
        return typeof file.path === "string" && !file.path.split(/[\\/]/).includes("..") && !/^(?:[a-z]+:|[/\\])/i.test(file.path) && /\.mp4$/i.test(file.path) && Number.isSafeInteger(file.size) && file.size > 0 && file.size < 512 * 1024 * 1024 && Number.isFinite(stamp) && stamp >= submittedAt - 60_000 && stamp <= submittedAt + 6 * 3600_000;
    });
    const paths = new Set(eligible.map(file => file.path));
    // VHS writes a silent intermediate and an audio-muxed final with the same graph.
    return eligible.filter(file => /-audio\.mp4$/i.test(file.path) || !paths.has(file.path.replace(/\.mp4$/i, "-audio.mp4")));
}

export function uniqueZealmanOutput(outputs: IndexedOutput[], receipt: ZealmanRecoveryReceipt) {
    const found = outputs.filter(output => matchesZealmanSnapshot(output.graph, receipt.inputSnapshot));
    if (found.length > 1) throw new Error("云端找到多个参数完全相同的成片，已停止自动绑定，请人工核对版本；未重新生成。");
    return found[0];
}

async function readOutputGraph(file: ZealmanOutputFile, url: string, headers?: Record<string, string>) {
    const { Input, CustomSource, MP4 } = await import("mediabunny");
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 20_000);
    const input = new Input({
        source: new CustomSource({
            getSize: () => file.size,
            // Use the listing's size: the server does not expose Content-Range to CORS.
            read: async (start, end) => {
                const response = await fetch(url, { headers: { ...headers, Range: `bytes=${start}-${end - 1}` }, signal: controller.signal });
                if (!response.ok) throw new Error(`云端视频元数据读取失败 HTTP ${response.status}`);
                const data = new Uint8Array(await response.arrayBuffer());
                if (response.status === 200 && data.length === file.size) return data.slice(start, end);
                if (response.status !== 206 || data.length !== end - start) throw new Error("云端视频分段读取长度不一致，未采用该文件。");
                return data;
            },
            prefetchProfile: "network", maxCacheSize: 1024 * 1024,
        }),
        formats: [MP4],
    });
    try {
        const tags = await input.getMetadataTags(), prompt = tags.raw?.prompt;
        if (typeof prompt !== "string") return null;
        return JSON.parse(prompt) as unknown;
    } finally { clearTimeout(timer); controller.abort(); input.dispose(); }
}

export async function recoverZealmanOutput(panelBaseUrl: string, receipt: ZealmanRecoveryReceipt, headers?: Record<string, string>, signal?: AbortSignal) {
    const entries = Object.entries(receipt.inputSnapshot || {});
    if (!receipt.submittedAt || !entries.some(([key, value]) => /:seed$/.test(key) && typeof value === "number") || !entries.some(([, value]) => typeof value === "string" && value.length > 200)) throw new Error("旧任务历史已失效，且缺少提示词／随机种子回执，无法安全匹配云端文件；原任务保留，未重新生成。");
    const base = panelBaseUrl.replace(/\/+$/, ""), key = `${base}|${receipt.workflowId || ""}|${Math.floor(receipt.submittedAt! / 3600_000)}`;
    let cached = indexes.get(key);
    if (!cached || cached.expires < Date.now()) {
        const value = (async () => {
            const response = await axios.get<ZealmanOutputFile[]>(`${base}/api/images`, { headers, timeout: 15_000 });
            if (!Array.isArray(response.data)) throw new Error("云端输出文件列表格式不正确，原任务保留。");
            const files = zealmanRecoveryCandidates(response.data, receipt.submittedAt!);
            if (files.length > 250) throw new Error("原任务时间范围内的视频过多，已停止自动扫描，未猜测绑定。");
            const result: IndexedOutput[] = []; let next = 0, failed = 0;
            await Promise.all(Array.from({ length: Math.min(4, files.length) }, async () => {
                while (next < files.length) {
                    const file = files[next++], url = `${base}/output/${file.path.split("/").map(encodeURIComponent).join("/")}`;
                    try { const graph = await readOutputGraph(file, url, headers); if (graph) result.push({ file, url, graph }); }
                    catch { failed++; }
                }
            }));
            if (files.length && failed === files.length) throw new Error("云端文件存在，但内嵌生成记录读取失败；请保留任务，未重新生成。");
            return result;
        })();
        cached = { expires: Infinity, value }; indexes.set(key, cached);
        void value.then(() => { const entry = indexes.get(key); if (entry?.value === value) entry.expires = Date.now() + 120_000; }, () => { if (indexes.get(key)?.value === value) indexes.delete(key); });
    }
    if (signal?.aborted) throw new DOMException("取回等待已停止，原任务与云端文件保留。", "AbortError");
    const outputs = signal ? await new Promise<IndexedOutput[]>((resolve, reject) => {
        const abort = () => reject(new DOMException("本次查询已停止，云端文件与原任务保留。", "AbortError"));
        signal.addEventListener("abort", abort, { once: true });
        cached.value.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    }) : await cached.value;
    const output = uniqueZealmanOutput(outputs, receipt);
    if (!output) throw new Error("旧任务查询历史已失效，云端输出中未找到提示词、随机种子及参数完全匹配的成片；未猜测绑定，也未重新生成。");
    return { status: "completed" as const, url: output.url };
}

import { isRunningHubConfig } from "./runninghub.ts";

export const RH_WORKFLOW_KIND = "runninghub-workflow-v1";
export type RhSource = "prompt" | "seconds" | "count" | "seed" | `image:${number}` | `video:${number}` | `audio:${number}`;
export type RhBinding = { nodeId: string; fieldName: string; classType: string; source: RhSource };
export type RhMapping = { kind: typeof RH_WORKFLOW_KIND; workflowId: string; bindings: RhBinding[]; outputNodeId: string; outputClass: string; outputKind: "image" | "video" };
export type RhGraph = Record<string, { class_type: string; inputs: Record<string, unknown>; _meta?: { title?: string } }>;
export type RhSnapshot = RhMapping & { baseUrl: string };

export function isRunningHubWorkflowConfig(config: { baseUrl: string; apiFormat?: string }) {
    return config.apiFormat === "comfyui" && isRunningHubConfig({ baseUrl: config.baseUrl });
}

export function rhWorkflowId(value: string) {
    const text = value.trim();
    if (/^\d{10,25}$/.test(text)) return text;
    try {
        const url = new URL(text);
        if (isRunningHubConfig({ baseUrl: url.origin })) {
            const id = url.pathname.match(/\/(?:zh-cn\/)?workflow\/(\d{10,25})\/?$/)?.[1];
            if (id) return id;
        }
    } catch { /* IDs are accepted without a URL. */ }
    throw new Error("请填写 RunningHub 工作流链接或数字 ID");
}

export function parseRhMapping(script: string): RhMapping {
    let value: RhMapping;
    try { value = JSON.parse(script); } catch { throw new Error("请先在渠道中读取工作流并保存输入映射"); }
    if (value?.kind !== RH_WORKFLOW_KIND || !Array.isArray(value.bindings) || !value.outputNodeId || !value.outputClass || !["image", "video"].includes(value.outputKind)) throw new Error("RunningHub 工作流映射不完整，请重新配置");
    rhWorkflowId(value.workflowId);
    const fields = new Set<string>();
    for (const binding of value.bindings) {
        if (!binding.nodeId || !binding.fieldName || !binding.classType || !/^(prompt|seconds|count|seed|(image|video|audio):[1-9]\d*)$/.test(binding.source)) throw new Error("RunningHub 输入映射无效");
        const key = `${binding.nodeId}.${binding.fieldName}`;
        if (fields.has(key)) throw new Error(`输入字段 ${key} 被重复映射`);
        fields.add(key);
    }
    return value;
}

export function rhSnapshot(value?: Record<string, unknown>): RhSnapshot | undefined {
    if (value?.kind !== RH_WORKFLOW_KIND) return undefined;
    const mapping = parseRhMapping(JSON.stringify(value));
    if (typeof value.baseUrl !== "string" || !isRunningHubConfig({ baseUrl: value.baseUrl })) throw new Error("RunningHub 原任务地址无效");
    return { ...mapping, baseUrl: value.baseUrl };
}

export function validateRhMapping(graph: RhGraph, mapping: RhMapping) {
    parseRhMapping(JSON.stringify(mapping));
    for (const b of mapping.bindings) {
        const node = graph[b.nodeId];
        if (!node || node.class_type !== b.classType || !Object.hasOwn(node.inputs, b.fieldName) || !["string", "number", "boolean"].includes(typeof node.inputs[b.fieldName])) throw new Error(`工作流已变化：#${b.nodeId}.${b.fieldName} 不再是可覆盖的输入，请重新读取映射`);
        const stringSource = b.source === "prompt" || /^(image|video|audio):/.test(b.source);
        if ((stringSource && typeof node.inputs[b.fieldName] !== "string") || (!stringSource && typeof node.inputs[b.fieldName] !== "number")) throw new Error(`#${b.nodeId}.${b.fieldName} 的字段类型与映射来源不匹配`);
    }
    if (graph[mapping.outputNodeId]?.class_type !== mapping.outputClass) throw new Error(`找不到输出节点 #${mapping.outputNodeId}，请重新选择结果节点`);
}

export type RhValues = { prompt: string; seconds?: number; count?: number; images: string[]; videos: string[]; audios: string[] };
export function buildRhNodeInfo(mapping: RhMapping, input: RhValues) {
    if (input.prompt.trim() && !mapping.bindings.some(b => b.source === "prompt")) throw new Error("此工作流尚未映射提示词；请配置后再生成");
    if ((input.count || 1) > 1 && !mapping.bindings.some(b => b.source === "count")) throw new Error("此工作流未映射出图数量，请选择 1 张或配置数量输入");
    const media = { image: input.images, video: input.videos, audio: input.audios };
    for (const kind of ["image", "video", "audio"] as const) {
        const used = new Set(mapping.bindings.filter(b => b.source.startsWith(`${kind}:`)).map(b => Number(b.source.split(":")[1])));
        if (media[kind].some((_, i) => !used.has(i + 1))) throw new Error(`有未映射的${kind === "image" ? "图片" : kind === "video" ? "视频" : "音频"}，未提交生成`);
    }
    return mapping.bindings.map(b => {
        let fieldValue: string | number;
        if (b.source === "prompt") fieldValue = input.prompt;
        else if (b.source === "seed") fieldValue = Math.floor(Math.random() * 2 ** 48);
        else if (b.source === "seconds" || b.source === "count") {
            const number = input[b.source];
            if (!number || !Number.isFinite(number) || number <= 0) throw new Error(`请明确设置${b.source === "seconds" ? "时长" : "数量"}`);
            fieldValue = number;
        } else {
            const [kind, index] = b.source.split(":");
            const ref = media[kind as keyof typeof media][Number(index) - 1];
            if (!ref) throw new Error(`缺少已映射的参考素材 ${b.source}（#${b.nodeId}）`);
            fieldValue = ref;
        }
        return { nodeId: b.nodeId, fieldName: b.fieldName, fieldValue };
    });
}

export function selectRhOutputs(data: unknown, mapping: Pick<RhMapping, "outputNodeId" | "outputKind">) {
    if (!Array.isArray(data)) return [];
    return data.flatMap((item: { nodeId?: string | number; fileUrl?: string; fileType?: string }) => {
        if (!item || String(item.nodeId) !== mapping.outputNodeId || typeof item.fileUrl !== "string") return [];
        let url: URL;
        try { url = new URL(item.fileUrl); } catch { return []; }
        if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return [];
        const kind = `${item.fileType || ""} ${url.pathname}`.toLowerCase();
        const matches = mapping.outputKind === "video" ? /(?:video|mp4|webm|mov|mkv)/.test(kind) : /(?:image|png|jpe?g|webp|avif)/.test(kind);
        return matches ? [url.href] : [];
    });
}

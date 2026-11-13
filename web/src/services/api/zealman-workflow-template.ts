export type ZealmanWorkflowNode = {
    class_type?: string;
    inputs?: Record<string, unknown>;
    _meta?: { title?: string };
};

export type ZealmanWorkflowTemplate = Record<string, ZealmanWorkflowNode>;

export type ZealmanWorkflowApiConfig = {
    customLabels?: Record<string, string>;
    enabledParams?: Record<string, boolean>;
    formValues?: Record<string, unknown>;
    mediaOrder?: string[];
    mediaOrderSource?: string;
};

/** Follow conditioning and text links, so a primitive's value is writable without breaking its cable. */
export function inferZealmanPromptInput(workflow: ZealmanWorkflowTemplate, apiConfig?: ZealmanWorkflowApiConfig) {
    const negative = /negative|负面|反向/i;
    const fields = ["prompt", "positive_prompt", "text", "positive", "custom_prompt", "提示词", "value"];
    function textSource(nodeId: string, field: string, seen = new Set<string>()): string | undefined {
        const key = `${nodeId}:${field}`;
        if (seen.has(key)) return;
        seen.add(key);
        const node = workflow[nodeId];
        if (!node || negative.test(`${node._meta?.title || ""} ${apiConfig?.customLabels?.[key] || ""}`)) return;
        const value = node.inputs?.[field];
        if (typeof value === "string") return key;
        if (!Array.isArray(value)) return;
        const sourceId = String(value[0]);
        const source = workflow[sourceId];
        if (!source) return;
        for (const sourceField of fields) {
            if (sourceField === "value" && !/String|Text|Prompt/i.test(source.class_type || "")) continue;
            if (sourceField in (source.inputs || {})) {
                const result = textSource(sourceId, sourceField, new Set(seen));
                if (result) return result;
            }
        }
        for (const sourceField of ["conditioning", "conditioning_1", "conditioning_2"]) {
            const result = textSource(sourceId, sourceField, new Set(seen));
            if (result) return result;
        }
        if (/Concatenate|Concat/i.test(source.class_type || "")) {
            const chunks = ["string_a", "string_b", "text_a", "text_b"]
                .filter((name) => name in (source.inputs || {}))
                .sort((a, b) => Number(Boolean(apiConfig?.enabledParams?.[`${sourceId}:${b}`])) - Number(Boolean(apiConfig?.enabledParams?.[`${sourceId}:${a}`])) || Number(Array.isArray(source.inputs?.[b])) - Number(Array.isArray(source.inputs?.[a])));
            for (const chunk of chunks) {
                const result = textSource(sourceId, chunk, new Set(seen));
                if (result) return result;
            }
        }
    }
    const graphKeys = new Set<string>();
    for (const [nodeId, node] of Object.entries(workflow)) {
        for (const field of ["positive", "prompt", "positive_prompt", "提示词"]) {
            if (!(field in (node.inputs || {}))) continue;
            const key = textSource(nodeId, field);
            if (key) graphKeys.add(key);
        }
    }
    const exposed = Object.entries(apiConfig?.enabledParams || {})
        .filter(([, enabled]) => enabled)
        .map(([key]) => ({ key, parts: inputKeyParts(key) }))
        .filter(({ key, parts }) => parts && fields.includes(parts.field) && typeof workflow[parts.nodeId]?.inputs?.[parts.field] === "string" && !negative.test(`${workflow[parts.nodeId]?._meta?.title || ""} ${apiConfig?.customLabels?.[key] || ""}`))
        .filter(({ key, parts }) => graphKeys.has(key) || (parts!.field !== "value" && parts!.field !== "text") || /提示词|正面|positive|prompt/i.test(apiConfig?.customLabels?.[key] || ""))
        .sort((a, b) => Number(graphKeys.has(b.key)) - Number(graphKeys.has(a.key)));
    return exposed[0]?.key || [...graphKeys][0];
}

export function t8ResolutionInputs(workflow: ZealmanWorkflowTemplate, width: number, height: number, quality = "480p"): Record<string, unknown> {
    if (!Object.values(workflow).some((node) => node.class_type === "MiniMaxH3AudioConditioningT8")) return {};
    const entry = Object.entries(workflow).find(([, node]) => node.class_type === "ResolutionSelector" && typeof node.inputs?.aspect_ratio === "string" && typeof node.inputs?.megapixels === "number");
    if (!entry) return {};
    const square = width === height;
    const low = /^(480p?|low)$/i.test(quality);
    return {
        [`${entry[0]}:aspect_ratio`]: square ? "1:1 (Square)" : width > height ? "16:9 (Widescreen)" : "9:16 (Portrait Widescreen)",
        [`${entry[0]}:megapixels`]: square ? low ? 0.23 : 0.56 : low ? 0.4 : 0.98,
    };
}

function inputKeyParts(key: string) {
    const separator = key.lastIndexOf(":");
    return separator > 0 ? { nodeId: key.slice(0, separator), field: key.slice(separator + 1) } : null;
}

/** Find a cloud-exposed seconds control by semantic title instead of a fixed node id. */
export function inferZealmanDurationInput(workflow: ZealmanWorkflowTemplate, apiConfig?: ZealmanWorkflowApiConfig) {
    return Object.entries(apiConfig?.enabledParams || {})
        .filter(([, enabled]) => enabled)
        .map(([key]) => ({ key, parts: inputKeyParts(key) }))
        .find(({ key, parts }) => {
            if (!parts || !/^(?:value|seconds?|duration)$/i.test(parts.field)) return false;
            const node = workflow[parts.nodeId];
            if (typeof node?.inputs?.[parts.field] !== "number") return false;
            const label = `${node.class_type || ""} ${node._meta?.title || ""} ${apiConfig?.customLabels?.[key] || ""}`;
            return /(?:时长|秒|duration|seconds?)/i.test(label);
        })?.key;
}

export const ZEALMAN_SEED_MAX = 4_294_967_295;

export function zealmanRandomSeed() {
    return Math.floor(Math.random() * (ZEALMAN_SEED_MAX + 1));
}

/** Prefer sampler/noise seeds; SeedVR upscalers still map if they are the only seed, but stay within uint32. */
export function inferZealmanSeedInput(workflow: ZealmanWorkflowTemplate, apiConfig?: ZealmanWorkflowApiConfig) {
    const enabled = Object.entries(apiConfig?.enabledParams || {})
        .filter(([, on]) => on)
        .map(([key]) => ({ key, parts: inputKeyParts(key) }))
        .find(({ key, parts }) => {
            if (!parts || !/^(?:seed|noise_seed)$/i.test(parts.field)) return false;
            const node = workflow[parts.nodeId];
            if (typeof node?.inputs?.[parts.field] !== "number") return false;
            const label = `${node.class_type || ""} ${node._meta?.title || ""} ${apiConfig?.customLabels?.[key] || ""}`;
            return /seed|随机|种子/i.test(label);
        })?.key;
    if (enabled) return enabled;

    const ranked = Object.entries(workflow)
        .map(([nodeId, node]) => {
            const field = typeof node.inputs?.seed === "number" ? "seed" : typeof node.inputs?.noise_seed === "number" ? "noise_seed" : "";
            if (!field) return null;
            const type = `${node.class_type || ""} ${node._meta?.title || ""}`;
            const priority = /KSampler|RandomNoise|Noise_RandomNoise|SamplerCustom/i.test(type) ? 0 : /SeedVR|Upscaler|Video|Audio/i.test(type) ? 2 : 1;
            return { key: `${nodeId}:${field}`, priority };
        })
        .filter((item): item is { key: string; priority: number } => Boolean(item))
        .sort((a, b) => a.priority - b.priority || a.key.localeCompare(b.key, undefined, { numeric: true }));
    return ranked[0]?.key;
}

export type ZealmanImageSizeMapping = {
    width?: string;
    height?: string;
    padLeft?: string;
    padTop?: string;
    padRight?: string;
    padBottom?: string;
};

function writableInputKey(workflow: ZealmanWorkflowTemplate, nodeId: string, field: string) {
    const value = workflow[nodeId]?.inputs?.[field];
    if (!Array.isArray(value)) return `${nodeId}:${field}`;
    const sourceId = String(value[0]);
    const sourceInputs = workflow[sourceId]?.inputs;
    return sourceInputs && typeof sourceInputs.value === "number" ? `${sourceId}:value` : undefined;
}

function nodeLabel(workflow: ZealmanWorkflowTemplate, apiConfig: ZealmanWorkflowApiConfig | undefined, nodeId: string, field = "") {
    const node = workflow[nodeId];
    const key = field ? `${nodeId}:${field}` : "";
    return `${node?.class_type || ""} ${node?._meta?.title || ""} ${key ? apiConfig?.customLabels?.[key] || "" : ""} ${field}`;
}

function enabledNumericKey(workflow: ZealmanWorkflowTemplate, apiConfig: ZealmanWorkflowApiConfig | undefined, pattern: RegExp) {
    return Object.entries(apiConfig?.enabledParams || {})
        .filter(([, enabled]) => enabled)
        .map(([key]) => ({ key, parts: inputKeyParts(key) }))
        .find(({ key, parts }) => {
            if (!parts) return false;
            const value = workflow[parts.nodeId]?.inputs?.[parts.field];
            if (typeof value !== "number" && !Array.isArray(value)) return false;
            return pattern.test(nodeLabel(workflow, apiConfig, parts.nodeId, parts.field));
        })?.key;
}

function alignPixels(value: number, multiple = 8) {
    return Math.max(multiple, Math.round(value / multiple) * multiple);
}

function splitPad(extra: number) {
    const total = Math.max(0, Math.round(Math.max(0, extra) / 8) * 8);
    const first = Math.floor(total / 16) * 8;
    return { first, second: total - first };
}

/** Infer canvas size and ImagePadForOutpaint-style margins without hard-coded node IDs. */
export function inferZealmanImageSizeMapping(workflow: ZealmanWorkflowTemplate, apiConfig?: ZealmanWorkflowApiConfig): ZealmanImageSizeMapping {
    const entries = Object.entries(workflow);
    const padNode = entries.find(([, node]) => {
        const label = `${node.class_type || ""} ${node._meta?.title || ""}`;
        return /pad/i.test(label) && /outpaint|外扩|扩图/i.test(label) && node.inputs && ("left" in node.inputs || "top" in node.inputs);
    });
    const padLeft = padNode ? writableInputKey(workflow, padNode[0], "left") : enabledNumericKey(workflow, apiConfig, /(?:\bleft\b|pad_left|left_pad|左扩|左边距|左侧|向左)/i);
    const padTop = padNode ? writableInputKey(workflow, padNode[0], "top") : enabledNumericKey(workflow, apiConfig, /(?:\btop\b|pad_top|top_pad|上扩|上边距|上侧|向上)/i);
    const padRight = padNode ? writableInputKey(workflow, padNode[0], "right") : enabledNumericKey(workflow, apiConfig, /(?:\bright\b|pad_right|right_pad|右扩|右边距|右侧|向右)/i);
    const padBottom = padNode ? writableInputKey(workflow, padNode[0], "bottom") : enabledNumericKey(workflow, apiConfig, /(?:\bbottom\b|pad_bottom|bottom_pad|下扩|下边距|下侧|向下)/i);

    const sizeNode = entries.find(([, node]) => {
        const label = `${node.class_type || ""} ${node._meta?.title || ""}`;
        return /aspect\s*ratio/i.test(label) && node.inputs && "width" in node.inputs && "height" in node.inputs;
    }) || entries.find(([, node]) => /Empty(?:Latent)?Image/i.test(node.class_type || "") && node.inputs && "width" in node.inputs && "height" in node.inputs);
    const widthKey = sizeNode ? writableInputKey(workflow, sizeNode[0], "width") : enabledNumericKey(workflow, apiConfig, /(?:\bwidth\b|宽度|目标宽)/i);
    const heightKey = sizeNode ? writableInputKey(workflow, sizeNode[0], "height") : enabledNumericKey(workflow, apiConfig, /(?:\bheight\b|高度|目标高)/i);

    return {
        ...(widthKey ? { width: widthKey } : {}),
        ...(heightKey ? { height: heightKey } : {}),
        ...(padLeft ? { padLeft } : {}),
        ...(padTop ? { padTop } : {}),
        ...(padRight ? { padRight } : {}),
        ...(padBottom ? { padBottom } : {}),
    };
}

/** 1K/2K/4K plus aspect; auto keeps the source photo ratio instead of forcing a square. */
export function zealmanImageTargetSize(size: string, quality: string, source?: { width: number; height: number }) {
    const parsed = String(size || "").trim().match(/^(\d+)(?::|x)(\d+)$/i);
    const sourceRatio = source && source.width > 0 && source.height > 0 ? source.width / source.height : undefined;
    const ratio = parsed && Number(parsed[1]) > 0 && Number(parsed[2]) > 0 ? Number(parsed[1]) / Number(parsed[2]) : sourceRatio || 1;
    const longEdge = /4k/i.test(quality) ? 2048 : /2k/i.test(quality) ? 1536 : 1024;
    const landscape = ratio >= 1;
    return {
        width: alignPixels(landscape ? longEdge : longEdge * ratio),
        height: alignPixels(landscape ? longEdge / ratio : longEdge),
    };
}

/** Center-pad the source photo onto the target canvas; never send negative margins. */
export function zealmanOutpaintPads(source: { width: number; height: number }, target: { width: number; height: number }) {
    const extraWidth = Math.max(0, target.width - source.width);
    const extraHeight = Math.max(0, target.height - source.height);
    const horizontal = splitPad(extraWidth);
    const vertical = splitPad(extraHeight);
    return { left: horizontal.first, right: horizontal.second, top: vertical.first, bottom: vertical.second };
}

export type ZealmanReferenceSlot = {
    key: string;
    nodeId: string;
    label: string;
    kind: "image" | "video" | "audio";
    required: boolean;
};

type H3ReferenceBinding = {
    nodeId: string;
    inputName: string;
    kind: ZealmanReferenceSlot["kind"];
    index: number;
    required?: boolean;
};

function workflowLinkSource(value: unknown) {
    return Array.isArray(value) && (typeof value[0] === "string" || typeof value[0] === "number") ? String(value[0]) : "";
}

function h3ReferenceInput(inputName: string): Pick<H3ReferenceBinding, "kind" | "index"> | null {
    const match = inputName.match(/^ref_(images|videos|video_audios|audios)\.ref_(?:image|video|video_audio|audio)_(\d+)$/);
    if (!match) return null;
    const kind = match[1] === "images" ? "image" : match[1] === "videos" ? "video" : "audio";
    return { kind, index: Number(match[2]) };
}

function referenceInput(node: ZealmanWorkflowNode, inputName: string): Pick<H3ReferenceBinding, "kind" | "index" | "required"> | null {
    if (["MiniMaxH3ReferenceToVideo", "MiniMaxH3AudioConditioningT8", "DenoMiniMaxH3ReferenceToVideo"].includes(node.class_type || "")) return h3ReferenceInput(inputName);
    const qwen = node.class_type === "TextEncodeQwenImage21" ? inputName.match(/^images\.image_(\d+)$/) : ["TextEncodeQwenImageEditPlus", "Flux2KleinEditTextEncode_EditUtils"].includes(node.class_type || "") ? inputName.match(/^image(\d+)$/) : null;
    if (qwen) return { kind: "image", index: Number(qwen[1]) - 1, required: Number(qwen[1]) === 1 };
    if (node.class_type === "Krea2EditGroundedEncode" && inputName === "image_b") return { kind: "image", index: 1 };
    return null;
}

function findH3ReferenceBranch(workflow: ZealmanWorkflowTemplate, sourceNodeId: string) {
    const branchNodeIds = new Set([sourceNodeId]);
    const bindings: H3ReferenceBinding[] = [];
    let changed = true;
    while (changed) {
        changed = false;
        for (const [nodeId, node] of Object.entries(workflow)) {
            for (const [inputName, value] of Object.entries(node.inputs || {})) {
                const originNodeId = workflowLinkSource(value);
                if (!originNodeId || !branchNodeIds.has(originNodeId)) continue;
                const reference = referenceInput(node, inputName);
                if (reference) {
                    if (!bindings.some((binding) => binding.nodeId === nodeId && binding.inputName === inputName)) bindings.push({ nodeId, inputName, ...reference });
                    continue;
                }
                if (!branchNodeIds.has(nodeId)) {
                    branchNodeIds.add(nodeId);
                    changed = true;
                }
            }
        }
    }
    // A reference loader can also feed a required latent or saved image. Keep it required in that case.
    const hasRequiredSink = [...branchNodeIds].some((nodeId) => !Object.entries(workflow).some(([consumerId, node]) => Object.entries(node.inputs || {}).some(([field, value]) => workflowLinkSource(value) === nodeId && (branchNodeIds.has(consumerId) || bindings.some((binding) => binding.nodeId === consumerId && binding.inputName === field)))));
    return { branchNodeIds, bindings, optional: bindings.length > 0 && !bindings.some((binding) => binding.required) && !hasRequiredSink };
}

function referenceKindForInput(node: ZealmanWorkflowNode | undefined, field: string): ZealmanReferenceSlot["kind"] | null {
    if (field === "image" || field === "video" || field === "audio") return field;
    if (field === "file" && node?.class_type === "LoadVideo") return "video";
    if (node?.class_type === "ZealmanH3PickReferenceMedia") {
        const match = field.match(/^ref_(image|video|audio)_\d+$/);
        if (match) return match[1] as ZealmanReferenceSlot["kind"];
    }
    return null;
}

function h3SlotOrder(workflow: ZealmanWorkflowTemplate, nodeId: string, kind: ZealmanReferenceSlot["kind"]) {
    const bindings = findH3ReferenceBranch(workflow, nodeId).bindings.filter((binding) => binding.kind === kind);
    return bindings.length ? Math.min(...bindings.map((binding) => binding.index)) : Number.POSITIVE_INFINITY;
}

function cleanSlotLabel(label: string, kind: ZealmanReferenceSlot["kind"], index: number, duplicate: boolean) {
    const cleaned = label
        .replace(/\s*[（(]节点\s*[^）)]+[）)]\s*$/i, "")
        .replace(/^上传(?:图片|视频|音频)$/i, "")
        .trim();
    if (!cleaned || duplicate || /^参考(?:图|视频|音频)\s*\d+$/.test(cleaned) || /^(?:图像|音频|视频) ref_/.test(cleaned)) return `${kind === "image" ? "参考图" : kind === "video" ? "参考视频" : "参考音频"} ${index + 1}`;
    return cleaned;
}

/** Discover cloud-exposed media slots, including the native LoadVideo `file` widget. */
export function inferZealmanReferenceSlots(workflow: ZealmanWorkflowTemplate, apiConfig?: ZealmanWorkflowApiConfig): ZealmanReferenceSlot[] {
    const candidates = Object.entries(apiConfig?.enabledParams || {})
        .filter(([, enabled]) => enabled)
        .map(([key]) => {
            const separator = key.lastIndexOf(":");
            const nodeId = key.slice(0, separator);
            const field = key.slice(separator + 1);
            const node = workflow[nodeId];
            const kind = referenceKindForInput(node, field);
            const directOrder = node?.class_type === "ZealmanH3PickReferenceMedia" ? Number(field.match(/_(\d+)$/)?.[1]) : undefined;
            return kind && typeof node?.inputs?.[field] === "string" ? { key, nodeId, kind, rawLabel: apiConfig?.customLabels?.[key] || "", h3Order: directOrder ?? h3SlotOrder(workflow, nodeId, kind) } : null;
        })
        .filter((slot): slot is { key: string; nodeId: string; kind: ZealmanReferenceSlot["kind"]; rawLabel: string; h3Order: number } => Boolean(slot))
        .sort((a, b) => {
            const kindOrder = { image: 0, video: 1, audio: 2 } as const;
            const order = apiConfig?.mediaOrder || [];
            const manualOrder = apiConfig?.mediaOrderSource === "manual" && order.includes(a.key) && order.includes(b.key) ? order.indexOf(a.key) - order.indexOf(b.key) : 0;
            return kindOrder[a.kind] - kindOrder[b.kind] || manualOrder || a.h3Order - b.h3Order || a.nodeId.localeCompare(b.nodeId, "zh-CN", { numeric: true });
        });
    const normalizedLabels = candidates.map((slot) => slot.rawLabel.replace(/\s*[（(]节点\s*[^）)]+[）)]\s*$/i, "").trim());
    const indexes = { image: 0, video: 0, audio: 0 };
    return candidates.map((slot, index) => {
        const kindIndex = indexes[slot.kind]++;
        const h3Optional = workflow[slot.nodeId]?.class_type === "ZealmanH3PickReferenceMedia" || findH3ReferenceBranch(workflow, slot.nodeId).optional;
        return {
            key: slot.key,
            nodeId: slot.nodeId,
            kind: slot.kind,
            required: !(workflow[slot.nodeId]?.inputs && "enabled" in workflow[slot.nodeId].inputs!) && !h3Optional,
            label: cleanSlotLabel(slot.rawLabel, slot.kind, kindIndex, normalizedLabels.filter((label, candidateIndex) => candidates[candidateIndex].kind === slot.kind && label === normalizedLabels[index]).length > 1),
        };
    });
}

/** Remove unused H3 reference inputs and then delete their now-orphaned loader/transform branches. */
export function pruneUnusedZealmanReferenceBranches(workflow: ZealmanWorkflowTemplate, unusedSlots: ZealmanReferenceSlot[]) {
    for (const node of Object.values(workflow)) {
        if (node.class_type === "ZealmanH3PickReferenceMedia" && node.inputs && "media_files" in node.inputs) node.inputs.media_files = "[]";
    }
    const candidates = new Set<string>();
    for (const slot of unusedSlots) {
        if (workflow[slot.nodeId]?.class_type === "ZealmanH3PickReferenceMedia") {
            const field = inputKeyParts(slot.key)?.field;
            if (field) workflow[slot.nodeId].inputs![field] = "";
            continue;
        }
        const branch = findH3ReferenceBranch(workflow, slot.nodeId);
        if (!branch.optional) continue;
        branch.bindings.forEach((binding) => {
            delete workflow[binding.nodeId]?.inputs?.[binding.inputName];
        });
        branch.branchNodeIds.forEach((nodeId) => candidates.add(nodeId));
    }

    let changed = true;
    while (changed) {
        changed = false;
        for (const nodeId of candidates) {
            if (!workflow[nodeId]) continue;
            const hasConsumer = Object.values(workflow).some((node) => Object.values(node.inputs || {}).some((value) => workflowLinkSource(value) === nodeId));
            if (hasConsumer) continue;
            delete workflow[nodeId];
            changed = true;
        }
    }
    return workflow;
}

import { defaultConfig, resolveModelForCapability, type AiConfig } from "@/stores/use-config-store";
import i18n from "@/i18n";
import { resolveImageUrl, uploadImage } from "@/services/image-storage";
import { readVideoMeta, resolveMediaUrl, uploadMediaFile } from "@/services/file-storage";
import { readImageMeta } from "@/lib/image-utils";
import { audioMetadata, imageMetadata, referenceUrl, videoMetadata } from "@/lib/canvas/canvas-node-factory";
import type { NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import type { CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import type { CanvasImageAngleParams } from "@/components/canvas/canvas-node-angle-dialog";
import type { ReferenceImage } from "@/types/image";
import { CanvasNodeType, type CanvasAssistantSession, type CanvasConnection, type CanvasGenerationPhase, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";

export function imageExtension(dataUrl: string) {
    return dataUrl.match(/^data:image[/]([^;]+)/)?.[1] || dataUrl.match(/image[/]([^;]+)/)?.[1] || "png";
}

export function audioExtension(mimeType?: string) {
    if (mimeType?.includes("wav")) return "wav";
    if (mimeType?.includes("opus")) return "opus";
    if (mimeType?.includes("aac")) return "aac";
    if (mimeType?.includes("flac")) return "flac";
    if (mimeType?.includes("pcm")) return "pcm";
    return "mp3";
}

export function generationReferenceUrls(context: { referenceImages: ReferenceImage[]; referenceVideos: Array<{ storageKey?: string; url?: string }>; referenceAudios?: Array<{ storageKey?: string; url?: string }> }) {
    return [
        ...context.referenceImages.map(referenceUrl).filter((url): url is string => Boolean(url)),
        ...context.referenceVideos.map((video) => video.storageKey || video.url).filter((url): url is string => Boolean(url)),
        ...(context.referenceAudios || []).map((audio) => audio.storageKey || audio.url).filter((url): url is string => Boolean(url)),
    ];
}

export async function resolveMetadataReferences(metadata: CanvasNodeMetadata) {
    if (metadata.generationType !== "edit") return [];
    if (!metadata.references?.length) return null;
    const references = await Promise.all(
        metadata.references.map(async (url, index) => {
            const dataUrl = url.startsWith("image:") ? await resolveImageUrl(url, "") : url;
            return dataUrl ? { id: `${index}`, name: `reference-${index}.png`, type: "image/png", dataUrl, storageKey: url.startsWith("image:") ? url : undefined } : null;
        }),
    );
    return references.every(Boolean) ? (references as ReferenceImage[]) : null;
}

export async function hydrateCanvasImages(nodes: CanvasNodeData[]) {
    const remoteImages = new Map<string, ReturnType<typeof uploadImage>>();
    const remoteMedia = new Map<string, ReturnType<typeof uploadMediaFile>>();
    const storeRemoteImage = (url: string) => {
        const current = remoteImages.get(url);
        if (current) return current;
        const pending = uploadImage(url);
        remoteImages.set(url, pending);
        return pending;
    };
    const storeRemoteMedia = (url: string, prefix: string) => {
        const current = remoteMedia.get(url);
        if (current) return current;
        const pending = uploadMediaFile(url, prefix);
        remoteMedia.set(url, pending);
        return pending;
    };
    return Promise.all(
        nodes.map(async (node) => {
            const content = node.metadata?.content;
            if (node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Audio) {
                if (!node.metadata?.storageKey && content && /^https?:\/\//i.test(content)) {
                    const stored = await storeRemoteMedia(content, node.type).catch(() => null);
                    if (stored) return { ...node, metadata: { ...node.metadata, ...(node.type === CanvasNodeType.Video ? videoMetadata(stored) : audioMetadata(stored)) } };
                }
                const resolvedContent = node.metadata?.storageKey ? await resolveMediaUrl(node.metadata.storageKey, content) : content;
                if (node.type !== CanvasNodeType.Video || !resolvedContent || (node.metadata?.naturalWidth && node.metadata.naturalHeight)) {
                    return resolvedContent === content ? node : { ...node, metadata: { ...node.metadata, content: resolvedContent } };
                }
                const meta = await readVideoMeta(resolvedContent);
                return {
                    ...node,
                    metadata: {
                        ...node.metadata,
                        content: resolvedContent,
                        naturalWidth: meta.width,
                        naturalHeight: meta.height,
                        durationMs: node.metadata?.durationMs || meta.durationMs,
                    },
                };
            }
            if (node.type !== CanvasNodeType.Image || !content) return node;
            const images = await Promise.all(
                (node.metadata?.images || []).map(async (image) => {
                    if (!image.content) return image;
                    if (image.storageKey) return { ...image, content: await resolveImageUrl(image.storageKey, image.content) };
                    if (!/^https?:\/\//i.test(image.content)) return image;
                    const stored = await storeRemoteImage(image.content).catch(() => null);
                    return stored ? { ...image, content: stored.url, storageKey: stored.storageKey, naturalWidth: stored.width, naturalHeight: stored.height, bytes: stored.bytes, mimeType: stored.mimeType } : image;
                }),
            );
            const resolvedContent = node.metadata?.storageKey ? await resolveImageUrl(node.metadata.storageKey, content) : content;
            if (content.startsWith("data:image/") && !node.metadata?.storageKey) {
                const stored = await uploadImage(content).catch(() => null);
                return { ...node, metadata: { ...node.metadata, ...(stored ? imageMetadata(stored) : {}), images } };
            }
            if (!node.metadata?.storageKey && /^https?:\/\//i.test(content)) {
                const stored = await storeRemoteImage(content).catch(() => null);
                if (stored) return { ...node, metadata: { ...node.metadata, ...imageMetadata(stored), images } };
            }
            if (node.metadata?.naturalWidth && node.metadata.naturalHeight) return { ...node, metadata: { ...node.metadata, content: resolvedContent, images } };
            const meta = await readImageMeta(resolvedContent).catch(() => null);
            return { ...node, metadata: { ...node.metadata, content: resolvedContent, images, ...(meta ? { naturalWidth: meta.width, naturalHeight: meta.height, mimeType: node.metadata?.mimeType || meta.mimeType } : {}) } };
        }),
    );
}

export async function hydrateAssistantImages(sessions: CanvasAssistantSession[]) {
    const hydrateItem = async <T extends { dataUrl?: string; storageKey?: string }>(item: T) => {
        if (item.storageKey) return { ...item, dataUrl: await resolveImageUrl(item.storageKey, item.dataUrl) };
        if (item.dataUrl?.startsWith("data:image/")) {
            const image = await uploadImage(item.dataUrl);
            return { ...item, dataUrl: image.url, storageKey: image.storageKey };
        }
        return item;
    };
    return Promise.all(
        sessions.map(async (session) => ({
            ...session,
            messages: await Promise.all(
                session.messages.map(async (message) => ({
                    ...message,
                    references: await Promise.all((message.references || []).map(hydrateItem)),
                })),
            ),
        })),
    );
}

export function getGenerationCount(count: string) {
    return Math.max(1, Math.min(15, Math.floor(Math.abs(Number(count)) || 1)));
}

const batchVariationDirections = [
    "重点改变造型轮廓与整体结构",
    "重点改变配色、材质与表面质感",
    "重点改变细节结构、装饰与设计语言",
    "重点改变整体视觉气质、搭配与氛围",
];

export function buildBatchImagePrompt(prompt: string, index: number, count: number) {
    if (count <= 1) return prompt;
    const direction = batchVariationDirections[index % batchVariationDirections.length];
    return `${prompt}\n\n批量任务分配（最高优先级）：这是共 ${count} 张结果中的第 ${index + 1} 张。如果原提示词明确列出了与结果数量对应的 ${count} 个子任务、视角、镜头、款式或方案，本张只执行其中第 ${index + 1} 项；不要同时执行其余项，不要把多个结果拼成四宫格、分屏、拼贴或多视图合成图。原提示词里对所有结果共同生效的人物身份、参考图一致性、主体、画幅、用途和质量要求仍须保留。\n如果原提示词没有逐张列出 ${count} 个对应子任务，则把本张作为第 ${index + 1} 套独立方案，${direction}，并在允许变化的设计维度上与其他方案形成肉眼可辨的差异；若涉及服装或产品，款式、剪裁、颜色、材质、细节中至少两项应有明显变化。只输出本张对应的一项或一套方案，不要添加方案编号或说明文字。`;
}

export function getInputSummary(inputs: NodeGenerationInput[]) {
    return {
        textCount: inputs.filter((input) => input.type === "text").length,
        imageCount: inputs.filter((input) => input.type === "image").length,
        videoCount: inputs.filter((input) => input.type === "video").length,
        audioCount: inputs.filter((input) => input.type === "audio").length,
    };
}

export function buildGenerationConfig(config: AiConfig, node: CanvasNodeData | undefined, mode: CanvasNodeGenerationMode): AiConfig {
    const defaultSize = mode === "video" ? config.videoSize : mode === "image" ? config.imageSize : config.size;
    return {
        ...config,
        model: resolveModelForCapability(config, node?.metadata?.model, mode),
        reasoningEffort: node?.metadata?.reasoningEffort || config.reasoningEffort || defaultConfig.reasoningEffort,
        quality: node?.metadata?.quality || config.quality || defaultConfig.quality,
        size: node?.metadata?.size || defaultSize || defaultConfig.size,
        background: node?.metadata?.background ?? config.background ?? defaultConfig.background,
        videoSeconds: node?.metadata?.seconds || config.videoSeconds || defaultConfig.videoSeconds,
        vquality: node?.metadata?.vquality || config.vquality || defaultConfig.vquality,
        videoGenerateAudio: node?.metadata?.generateAudio || config.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: node?.metadata?.watermark || config.videoWatermark || defaultConfig.videoWatermark,
        audioVoice: node?.metadata?.audioVoice || config.audioVoice || defaultConfig.audioVoice,
        audioFormat: node?.metadata?.audioFormat || config.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node?.metadata?.audioSpeed || config.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node?.metadata?.audioInstructions || config.audioInstructions || defaultConfig.audioInstructions,
        count: String(node?.metadata?.count || config.count || defaultConfig.count),
    };
}

/** 无可恢复订单的 loading 标中断；有 generationJobId 的保留 loading 供续轮询 */
export function resetInterruptedGeneration(nodes: CanvasNodeData[], resumableJobIds?: Set<string>, resumableJobByNodeId?: Map<string, string>) {
    return nodes.map((node) => {
        const jobId = node.metadata?.generationJobId || resumableJobByNodeId?.get(node.id);
        if (jobId && resumableJobIds?.has(jobId)) {
            return {
                ...node,
                metadata: {
                    ...(node.metadata || {}),
                    status: "loading" as const,
                    errorDetails: undefined,
                    generationJobId: jobId,
                    generationPhase: node.metadata?.generationPhase || "queued",
                    generationDetail: node.metadata?.generationDetail || "正在恢复远程任务轮询",
                },
            };
        }
        if (node.metadata?.status !== "loading") return node;
        return {
            ...node,
            metadata: {
                ...node.metadata,
                status: "error" as const,
                errorDetails: i18n.t("canvas.generation.interrupted"),
                generationJobId: undefined,
                generationPhase: undefined,
                generationProgress: undefined,
                images: node.metadata.images?.map((image) => (image.status === "loading" ? { ...image, status: "error" as const, errorDetails: i18n.t("canvas.generation.interrupted") } : image)),
            },
        };
    });
}

export function patchNodeGenerationUi(
    nodes: CanvasNodeData[],
    nodeId: string,
    patch: { phase?: CanvasGenerationPhase; progress?: number; detail?: string; clearProgress?: boolean; clearDetail?: boolean },
) {
    return nodes.map((node) => {
        if (node.id !== nodeId) return node;
        const phaseChanged = Boolean(patch.phase && patch.phase !== node.metadata?.generationPhase);
        return {
            ...node,
            metadata: {
                ...node.metadata,
                ...(patch.phase ? { generationPhase: patch.phase } : null),
                ...(phaseChanged ? { generationPhaseStartedAt: Date.now() } : null),
                ...(typeof patch.progress === "number" ? { generationProgress: patch.progress } : null),
                ...(patch.clearProgress ? { generationProgress: undefined } : null),
                ...(typeof patch.detail === "string" ? { generationDetail: patch.detail } : null),
                ...(patch.clearDetail ? { generationDetail: undefined } : null),
            },
        };
    });
}

export function isGenerationCanceled(error: unknown) {
    return error instanceof Error && (error.message === i18n.t("common.requestCanceled") || error.name === "AbortError");
}

export function findRetrySourceNode(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const queue = connections.filter((connection) => connection.toNodeId === nodeId).map((connection) => connection.fromNodeId);
    const visited = new Set<string>();
    while (queue.length) {
        const id = queue.shift()!;
        if (visited.has(id)) continue;
        visited.add(id);
        const node = nodes.find((item) => item.id === id);
        if (node?.type === CanvasNodeType.Config) return node;
        connections.filter((connection) => connection.toNodeId === id).forEach((connection) => queue.push(connection.fromNodeId));
    }
    return null;
}

export function sourceNodeReferenceImages(node: CanvasNodeData | null) {
    if (!node || node.type !== CanvasNodeType.Image || !node.metadata?.content) return [];
    return [
        {
            id: node.id,
            name: `${node.title || node.id}.png`,
            type: node.metadata.mimeType || "image/png",
            dataUrl: node.metadata.content,
            storageKey: node.metadata.storageKey,
        },
    ];
}

export function isAudioFile(file: File) {
    return file.type.startsWith("audio/") || /\.(mp3|wav)$/i.test(file.name);
}

export function buildAngleLabel(params: CanvasImageAngleParams) {
    const horizontal = params.horizontalAngle === 0 ? i18n.t("canvas.generation.front") : params.horizontalAngle > 0 ? i18n.t("canvas.generation.rotateRight", { angle: params.horizontalAngle }) : i18n.t("canvas.generation.rotateLeft", { angle: Math.abs(params.horizontalAngle) });
    const pitch = params.pitchAngle === 0 ? i18n.t("canvas.generation.level") : params.pitchAngle > 0 ? i18n.t("canvas.generation.topDown", { angle: params.pitchAngle }) : i18n.t("canvas.generation.lowAngle", { angle: Math.abs(params.pitchAngle) });
    return i18n.t("canvas.generation.angleLabel", { horizontal, pitch, distance: params.cameraDistance.toFixed(1), lens: i18n.t(params.wideAngle ? "canvas.editors.wide" : "canvas.editors.standard") });
}

export function buildAnglePrompt(params: CanvasImageAngleParams) {
    return i18n.t("canvas.generation.anglePrompt", { angle: buildAngleLabel(params) });
}

import kinStoryboardSkill from "@/lib/canvas/storyboard-skill/SKILL.md?raw";
import { buildGenerationConfig } from "@/lib/canvas/canvas-generation-helpers";
import { mentionedReferenceLabels } from "@/lib/canvas/canvas-mention-style";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { requestImageQuestion } from "@/services/api/image";
import { imageToDataUrl } from "@/services/image-storage";
import { modelOptionLabel, resolveModelRequestConfig, selectableModelsByCapability, type AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";

const STORYBOARD_STYLE_URL = "/storyboard/kin-storyboard-style.png";
const MAX_STORYBOARD_REFERENCES = 16;
const STORYBOARD_REFERENCE_MAX_EDGE = 700;
const STORYBOARD_REFERENCE_JPEG_QUALITY = 0.75;
const STORYBOARD_COMPRESSION_CONCURRENCY = 3;

type StoryboardPlan = { prompt: string; references: ReferenceImage[] };
export type StoryboardAssetInput = { canvasLabel: string; reference: ReferenceImage };
export type StoryboardCompileStage = "compressing" | "planning";
type StoryboardCompileOptions = { signal?: AbortSignal; onStage?: (phase: StoryboardCompileStage, detail: string) => void };

export function isStoryboardNode(node: CanvasNodeData) {
    return node.type === "image" && node.metadata?.hidden === true && Boolean(node.metadata.storyboardSourceNodeId);
}

export function storyboardNodesFor(sourceNodeId: string, nodes: CanvasNodeData[]) {
    return nodes
        .filter((node) => isStoryboardNode(node) && node.metadata?.storyboardSourceNodeId === sourceNodeId)
        .sort((a, b) => (a.metadata?.storyboardIndex || 0) - (b.metadata?.storyboardIndex || 0));
}

export function mentionedStoryboardReferences(prompt: string, references: CanvasResourceReference[]) {
    const images = references.filter((reference) => reference.active && reference.kind === "image");
    const labels = mentionedReferenceLabels(
        prompt,
        images.map((reference) => reference.label),
    );
    return images.filter((reference) => labels.has(reference.label));
}

export async function compileKinStoryboardPlan(config: AiConfig, videoPrompt: string, assets: StoryboardAssetInput[], aspectRatio: string, options: StoryboardCompileOptions = {}): Promise<StoryboardPlan> {
    const { signal, onStage } = options;
    const plannerModel = resolveStoryboardPlannerModel(config);
    if (!plannerModel) throw new Error("未配置可用于故事板理解的大语言模型");
    const plannerLabel = modelOptionLabel(config, plannerModel);
    const plannerRequestConfig = resolveModelRequestConfig(config, plannerModel);
    if (!plannerRequestConfig.baseUrl.trim() || !plannerRequestConfig.apiKey.trim()) throw new Error(`故事板大模型 ${plannerLabel} 尚未配置接口地址或 API Key`);
    if (assets.length + 1 > MAX_STORYBOARD_REFERENCES) throw new Error(`故事板最多支持 ${MAX_STORYBOARD_REFERENCES - 1} 张引用资产，请减少 @ 引用后重试`);

    const styleDataUrl = await imageToDataUrl({ url: STORYBOARD_STYLE_URL });
    if (!styleDataUrl.startsWith("data:image/")) throw new Error("KIN 故事板风格图读取失败");
    const styleReference: ReferenceImage = { id: "kin-storyboard-style", name: "KIN故事板风格图.png", type: "image/png", dataUrl: styleDataUrl };
    const sourceReferences = [styleReference, ...assets.map((asset) => asset.reference)];
    onStage?.("compressing", `正在压缩 0/${sourceReferences.length} 张参考图`);
    const references = await compressStoryboardReferences(sourceReferences, signal, (completed) => onStage?.("compressing", `正在压缩 ${completed}/${sourceReferences.length} 张参考图`));
    const mapping = [
        "Image 1＝KIN 故事板风格图＝用途：只锁定画风、宫格排版、中文信息块和彩色制作标记，不继承示例剧情",
        ...assets.map((asset, index) => `Image ${index + 2}＝画布引用标签“${asset.canvasLabel}”＝用途：只锁定原视频提示词中“${asset.canvasLabel}”所指对象的身份、外观或结构；参考文件名“${asset.reference.name || `引用资产${index + 1}`}”，不得扩展用途或带入图中剧情`),
    ].join("\n");
    const content: Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }> = [
        {
            type: "text",
            text: [
                "【画幅比例】",
                aspectRatio || "16:9",
                "编号解释（最高优先级）：原封视频提示词中的“图片1”“图片2”等文字是画布引用标签，不是本次多模态请求的 Image 1、Image 2 序号。必须先按下方映射解析画布标签，严禁直接把“图片N”理解为 Image N。",
                "【Image N＝画布引用标签＝用途映射】",
                mapping,
                "【完整视频提示词】",
                videoPrompt,
                "请严格按 Skill 输出协议返回 JSON。",
            ].join("\n\n"),
        },
        ...references.map((reference) => ({ type: "image_url" as const, image_url: { url: reference.dataUrl } })),
    ];
    onStage?.("planning", `${plannerLabel} 正在理解 ${references.length} 张参考图`);
    const plannerConfig = { ...buildGenerationConfig(config, undefined, "text"), model: plannerModel, systemPrompt: "" };
    const response = await requestImageQuestion(plannerConfig, [{ role: "system", content: kinStoryboardSkill }, { role: "user", content }], () => undefined, { signal });
    const result = parsePlannerResponse(response, plannerLabel);
    if (result.status === "blocked") throw new Error(result.message || "当前提示词无法安全编译为故事板");
    if (!result.prompt?.trim()) throw new Error(`${plannerLabel} 未返回有效的故事板生图提示词`);
    return { prompt: result.prompt.trim(), references };
}

async function compressStoryboardReferences(references: ReferenceImage[], signal?: AbortSignal, onProgress?: (completed: number) => void) {
    const compressed: ReferenceImage[] = [];
    for (let index = 0; index < references.length; index += STORYBOARD_COMPRESSION_CONCURRENCY) {
        if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
        const batch = references.slice(index, index + STORYBOARD_COMPRESSION_CONCURRENCY);
        compressed.push(...(await Promise.all(batch.map((reference) => compressStoryboardReference(reference, signal)))));
        onProgress?.(compressed.length);
    }
    return compressed;
}

async function compressStoryboardReference(reference: ReferenceImage, signal?: AbortSignal): Promise<ReferenceImage> {
    try {
        const sourceDataUrl = await imageToDataUrl(reference);
        if (!sourceDataUrl.startsWith("data:image/")) throw new Error("无法读取图片内容");
        const sourceBlob = await fetch(sourceDataUrl, { signal }).then((response) => response.blob());
        const bitmap = await createImageBitmap(sourceBlob);
        try {
            const scale = Math.min(1, STORYBOARD_REFERENCE_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
            const width = Math.max(1, Math.round(bitmap.width * scale));
            const height = Math.max(1, Math.round(bitmap.height * scale));
            const canvas = document.createElement("canvas");
            canvas.width = width;
            canvas.height = height;
            const context = canvas.getContext("2d");
            if (!context) throw new Error("无法创建图片压缩画布");
            context.fillStyle = "#ffffff";
            context.fillRect(0, 0, width, height);
            context.drawImage(bitmap, 0, 0, width, height);
            const blob = await new Promise<Blob>((resolve, reject) => {
                canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("JPEG 编码失败"))), "image/jpeg", STORYBOARD_REFERENCE_JPEG_QUALITY);
            });
            return {
                ...reference,
                name: `${reference.name.replace(/\.[^.]+$/, "") || "故事板参考图"}.jpg`,
                type: "image/jpeg",
                dataUrl: await blobToDataUrl(blob),
                url: undefined,
                storageKey: undefined,
            };
        } finally {
            bitmap.close();
        }
    } catch (error) {
        if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
        throw new Error(`故事板参考图压缩失败：${reference.name || reference.id}（${error instanceof Error ? error.message : "未知错误"}）`);
    }
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error("压缩图片读取失败"));
        reader.readAsDataURL(blob);
    });
}

export function resolveStoryboardPlannerModel(config: AiConfig) {
    const options = selectableModelsByCapability(config, "text");
    return options.includes(config.textModel) ? config.textModel : options[0] || "";
}

function parsePlannerResponse(value: string, modelLabel: string): { status: "ready" | "blocked"; prompt?: string; message?: string } {
    const source = value.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    try {
        const parsed = JSON.parse(source) as { status?: unknown; prompt?: unknown; message?: unknown };
        if (parsed.status === "ready") return { status: "ready", prompt: String(parsed.prompt || "") };
        if (parsed.status === "blocked") return { status: "blocked", message: String(parsed.message || "") };
    } catch {}
    throw new Error(`${modelLabel} 返回的故事板计划格式无效`);
}

import type { CanvasProject } from "@/stores/canvas/use-canvas-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { CinePackAsset, CinePackDocument, CinePackShot } from "@/types/cinepack";

/**
 * CinePack 视频 Prompt 的画布生成层。
 * 包内不含 Seedance 视频词字段；导入时用本文件确定性占位，导入后由
 * 默认 `$h3-prompt-writing`（Seedance 需显式选择）按已有 shotGroupId 编译覆盖 kind=shot 派生 Prompt。
 */
export const CINEPACK_VIDEO_PROMPT_TARGET_CHARS = 1600;

const VIDEO_CONTINUITY = "连续性：以已连接的故事板和参考图为准，保持人物、服装、场景、道具、色彩与光线一致；只表现当前镜头的连续动作。";
const VIDEO_OUTPUT_RULES = "画面要求：彩色电影画面，动作自然，主体清晰；不要字幕、文字、水印、边框、分屏或宫格。";

export type CinePackVideoPromptReferences = {
    storyboardNodeId?: string;
    assetNodeIds?: Record<string, string>;
};

export function buildCinePackVideoPrompt(shot: CinePackShot, document: CinePackDocument, references: CinePackVideoPromptReferences = {}) {
    const assetById = new Map(document.assets.map((asset) => [asset.assetId, asset]));
    const assets = [...shot.assetRefs.characterIds, ...shot.assetRefs.sceneIds, ...shot.assetRefs.propIds]
        .map((assetId) => assetById.get(assetId))
        .filter((asset): asset is CinePackAsset => Boolean(asset));
    const assetMentions = assets.map((asset) => {
        const nodeId = references.assetNodeIds?.[asset.assetId];
        const variantId = shot.assetRefs.variantBindings?.[asset.assetId];
        const variantName = variantId ? asset.variants.find((variant) => variant.id === variantId)?.name : "";
        const label = `${assetTypeLabel(asset.type)}：${asset.name}${variantName ? ` · ${variantName}` : ""}`;
        return nodeId ? `${nodeMention(nodeId)}（${label}）` : `${asset.name}（${label}）`;
    });
    const style = document.visualStyle;
    const styleParts = [document.project.medium || style.medium, document.project.tone, style.palette.join("、"), style.lightingRules.slice(0, 2).join("；"), style.cameraRules.slice(0, 2).join("；")].map(normalizeText).filter(Boolean);
    return fitVideoPrompt([
        `镜头：${shot.number} · ${shot.title}`,
        shot.duration ? `时长：${shot.duration}` : "",
        references.storyboardNodeId ? `镜头锚点：${nodeMention(references.storyboardNodeId)}（已选故事板）` : "",
        assetMentions.length ? `主体与场景：${assetMentions.join("、")}` : "",
        shot.story ? `画面与动作：${shot.story}` : "",
        shot.notes ? `镜头与节奏：${shot.notes}` : "",
        VIDEO_CONTINUITY,
        styleParts.length ? `视觉基调：${styleParts.join("；")}` : "",
        VIDEO_OUTPUT_RULES,
    ]);
}

/**
 * 将旧版 CinePack 导入结果迁移到轻量节点结构：移除空图片占位、修复旧失败节点，
 * 并恢复故事板/资产到视频节点的语义连线。镜头说明文本节点只保留在画布上供阅读，
 * 不再连入视频节点，生成层只按 @ 解析故事板和参考图。
 */
export function repairCinePackVideoPrompts(projects: CanvasProject[]) {
    let projectsChanged = false;
    const nextProjects = projects.map((project) => {
        const promptNodesByShotId = new Map(project.nodes.filter((node) => node.metadata?.cinepack?.kind === "prompt" && node.metadata.cinepack.shotId).map((node) => [node.metadata!.cinepack!.shotId!, node]));
        const storyboardNodesByShotId = new Map(project.nodes.filter((node) => node.metadata?.cinepack?.kind === "storyboard" && node.metadata.cinepack.shotId).map((node) => [node.metadata!.cinepack!.shotId!, node]));
        const assetNodesByStableId = new Map(project.nodes.filter((node) => node.metadata?.cinepack?.kind === "asset" && node.metadata.cinepack.assetId).map((node) => [node.metadata!.cinepack!.assetId!, node]));
        let nodesChanged = false;
        const repairedNodes = project.nodes.map((node) => {
            if (!isCinePackVideoShotNode(node)) return node;
            const lostCinePackMetadata = node.metadata?.cinepack?.kind !== "shot";
            const shotId = cinePackVideoShotId(node);
            const sourceNode = shotId ? promptNodesByShotId.get(shotId) : undefined;
            const sourceCinePack = sourceNode?.metadata?.cinepack;
            const preferred = storedPreferredCinePackVideoPrompt(node);
            let prompt = preferred;
            if (preferred && !isLegacyStoryboardPrompt(preferred)) {
                prompt = preferred;
            } else {
                const sourceSummary = firstSummaryBlock(sourceNode?.metadata?.content || sourceNode?.metadata?.prompt || "");
                prompt = fitVideoPrompt([sourceSummary || `镜头：${node.title}`, VIDEO_CONTINUITY, VIDEO_OUTPUT_RULES]);
            }
            const storyboardNodeId = shotId ? storyboardNodesByShotId.get(shotId)?.id : undefined;
            const assetNodes = (node.metadata?.cinepack?.assetRefIds || sourceCinePack?.assetRefIds || []).map((assetId) => assetNodesByStableId.get(assetId)).filter((asset): asset is CanvasNodeData => Boolean(asset));
            prompt = applyCinePackVideoMentions(prompt, storyboardNodeId, assetNodes);
            const recoveredCinePack = lostCinePackMetadata && sourceCinePack ? { ...sourceCinePack, kind: "shot" as const } : node.metadata?.cinepack;
            const recoveredTitle = lostCinePackMetadata ? shotTitleFromSummary(sourceNode?.metadata?.content || "") || node.title : node.title;
            const nextMetadata = {
                ...node.metadata,
                prompt,
                composerContent: prompt,
                generationMode: "video" as const,
                cinepack: recoveredCinePack,
                ...(lostCinePackMetadata
                    ? {
                          status: "idle" as const,
                          errorDetails: undefined,
                          generationJobId: undefined,
                          generationPhase: undefined,
                          generationProgress: undefined,
                          references: undefined,
                      }
                    : {}),
            };
            if (node.title === recoveredTitle && node.metadata?.prompt === prompt && node.metadata?.composerContent === prompt && node.metadata?.cinepack === recoveredCinePack && !lostCinePackMetadata) return node;
            nodesChanged = true;
            return { ...node, title: recoveredTitle, metadata: nextMetadata } as CanvasNodeData;
        });

        const obsoleteImageIds = new Set(repairedNodes.filter((node) => node.metadata?.cinepack?.kind === "image-generation" && !node.metadata.content).map((node) => node.id));
        const nodes = repairedNodes
            .filter((node) => !obsoleteImageIds.has(node.id))
            .map((node) => {
                if (node.metadata?.cinepack?.kind === "shot-group" && node.width > 1120) {
                    nodesChanged = true;
                    return { ...node, width: 1120 };
                }
                if (isCinePackVideoShotNode(node) && node.position && node.position.x !== 750) {
                    nodesChanged = true;
                    return { ...node, position: { ...node.position, x: 750 } };
                }
                return node;
            });
        if (obsoleteImageIds.size) nodesChanged = true;

        const nodeById = new Map(nodes.map((node) => [node.id, node]));
        const promptNodeIds = new Set(nodes.filter(isCinePackShotPromptNode).map((node) => node.id));
        const storyboardIdByShotId = new Map(nodes.filter((node) => node.metadata?.cinepack?.kind === "storyboard" && node.metadata.cinepack.shotId).map((node) => [node.metadata!.cinepack!.shotId!, node.id]));
        const assetIdByStableId = new Map(nodes.filter((node) => node.metadata?.cinepack?.kind === "asset" && node.metadata.cinepack.assetId).map((node) => [node.metadata!.cinepack!.assetId!, node.id]));
        const previousConnections = project.connections || [];
        const connections = previousConnections.filter((connection) => {
            if (obsoleteImageIds.has(connection.fromNodeId) || obsoleteImageIds.has(connection.toNodeId)) return false;
            const target = nodeById.get(connection.toNodeId);
            if (target && isCinePackVideoShotNode(target) && promptNodeIds.has(connection.fromNodeId)) return false;
            return true;
        });
        if (connections.length !== previousConnections.length) nodesChanged = true;

        const connectionKeys = new Set(connections.map((connection) => `${connection.fromNodeId}->${connection.toNodeId}`));
        const addSemanticConnection = (fromNodeId: string | undefined, toNodeId: string, projectId: string) => {
            if (!fromNodeId || !nodeById.has(fromNodeId)) return;
            const key = `${fromNodeId}->${toNodeId}`;
            if (connectionKeys.has(key)) return;
            connectionKeys.add(key);
            connections.push({ id: cinePackConnectionId(projectId, key), fromNodeId, toNodeId });
            nodesChanged = true;
        };
        nodes.filter(isCinePackVideoShotNode).forEach((shotNode) => {
            const shotId = cinePackVideoShotId(shotNode);
            const cinepack = shotNode.metadata?.cinepack;
            const projectId = cinepack?.projectId;
            if (!shotId || !projectId) return;
            addSemanticConnection(storyboardIdByShotId.get(shotId), shotNode.id, projectId);
            cinepack.assetRefIds?.forEach((assetId) => addSemanticConnection(assetIdByStableId.get(assetId), shotNode.id, projectId));
        });

        if (!nodesChanged) return project;
        projectsChanged = true;
        return { ...project, nodes, connections };
    });
    return projectsChanged ? nextProjects : projects;
}

/**
 * 旧版编辑器可能只更新 prompt、遗留故事板母 Prompt。两者冲突时优先保留
 * 真正的视频 Prompt；不再根据长度压缩或丢弃用户手动编辑的长提示词。
 */
export function preferredCinePackVideoPrompt(node: CanvasNodeData) {
    return fitCinePackVideoPrompt(storedPreferredCinePackVideoPrompt(node), node.title);
}

function storedPreferredCinePackVideoPrompt(node: CanvasNodeData) {
    const prompt = node.metadata?.prompt || "";
    const composer = node.metadata?.composerContent || "";
    const promptIsLegacyStoryboard = isLegacyStoryboardPrompt(prompt);
    const composerIsLegacyStoryboard = isLegacyStoryboardPrompt(composer);
    if (prompt && !promptIsLegacyStoryboard && composerIsLegacyStoryboard) return prompt;
    if (composer && !composerIsLegacyStoryboard && promptIsLegacyStoryboard) return composer;
    return composer || prompt;
}

/** 保持旧调用点兼容；生成前只清理首尾空白，不再压缩用户提示词。 */
export function fitCinePackVideoPrompt(value: string, _title = "") {
    const prompt = String(value || "").trim();
    return prompt;
}

/** 兼容早期生成失败时 metadata.cinepack 被覆盖、但稳定节点 ID 仍保留的存档。 */
export function isCinePackVideoShotNode(node: CanvasNodeData) {
    return node.type === CanvasNodeType.Video && (node.metadata?.cinepack?.kind === "shot" || /^cinepack:.+:shot:.+/.test(node.id));
}

/** 镜头说明文本：只供画布阅读，不是视频生成输入。 */
export function isCinePackShotPromptNode(node: CanvasNodeData) {
    return node.type === CanvasNodeType.Text && node.metadata?.cinepack?.kind === "prompt";
}

export function cinePackVideoShotId(node: CanvasNodeData) {
    if (!isCinePackVideoShotNode(node)) return "";
    return node.metadata?.cinepack?.shotId || node.id.match(/:shot:(.+)$/)?.[1] || "";
}

function cinePackConnectionId(projectId: string, key: string) {
    return `cinepack:${encodeURIComponent(projectId)}:connection:${encodeURIComponent(key)}`;
}

function fitVideoPrompt(sections: string[], maxChars = CINEPACK_VIDEO_PROMPT_TARGET_CHARS) {
    const fitted = sections.map(normalizeText).filter(Boolean);
    let total = fitted.reduce((sum, section) => sum + promptLength(section), Math.max(0, fitted.length - 1));
    while (total > maxChars) {
        const candidates = fitted.map((section, index) => ({ section, index })).filter(({ section }) => !section.includes("@[node:"));
        if (!candidates.length) break;
        const index = candidates.reduce((longest, current) => (promptLength(current.section) > promptLength(longest.section) ? current : longest)).index;
        const currentLength = promptLength(fitted[index]);
        const minimumLength = Math.min(80, currentLength);
        const removable = currentLength - minimumLength;
        if (removable <= 0) break;
        const nextLength = currentLength - Math.min(total - maxChars, removable);
        fitted[index] = truncateText(fitted[index], nextLength);
        total = fitted.reduce((sum, section) => sum + promptLength(section), Math.max(0, fitted.length - 1));
    }
    const result = fitted.join("\n");
    // 稳定 @ token 不允许被截成半个 ID；极端情况下宁可由提交前上限校验明确提示。
    return promptLength(result) > maxChars && result.includes("@[node:") ? result : truncateText(result, maxChars);
}

function firstSummaryBlock(value: string) {
    return normalizeText(value.split(/\r?\n\s*\r?\n/, 1)[0] || "");
}

function shotTitleFromSummary(value: string) {
    const firstLine = String(value || "")
        .split(/\r?\n/, 1)[0]
        ?.trim();
    return firstLine?.match(/^镜头[：:]\s*(.+)$/)?.[1] ? `镜头 ${firstLine.match(/^镜头[：:]\s*(.+)$/)![1]}` : "";
}

function normalizeText(value: string) {
    return String(value || "")
        .replace(/\s+/g, " ")
        .trim();
}

function truncateText(value: string, maxChars: number) {
    const chars = [...value];
    if (chars.length <= maxChars) return value;
    if (maxChars <= 1) return chars.slice(0, maxChars).join("");
    return `${chars.slice(0, maxChars - 1).join("")}…`;
}

function promptLength(value?: string) {
    return [...(value || "")].length;
}

function assetTypeLabel(type: CinePackAsset["type"]) {
    if (type === "character") return "角色";
    if (type === "scene") return "场景";
    return "物品";
}

function applyCinePackVideoMentions(prompt: string, storyboardNodeId: string | undefined, assets: CanvasNodeData[]) {
    const referenceLines = [
        storyboardNodeId ? `镜头锚点：${nodeMention(storyboardNodeId)}（已选故事板）` : "",
        assets.length
            ? `主体与场景：${assets
                  .map((asset) => `${nodeMention(asset.id)}（${assetTypeLabelFromNode(asset)}：${asset.title.replace(/^(角色|场景|物品)\s*·\s*/, "")}）`)
                  .join("、")}`
            : "",
    ].filter(Boolean);
    if (!referenceLines.length) return prompt;
    const lines = prompt
        .split(/\r?\n/)
        .filter((line) => !/^\s*(镜头锚点|主体与场景)[：:]/.test(line));
    const insertAt = Math.max(1, lines.findIndex((line) => /^\s*时长[：:]/.test(line)) + 1);
    lines.splice(insertAt, 0, ...referenceLines);
    return lines.join("\n").trim();
}

function isLegacyStoryboardPrompt(value: string) {
    return /^\s*(?:六宫格故事板[：:]|(?:旧版超长)?故事板母提示词[。 ：:])/.test(value);
}

function nodeMention(nodeId: string) {
    return `@[node:${nodeId}]`;
}

function assetTypeLabelFromNode(node: CanvasNodeData) {
    const type = node.metadata?.cinepack?.assetType;
    if (type === "character") return "角色";
    if (type === "scene") return "场景";
    return "物品";
}

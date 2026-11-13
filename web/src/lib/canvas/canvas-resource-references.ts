import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import i18n from "@/i18n";
import { seedanceReferenceLabel } from "@/lib/seedance-video";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { cinePackBoundCharacterReference } from "@/lib/canvas/cinepack-character-looks";
import { isCinePackShotPromptNode, isCinePackVideoShotNode } from "@/lib/canvas/cinepack-video-prompt";
import { getDataUrlByteSize, readImageMeta } from "@/lib/image-utils";
import { imageToDataUrl } from "@/services/image-storage";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

export type CanvasResourceKind = "image" | "video" | "audio" | "text";

export type CanvasResourceReference = {
    id: string;
    nodeId: string;
    kind: CanvasResourceKind;
    label: string;
    title: string;
    previewUrl?: string;
    storageKey?: string;
    text?: string;
    active: boolean;
    /** 指向该资产的画布连线；无连线（如自身节点）时不可断开 */
    connectionId?: string;
};

export function buildNodeMentionReferences(node: CanvasNodeData, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const entries = getMentionResourceEntries(node.id, nodes, connections);
    if (node.metadata?.cinepack?.kind !== "shot") return labelResourceEntries(entries, true);

    // CinePack serializes exact visual references as stable node IDs. A project can be
    // opened before its legacy semantic connections are repaired; resolve those tokens
    // directly so the editor never exposes internal IDs in the meantime.
    const seen = new Set(entries.map((entry) => entry.node.id));
    const nodesById = new Map(nodes.map((item) => [item.id, item]));
    const prompt = node.metadata?.composerContent || node.metadata?.prompt || "";
    for (const match of prompt.matchAll(/@\[node:([^\]]+)\]/g)) {
        const referencedNode = nodesById.get(match[1]);
        if (!referencedNode || seen.has(referencedNode.id) || !isResourceNode(referencedNode)) continue;
        if (isCinePackShotPromptNode(referencedNode)) continue;
        if (referencedNode.metadata?.cinepack?.projectId !== node.metadata.cinepack.projectId) continue;
        seen.add(referencedNode.id);
        entries.push({ node: referencedNode });
    }
    return labelResourceEntries(entries, true, node);
}

export function buildCanvasResourceReferences(nodes: CanvasNodeData[]) {
    return labelResourceNodes(nodes, true);
}

export async function resolveCanvasReferenceImages(references: CanvasResourceReference[], nodes: CanvasNodeData[]) {
    const nodesById = new Map(nodes.map((node) => [node.id, node]));
    return Promise.all(references.filter((reference) => reference.kind === "image").map(async (reference) => {
        const node = nodesById.get(reference.nodeId);
        if (!node) throw new Error(i18n.t("agent.composer.mentions.resourceMissing", { title: reference.title }));
        const metadata = node.metadata;
        const dataUrl = await imageToDataUrl({ storageKey: reference.storageKey ?? metadata?.storageKey, url: reference.previewUrl });
        if (!dataUrl.startsWith("data:image/")) throw new Error(i18n.t("agent.composer.mentions.imageReadFailed", { title: reference.title }));
        const meta = metadata?.naturalWidth && metadata.naturalHeight
            ? { width: metadata.naturalWidth, height: metadata.naturalHeight, mimeType: metadata.mimeType || dataUrl.match(/^data:([^;]+)/)?.[1] || "image/png" }
            : await readImageMeta(dataUrl);
        return {
            id: `canvas:${node.id}`,
            name: reference.title,
            type: metadata?.mimeType || meta.mimeType,
            size: metadata?.bytes || getDataUrlByteSize(dataUrl),
            width: meta.width,
            height: meta.height,
            url: reference.previewUrl || dataUrl,
            dataUrl,
        };
    }));
}

export function getMentionResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    return getMentionResourceEntries(nodeId, nodes, connections).map((entry) => entry.node);
}

export function getGenerationResourceNodes(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    const configInputs = getConnectedConfigResourceEntries(nodeId, nodes, connections);
    if (configInputs.length) return configInputs.map((entry) => entry.node);
    const ownInputs = getContextResourceEntries(nodeId, nodes, connections);
    if (ownInputs.length) return ownInputs.map((entry) => entry.node);
    return [];
}

type ResourceEntry = { node: CanvasNodeData; connectionId?: string };

function getMentionResourceEntries(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): ResourceEntry[] {
    const configInputs = getConnectedConfigResourceEntries(nodeId, nodes, connections);
    if (configInputs.length) return configInputs;
    const ownInputs = getContextResourceEntries(nodeId, nodes, connections);
    if (ownInputs.length) return ownInputs;
    // 不再回退显示自己，避免在未连接其他节点时错误显示自身
    return [];
}

function getContextResourceEntries(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): ResourceEntry[] {
    const target = nodes.find((item) => item.id === nodeId);
    return connections.flatMap((connection) => {
        if (connection.toNodeId !== nodeId) return [];
        const node = nodes.find((item) => item.id === connection.fromNodeId);
        if (!node || !isResourceNode(node)) return [];
        if (target && isCinePackVideoShotNode(target) && isCinePackShotPromptNode(node)) return [];
        return [{ node, connectionId: connection.id }];
    });
}

function getConnectedConfigResourceEntries(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]): ResourceEntry[] {
    const configConnection = connections.find((connection) => connection.fromNodeId === nodeId && nodes.find((item) => item.id === connection.toNodeId)?.type === CanvasNodeType.Config);
    if (!configConnection) return [];
    return getContextResourceEntries(configConnection.toNodeId, nodes, connections).filter((entry) => entry.node.id !== nodeId);
}

/** The destination that actually supplies this node's generation inputs. */
export function generationReferenceTarget(nodeId: string, nodes: CanvasNodeData[], connections: CanvasConnection[]) {
    if (!getConnectedConfigResourceEntries(nodeId, nodes, connections).length) return nodeId;
    return connections.find((edge) => edge.fromNodeId === nodeId && nodes.some((node) => node.id === edge.toNodeId && node.type === CanvasNodeType.Config))!.toNodeId;
}

function labelResourceNodes(nodes: CanvasNodeData[], active: boolean) {
    return labelResourceEntries(
        nodes.map((node) => ({ node })),
        active,
    );
}

function labelResourceEntries(entries: ResourceEntry[], active: boolean, targetNode?: CanvasNodeData) {
    const counts: Record<CanvasResourceKind, number> = { image: 0, video: 0, audio: 0, text: 0 };
    return entries.flatMap(({ node, connectionId }): CanvasResourceReference[] => {
        const kind = resourceKind(node);
        if (!kind) return [];
        const resource = getNodeDefinition(node.type)?.resource?.(node);
        const characterReference = cinePackBoundCharacterReference(targetNode, node);
        const index = counts[kind]++;
        const label = labelForKind(kind, index);
        return [
            {
                id: node.id,
                nodeId: node.id,
                kind,
                label,
                title: characterReference ? `${node.title || label} · ${characterReference.name}` : node.title || label,
                previewUrl: characterReference ? characterReference.dataUrl : node.metadata?.content || resource?.url,
                storageKey: characterReference ? characterReference.storageKey || "" : node.metadata?.storageKey,
                text: resourceText(node),
                active,
                connectionId,
            },
        ];
    });
}

function labelForKind(kind: CanvasResourceKind, index: number) {
    if (kind === "image") return imageReferenceLabel(index);
    if (kind === "video") return seedanceReferenceLabel("video", index);
    if (kind === "audio") return seedanceReferenceLabel("audio", index);
    return i18n.t("canvas.composer.resources.text", { index: index + 1 });
}

function isResourceNode(node: CanvasNodeData) {
    return Boolean(resourceKind(node));
}

function resourceText(node: CanvasNodeData): string | undefined {
    if (node.type === CanvasNodeType.Text) return node.metadata?.content || node.metadata?.prompt;
    const resource = getNodeDefinition(node.type)?.resource?.(node);
    return resource?.kind === "text" ? resource.text : undefined;
}

function resourceKind(node: CanvasNodeData): CanvasResourceKind | null {
    if (node.type === CanvasNodeType.Image && node.metadata?.content) return "image";
    if (node.type === CanvasNodeType.Video && node.metadata?.content) return "video";
    if (node.type === CanvasNodeType.Audio && node.metadata?.content) return "audio";
    if (node.type === CanvasNodeType.Text && (node.metadata?.content || node.metadata?.prompt)) return "text";
    // Plugin nodes declare their input eligibility through definition.resource.
    return getNodeDefinition(node.type)?.resource?.(node)?.kind || null;
}

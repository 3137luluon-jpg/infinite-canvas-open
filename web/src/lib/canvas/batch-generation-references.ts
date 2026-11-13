import { nanoid } from "nanoid";
import { buildNodeMentionReferences, generationReferenceTarget } from "@/lib/canvas/canvas-resource-references";
import { CanvasNodeType, type CanvasConnection, type CanvasNodeData } from "@/types/canvas";

export function marqueeSelectsNode(node: CanvasNodeData, rect: { x: number; y: number; width: number; height: number }) {
    if (rect.width <= 0 || rect.height <= 0) return false;
    if (node.metadata?.hidden || node.metadata?.storyboardSourceNodeId) return false;
    const intersects = rect.x < node.position.x + node.width && rect.x + rect.width > node.position.x && rect.y < node.position.y + node.height && rect.y + rect.height > node.position.y;
    if (node.type !== CanvasNodeType.Group) return intersects;
    return intersects && rect.x <= node.position.x && rect.y <= node.position.y && rect.x + rect.width >= node.position.x + node.width && rect.y + rect.height >= node.position.y + node.height;
}

/** Selection order is deliberately irrelevant. Canvas positions are absolute, including grouped nodes. */
export function selectedReferenceImages(nodes: CanvasNodeData[], selectedIds: ReadonlySet<string>) {
    return selectedReferenceResources(nodes, selectedIds).filter((node) => node.type === CanvasNodeType.Image);
}

export function selectedReferenceResources(nodes: CanvasNodeData[], selectedIds: ReadonlySet<string>) {
    const ids = new Set(selectedIds);
    let changed = true;
    while (changed) {
        changed = false;
        for (const node of nodes) {
            if (node.metadata?.hidden || !node.metadata?.groupId || ids.has(node.id)) continue;
            const parent = nodes.find((item) => item.id === node.metadata?.groupId);
            if (parent?.type === CanvasNodeType.Group && ids.has(parent.id)) {
                ids.add(node.id);
                changed = true;
            }
        }
    }
    return nodes.filter((node) => ids.has(node.id) && [CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio, CanvasNodeType.Text].includes(node.type as CanvasNodeType) && !node.metadata?.hidden && !node.metadata?.storyboardSourceNodeId && Boolean(node.metadata?.content))
        .sort((a, b) => a.position.x - b.position.x || a.position.y - b.position.y || a.id.localeCompare(b.id));
}

/** Append once in the preview order. Never re-sort existing references or mutate input arrays. */
export function appendGenerationReferences(nodes: CanvasNodeData[], connections: CanvasConnection[], nodeId: string, imageIds: string[]) {
    const target = nodes.find((node) => node.id === nodeId && (node.type === CanvasNodeType.Video || node.type === CanvasNodeType.Image) && !node.metadata?.hidden);
    if (!target) throw new Error("请选择一个图片或视频节点");
    if (imageIds.includes(nodeId)) throw new Error("目标图片不能同时作为参考图，请选择其他图片节点，或新建图片并连接");
    const targetId = generationReferenceTarget(nodeId, nodes, connections);
    if (targetId !== nodeId && connections.some((edge) => edge.toNodeId === targetId && edge.fromNodeId !== nodeId && nodes.some((node) => node.id === edge.fromNodeId && node.type === CanvasNodeType.Video))) throw new Error("此节点共用配置，请先使用独立配置，避免改变其他节点的参考素材");
    const existing = new Set(connections.filter((edge) => edge.toNodeId === targetId).map((edge) => edge.fromNodeId));
    const additions: CanvasConnection[] = [];
    // A reference must not make the target depend on its own downstream output.
    const reachable = new Set([targetId, nodeId]);
    let changed = true;
    while (changed) {
        changed = false;
        for (const edge of connections) {
            if (reachable.has(edge.fromNodeId) && !reachable.has(edge.toNodeId)) { reachable.add(edge.toNodeId); changed = true; }
        }
    }
    for (const id of imageIds) {
        const image = nodes.find((node) => node.id === id);
        if (!image || ![CanvasNodeType.Image, CanvasNodeType.Video, CanvasNodeType.Audio, CanvasNodeType.Text].includes(image.type as CanvasNodeType) || image.metadata?.hidden || !image.metadata?.content) throw new Error("所选素材已删除或暂无内容，请重新选择");
        if (target.type === CanvasNodeType.Image && (image.type === CanvasNodeType.Video || image.type === CanvasNodeType.Audio)) throw new Error("生图参考支持图片和文本；视频或音频素材请选择视频节点");
        if (existing.has(id)) continue;
        if (reachable.has(id)) throw new Error("此连接会形成循环引用，请选择其他参考图");
        existing.add(id);
        additions.push({ id: nanoid(), fromNodeId: id, toNodeId: targetId });
    }
    return { connections: additions.length ? [...connections, ...additions] : connections, added: additions.length, skipped: imageIds.length - additions.length, targetId };
}

/** Reorder only the selected destination's input edges; preserve numbered mentions by asset identity. */
export function reorderGenerationReferences(nodes: CanvasNodeData[], connections: CanvasConnection[], nodeId: string, orderedIds: string[]) {
    const node = nodes.find((item) => item.id === nodeId);
    if (!node || node.metadata?.status === "loading") throw new Error("生成中暂不能调整参考顺序");
    const targetId = generationReferenceTarget(nodeId, nodes, connections);
    if (targetId !== nodeId && connections.some((edge) => edge.toNodeId === targetId && edge.fromNodeId !== nodeId && nodes.some((item) => item.id === edge.fromNodeId && [CanvasNodeType.Image, CanvasNodeType.Video].includes(item.type as CanvasNodeType)))) throw new Error("此节点共用配置，请先使用独立配置再调整参考顺序");
    const before = buildNodeMentionReferences(node, nodes, connections).filter((item) => item.connectionId);
    if (!before.length) throw new Error("暂无可排序的参考素材");
    if (orderedIds.length !== before.length || new Set(orderedIds).size !== before.length || orderedIds.some((id) => !before.some((item) => item.id === id))) throw new Error("参考素材已变化，请重新排序");
    const byId = new Map(before.map((item) => [item.id, connections.find((edge) => edge.id === item.connectionId)!]));
    const edgeIds = new Set(before.map((item) => item.connectionId));
    let index = 0;
    const nextConnections = connections.map((edge) => edgeIds.has(edge.id) ? byId.get(orderedIds[index++])! : edge);
    const after = buildNodeMentionReferences(node, nodes, nextConnections);
    const labels = new Map(before.map((item) => [item.label, after.find((next) => next.id === item.id)?.label || item.label]));
    const pattern = new RegExp("(?:" + [...labels.keys()].sort((a, b) => b.length - a.length).map((label) => label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")(?!\\d)", "g");
    const remap = (prompt?: string) => prompt?.replace(pattern, (label) => labels.get(label) || label);
    return {
        connections: nextConnections,
        nodes: nodes.map((item) => item.id === nodeId ? { ...item, metadata: { ...item.metadata, prompt: remap(item.metadata?.prompt), composerContent: remap(item.metadata?.composerContent) } } : item),
    };
}

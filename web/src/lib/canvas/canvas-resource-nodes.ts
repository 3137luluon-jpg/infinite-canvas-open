import { CanvasNodeType, type CanvasNodeData } from "../../types/canvas.ts";

const builtinTypes = new Set<string>(Object.values(CanvasNodeType));

// Built-in mention resources read identity, title and metadata, never geometry.
// Custom plugin resources may inspect any field, so keep their invalidation exact.
export function reuseMentionResourceNodes(previous: CanvasNodeData[], next: CanvasNodeData[]) {
    if (previous.length !== next.length) return next;
    return next.every((node, i) => {
        const before = previous[i];
        return node === before || (builtinTypes.has(node.type) && before.id === node.id && before.type === node.type && before.title === node.title && before.metadata === node.metadata);
    }) ? previous : next;
}

import type { CanvasConnection, CanvasNodeData } from "@/types/canvas";

/** Turn completed batch slots into ordinary nodes so all existing image tools work per image. */
export function expandImageBatch(nodes: CanvasNodeData[], connections: CanvasConnection[], nodeId: string, createId: () => string) {
    const source = nodes.find((node) => node.id === nodeId);
    const images = source?.metadata?.images;
    if (!source || source.type !== "image" || !images || images.length < 2) return null;
    // Never detach slots that an in-flight generation still needs to update.
    if (source.metadata?.status === "loading" || images.some((image) => image.status === "loading" || image.status === "idle")) return null;
    const primary = images.find((image) => image.id === source.metadata?.primaryImageId) || images.find((image) => image.content) || images[0];
    const ordered = [primary, ...images.filter((image) => image.id !== primary.id)];
    const occupied = nodes.filter((node) => node.id !== nodeId && node.type !== "group" && !node.metadata?.hidden);
    const incoming = connections.filter((edge) => edge.toNodeId === nodeId);
    const additions: CanvasConnection[] = [];
    let nextX = source.position.x;
    const expanded = ordered.map((image, index): CanvasNodeData => {
        const id = index === 0 ? source.id : createId();
        const edge = Math.max(source.width, source.height);
        const ratio = image.naturalWidth > 0 && image.naturalHeight > 0 ? image.naturalWidth / image.naturalHeight : source.width / source.height;
        const width = index === 0 || source.metadata?.freeResize ? source.width : Math.round(ratio >= 1 ? edge : edge * ratio);
        const height = index === 0 || source.metadata?.freeResize ? source.height : Math.round(ratio >= 1 ? edge / ratio : edge);
        const y = source.position.y + (source.height - height) / 2;
        if (index > 0) {
            let collision: CanvasNodeData | undefined;
            while ((collision = occupied.find((node) => nextX < node.position.x + node.width + 18 && nextX + width + 18 > node.position.x && y < node.position.y + node.height + 18 && y + height + 18 > node.position.y))) {
                nextX = collision.position.x + collision.width + 18;
            }
            additions.push(...incoming.map((connection) => ({ ...connection, id: createId(), toNodeId: id })));
        }
        const node: CanvasNodeData = {
            ...source,
            id,
            title: index === 0 ? source.title : `${source.title || "图片"} · ${index + 1}`,
            position: index === 0 ? source.position : { x: nextX, y },
            width,
            height,
            metadata: {
                ...source.metadata,
                content: image.content,
                storageKey: image.storageKey,
                naturalWidth: image.naturalWidth,
                naturalHeight: image.naturalHeight,
                mimeType: image.mimeType,
                bytes: image.bytes,
                generationDurationMs: image.generationDurationMs,
                status: image.status,
                errorDetails: image.errorDetails,
                images: undefined,
                primaryImageId: undefined,
                count: 1,
                generationJobId: undefined,
                generationPhase: undefined,
                generationProgress: undefined,
                generationDetail: undefined,
                generationPhaseStartedAt: undefined,
            },
        };
        occupied.push(node);
        nextX = node.position.x + width + 18;
        return node;
    });
    return { nodes: nodes.flatMap((node) => node.id === nodeId ? expanded : [node]), connections: [...connections, ...additions] };
}

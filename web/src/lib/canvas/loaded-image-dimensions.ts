import type { CanvasNodeData } from "@/types/canvas";
import { fitNodeSize } from "./canvas-node-size.ts";

/** Correct old guessed metadata from the decoded asset, without changing its file or user resize. */
export function applyLoadedImageDimensions(node: CanvasNodeData, source: string, width: number, height: number): CanvasNodeData {
    if (node.type !== "image" || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return node;
    const metadata = node.metadata;
    const image = metadata?.images?.find((item) => item.content === source);
    const isPrimary = metadata?.content === source || Boolean(image && image.id === metadata?.primaryImageId);
    if (!image && !isPrimary) return node;
    const changedImage = Boolean(image && (image.naturalWidth !== width || image.naturalHeight !== height));
    const changedPrimary = isPrimary && (metadata?.naturalWidth !== width || metadata?.naturalHeight !== height);
    const edge = Math.max(node.width, node.height);
    const size = fitNodeSize(width, height, edge, edge);
    const resize = isPrimary && !metadata?.freeResize && (Math.abs(size.width - node.width) >= 1 || Math.abs(size.height - node.height) >= 1);
    if (!changedImage && !changedPrimary && !resize) return node;
    return {
        ...node,
        ...(resize ? { ...size, position: { x: node.position.x + (node.width - size.width) / 2, y: node.position.y + (node.height - size.height) / 2 } } : {}),
        metadata: {
            ...metadata,
            ...(isPrimary ? { naturalWidth: width, naturalHeight: height } : {}),
            ...(changedImage ? { images: metadata!.images!.map((item) => item.id === image!.id ? { ...item, naturalWidth: width, naturalHeight: height } : item) } : {}),
        },
    };
}

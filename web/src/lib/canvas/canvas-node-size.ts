/** 画布图片/视频统一长边（画布单位），同宽高比无论 480p/4K 显示一样大 */
export const MEDIA_NODE_LONG_EDGE = 340;

/** 按目标长边缩放，允许放大/缩小；同宽高比结果尺寸一致 */
export function fitNodeSize(width: number, height: number, maxWidth = MEDIA_NODE_LONG_EDGE, maxHeight = MEDIA_NODE_LONG_EDGE) {
    const w = Math.max(1, width);
    const h = Math.max(1, height);
    const target = Math.max(1, maxWidth, maxHeight);
    const scale = target / Math.max(w, h);
    return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

export function nodeSizeFromRatio(size: string, baseWidth: number, baseHeight: number) {
    const match = size?.match(/^(\d+)(?:x|:)(\d+)/);
    if (!match) return null;
    const width = Number(match[1]);
    const height = Number(match[2]);
    const ratio = width / Math.max(1, height);
    if (ratio < 0.25 || ratio > 4) return { width: baseWidth, height: baseHeight };
    const edge = Math.max(baseWidth, baseHeight);
    return ratio >= 1 ? { width: edge, height: Math.max(1, Math.round(edge / ratio)) } : { width: Math.max(1, Math.round(edge * ratio)), height: edge };
}

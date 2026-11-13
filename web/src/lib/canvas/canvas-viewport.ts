import type { ViewportTransform } from "../../types/canvas.ts";

export function zoomAtPointer(viewport: ViewportTransform, x: number, y: number, deltaY: number, deltaMode: number, height: number): ViewportTransform {
    const unit = deltaMode === 1 ? 16 : deltaMode === 2 ? height : 1;
    const delta = -Math.max(-300, Math.min(300, deltaY * unit));
    const k = Math.min(Math.max(viewport.k * Math.pow(1.1, delta / 100), 0.05), 5);
    return { x: x - ((x - viewport.x) / viewport.k) * k, y: y - ((y - viewport.y) / viewport.k) * k, k };
}

export function canvasGridSpacing(scale: number) {
    const size = 48 * scale;
    return size * Math.pow(2, Math.max(0, Math.ceil(Math.log2(16 / size))));
}

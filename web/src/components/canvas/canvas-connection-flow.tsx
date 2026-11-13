import { useEffect, useId, useRef } from "react";
import { connectionFlowGeometry } from "@/lib/canvas/connection-flow-geometry";
import { subscribeConnectionFlow } from "@/lib/canvas/connection-flow-scheduler";

type Point = { x: number; y: number };

/** Each light is one filled silhouette with one continuous gradient, never overlapping dash pieces. */
export function CanvasConnectionFlow({ connectionId, path }: { connectionId: string; path: string }) {
    const uid = useId().replace(/:/g, "");
    const rootRef = useRef<SVGGElement>(null);
    useEffect(() => {
        const root = rootRef.current;
        if (!root) return;
        const geometry = connectionFlowGeometry(path);
        if (!geometry) return;
        const { length, samples } = geometry;
        if (!length) return;
        // Cache geometry when endpoints change; the animation only updates SVG attributes, not React state.
        const at = (position: number) => {
            const index = Math.max(0, Math.min(512, position * 512));
            const low = Math.min(511, Math.floor(index));
            const amount = index - low;
            const a = samples[low], b = samples[low + 1];
            const before = samples[Math.max(0, low - 1)], after = samples[Math.min(512, low + 2)];
            const dx = after.x - before.x, dy = after.y - before.y;
            const distance = Math.hypot(dx, dy) || 1;
            return { x: a.x + (b.x - a.x) * amount, y: a.y + (b.y - a.y) * amount, nx: -dy / distance, ny: dx / distance };
        };
        const lights = Array.from(root.querySelectorAll<SVGPathElement>("[data-flow-ribbon]"));
        const gradients = Array.from(root.querySelectorAll<SVGLinearGradientElement>("linearGradient"));
        const outline = (points: Point[], first: boolean) => {
            let d = `${first ? "M" : "L"}${points[0].x.toFixed(3)},${points[0].y.toFixed(3)}`;
            for (let i = 1; i < points.length - 1; i++) {
                const a = points[i], b = points[i + 1];
                d += ` Q${a.x.toFixed(3)},${a.y.toFixed(3)} ${((a.x + b.x) / 2).toFixed(3)},${((a.y + b.y) / 2).toFixed(3)}`;
            }
            const last = points[points.length - 1];
            return d + ` L${last.x.toFixed(3)},${last.y.toFixed(3)}`;
        };
        const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
        let elapsed = Array.from(connectionId).reduce((sum, char) => sum + char.charCodeAt(0), 0) % 3500;
        let previous = performance.now();
        const draw = (time: number) => {
            const paused = document.hidden || reduced.matches || Boolean(root.closest('[data-connection-flow-paused="true"],[data-canvas-panning="true"]'));
            if (!paused) elapsed += Math.max(0, Math.min(250, time - previous));
            previous = time;
            if (!paused) {
                const phase = (elapsed / 3500) % 0.5;
                lights.forEach((light, i) => {
                    const tail = phase + (i - 1) * 0.5;
                    const head = tail + 0.41;
                    const start = Math.max(0, tail), end = Math.min(1, head);
                    if (end <= start) { light.setAttribute("d", ""); return; }
                    const count = Math.max(24, Math.min(96, Math.ceil((end - start) * length / 4)));
                    const upper: Point[] = [], lower: Point[] = [];
                    for (let j = 0; j <= count; j++) {
                        const position = start + (end - start) * j / count;
                        const point = at(position);
                        const progress = (position - tail) / 0.41;
                        // A fine, nearly uniform streak: brightness defines the leading end, not an enlarged head.
                        const tailFade = Math.min(1, Math.max(0, progress) / 0.22);
                        const tipFade = Math.min(1, Math.max(0, 1 - progress) / 0.06);
                        const halfWidth = 1.65 * Math.sin(tailFade * Math.PI / 2) * Math.sin(tipFade * Math.PI / 2);
                        upper.push({ x: point.x + point.nx * halfWidth, y: point.y + point.ny * halfWidth });
                        lower.push({ x: point.x - point.nx * halfWidth, y: point.y - point.ny * halfWidth });
                    }
                    light.setAttribute("d", outline(upper, true) + outline(lower.reverse(), false) + " Z");
                    const a = at(tail), b = at(head);
                    const gradient = gradients[i];
                    gradient.setAttribute("x1", String(a.x)); gradient.setAttribute("y1", String(a.y));
                    gradient.setAttribute("x2", String(b.x)); gradient.setAttribute("y2", String(b.y));
                });
            }
        };
        return subscribeConnectionFlow(draw);
    }, [connectionId, path]);
    return <g ref={rootRef} className="canvas-connection-flow" data-connection-flow={connectionId} style={{ pointerEvents: "none" }}>
        <defs>{[0, 1, 2].map((index) => <linearGradient key={index} id={`${uid}-light-${index}`} gradientUnits="userSpaceOnUse">
            <stop offset="0" stopColor="#69bbed" stopOpacity="0" />
            <stop offset="0.35" stopColor="#69bbed" stopOpacity="0.55" />
            <stop offset="0.72" stopColor="#83cefa" stopOpacity="0.95" />
            <stop offset="1" stopColor="#f1f9ff" />
        </linearGradient>)}</defs>
        {[0, 1, 2].map((index) => <path key={index} data-flow-ribbon fill={`url(#${uid}-light-${index})`} />)}
    </g>;
}

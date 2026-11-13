import { useEffect, useRef, useState } from "react";
import { Button } from "antd";

type View = { scale: number; x: number; y: number };

/** Zoom the original image in the preview, independently of the canvas. */
export function CanvasImagePreview({ src, title, details, onClose, children }: { src: string; title: string; details?: string; onClose?: () => void; children?: React.ReactNode }) {
    const host = useRef<HTMLDivElement>(null);
    const image = useRef<HTMLImageElement>(null);
    const viewRef = useRef<View>({ scale: 1, x: 0, y: 0 });
    const [view, setView] = useState(viewRef.current);
    const [loaded, setLoaded] = useState(false);
    const [natural, setNatural] = useState({ width: 1, height: 1 });
    const [screen, setScreen] = useState({ width: window.innerWidth, height: window.innerHeight });
    const fitScale = Math.min(1, (screen.width - 48) / natural.width, (screen.height - 100) / natural.height);
    const frame = { width: Math.max(1, natural.width * fitScale), height: Math.max(1, natural.height * fitScale) };
    useEffect(() => {
        const resize = () => setScreen({ width: window.innerWidth, height: window.innerHeight });
        window.addEventListener("resize", resize);
        return () => window.removeEventListener("resize", resize);
    }, []);
    const drag = useRef<{ id: number; x: number; y: number } | null>(null);
    const [dragging, setDragging] = useState(false);
    const apply = (next: View) => { viewRef.current = next; setView(next); };
    const fit = () => {
        const element = host.current;
        const img = image.current;
        if (!element || !img?.naturalWidth) return;
        apply({ scale: Math.min(1, element.clientWidth / img.naturalWidth, element.clientHeight / img.naturalHeight), x: 0, y: 0 });
    };
    const zoom = (scale: number, x = 0, y = 0) => {
        const previous = viewRef.current;
        const next = Math.max(0.01, Math.min(16, scale));
        const ratio = next / previous.scale;
        apply({ scale: next, x: x - (x - previous.x) * ratio, y: y - (y - previous.y) * ratio });
    };
    useEffect(() => {
        setLoaded(false);
        drag.current = null;
        setDragging(false);
        const element = host.current;
        if (!element) return;
        const observer = new ResizeObserver(() => fit());
        observer.observe(element);
        const wheel = (event: WheelEvent) => {
            event.preventDefault();
            event.stopPropagation();
            const rect = element.getBoundingClientRect();
            const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? rect.height : 1);
            zoom(viewRef.current.scale * Math.exp(-Math.max(-300, Math.min(300, delta)) * 0.002), event.clientX - rect.left - rect.width / 2, event.clientY - rect.top - rect.height / 2);
        };
        element.addEventListener("wheel", wheel, { passive: false });
        return () => { observer.disconnect(); element.removeEventListener("wheel", wheel); };
    }, [src]);
    return (
        <div className="relative" style={{ width: loaded ? frame.width : "min(640px, calc(100vw - 48px))" }} data-canvas-no-zoom onPointerDown={(event) => event.stopPropagation()}>
            <div className="flex h-8 items-center gap-1 overflow-hidden px-1" title="滚轮缩放 · 拖动查看 · 双击复位">
                <span className="min-w-0 flex-1 truncate text-xs" title={`${title} ${details || ""}`}>{title}<span className="ml-2 opacity-50">{details}</span></span>
                <Button size="small" aria-label="缩小图片" disabled={!loaded} onClick={() => zoom(viewRef.current.scale / 1.25)}>−</Button>
                <span className="min-w-9 text-center text-xs tabular-nums">{Math.round(view.scale * 100)}%</span>
                <Button size="small" aria-label="放大图片" disabled={!loaded} onClick={() => zoom(viewRef.current.scale * 1.25)}>+</Button>
                <Button size="small" title="原始尺寸" disabled={!loaded} onClick={() => apply({ scale: 1, x: 0, y: 0 })}>100%</Button>
                <Button size="small" title="适应窗口" disabled={!loaded} onClick={fit}>适应</Button>
                {onClose ? <Button size="small" type="text" aria-label="关闭图片预览" onClick={onClose}>×</Button> : null}
            </div>
            <div ref={host} className="relative overflow-hidden" style={{ height: loaded ? frame.height : "50vh", touchAction: "none", cursor: dragging ? "grabbing" : "grab" }}
                onDoubleClick={(event) => { event.stopPropagation(); fit(); }}
                onPointerDown={(event) => {
                    if (event.button !== 0 || (event.target as Element).closest("button")) return;
                    event.preventDefault();
                    event.currentTarget.setPointerCapture(event.pointerId);
                    drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY };
                    setDragging(true);
                }}
                onPointerMove={(event) => {
                    const start = drag.current;
                    if (!start || start.id !== event.pointerId) return;
                    const previous = viewRef.current;
                    apply({ ...previous, x: previous.x + event.clientX - start.x, y: previous.y + event.clientY - start.y });
                    start.x = event.clientX; start.y = event.clientY;
                }}
                onPointerUp={(event) => {
                    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
                    drag.current = null; setDragging(false);
                }}
                onPointerCancel={() => { drag.current = null; setDragging(false); }}
                onLostPointerCapture={() => { drag.current = null; setDragging(false); }}>
                <img key={src} ref={image} src={src} alt={title} draggable={false}
                    onLoad={(event) => { setNatural({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); setLoaded(true); fit(); }}
                    style={{ position: "absolute", left: "50%", top: "50%", maxWidth: "none", maxHeight: "none", width: "auto", height: "auto", transform: `translate(-50%, -50%) translate(${view.x}px, ${view.y}px) scale(${view.scale})`, transformOrigin: "center", userSelect: "none" }} />
                {children}
            </div>
        </div>
    );
}

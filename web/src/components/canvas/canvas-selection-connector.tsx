import { useEffect, useRef, useState } from "react";
import { Image, Plus, Video, X } from "lucide-react";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData, type ViewportTransform } from "@/types/canvas";

export function CanvasSelectionConnector({ resources, viewport, onConnect }: {
    resources: CanvasNodeData[];
    viewport: ViewportTransform;
    onConnect: (ids: string[], type: CanvasNodeType.Image | CanvasNodeType.Video, client: { x: number; y: number }, targetId?: string) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const root = useRef<HTMLDivElement>(null);
    const [gesture, setGesture] = useState<{ ids: string[]; sources: CanvasNodeData[]; x: number; y: number; dragging: boolean } | null>(null);
    const gestureRef = useRef(gesture);
    gestureRef.current = gesture;
    const callbackRef = useRef(onConnect);
    callbackRef.current = onConnect;
    const selectionKey = resources.map((node) => node.id).join("|");
    useEffect(() => { setGesture(null); }, [selectionKey]);
    useEffect(() => {
        const move = (event: PointerEvent) => {
            if (!gestureRef.current?.dragging) return;
            setGesture({ ...gestureRef.current, x: event.clientX, y: event.clientY });
        };
        const up = (event: PointerEvent) => {
            const current = gestureRef.current;
            if (!current?.dragging) return;
            const target = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>("[data-node-id]");
            const targetId = target?.dataset.nodeId;
            const type = target?.dataset.nodeType;
            if (targetId && !current.ids.includes(targetId) && (type === CanvasNodeType.Image || type === CanvasNodeType.Video)) {
                callbackRef.current(current.ids, type, { x: event.clientX, y: event.clientY }, targetId);
                setGesture(null);
            } else if (targetId && type !== CanvasNodeType.Group) setGesture(null);
            else setGesture({ ...current, x: event.clientX, y: event.clientY, dragging: false });
        };
        const cancel = () => setGesture(null);
        const outside = (event: PointerEvent) => {
            if (gestureRef.current && !gestureRef.current.dragging && event.target instanceof Node && !root.current?.contains(event.target)) cancel();
        };
        const key = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
        window.addEventListener("pointermove", move);
        window.addEventListener("pointerup", up);
        window.addEventListener("pointercancel", cancel);
        window.addEventListener("blur", cancel);
        window.addEventListener("keydown", key);
        window.addEventListener("pointerdown", outside);
        return () => {
            window.removeEventListener("pointermove", move);
            window.removeEventListener("pointerup", up);
            window.removeEventListener("pointercancel", cancel);
            window.removeEventListener("blur", cancel);
            window.removeEventListener("keydown", key);
            window.removeEventListener("pointerdown", outside);
        };
    }, []);
    if (!resources.length) return null;
    const rect = root.current?.getBoundingClientRect();
    const toScreen = (x: number, y: number) => ({ x: viewport.x + x * viewport.k, y: viewport.y + y * viewport.k });
    const left = Math.min(...resources.map((node) => node.position.x));
    const top = Math.min(...resources.map((node) => node.position.y));
    const right = Math.max(...resources.map((node) => node.position.x + node.width));
    const bottom = Math.max(...resources.map((node) => node.position.y + node.height));
    const origin = toScreen(left, top);
    const handle = toScreen(right, (top + bottom) / 2);
    const end = gesture ? { x: gesture.x - (rect?.left || 0), y: gesture.y - (rect?.top || 0) } : null;
    const imageAllowed = (gesture?.sources || resources).every((node) => node.type === CanvasNodeType.Image || node.type === CanvasNodeType.Text);
    return <div ref={root} className="pointer-events-none absolute inset-0 z-[60]" data-selection-connector>
        {resources.length > 1 ? <div className="absolute rounded-xl border border-dashed" style={{ left: origin.x - 8, top: origin.y - 8, width: (right - left) * viewport.k + 16, height: (bottom - top) * viewport.k + 16, borderColor: theme.node.activeStroke }} /> : null}
        {!gesture ? <button type="button" data-canvas-no-zoom aria-label="拖动连接所选素材" title="拖到空白处新建图片或视频，也可拖到已有生成节点" className="pointer-events-auto absolute grid size-8 -translate-y-1/2 place-items-center rounded-full border shadow-lg" style={{ left: handle.x + 12, top: handle.y, color: theme.node.text, background: theme.toolbar.panel, borderColor: theme.node.activeStroke, cursor: "crosshair", touchAction: "none" }} onMouseDown={(event) => event.stopPropagation()} onPointerDown={(event) => {
            if (event.button !== 0) return;
            event.preventDefault(); event.stopPropagation();
            setGesture({ ids: resources.map((node) => node.id), sources: resources, x: event.clientX, y: event.clientY, dragging: true });
        }}><Plus className="size-5" /></button> : null}
        {gesture && end ? <>
            <svg className="absolute inset-0 size-full overflow-visible">
                {gesture.sources.map((node) => {
                    const start = toScreen(node.position.x + node.width, node.position.y + node.height / 2);
                    const curve = Math.max(40, Math.abs(end.x - start.x) / 2);
                    return <path key={node.id} d={`M${start.x},${start.y} C${start.x + curve},${start.y} ${end.x - curve},${end.y} ${end.x},${end.y}`} fill="none" stroke={theme.node.activeStroke} strokeWidth="1.5" />;
                })}
            </svg>
            {!gesture.dragging ? <div data-canvas-no-zoom className="pointer-events-auto absolute w-52 rounded-xl border p-2 shadow-xl" style={{ left: Math.max(8, Math.min(end.x + 12, (rect?.width || window.innerWidth) - 220)), top: Math.max(56, Math.min(end.y - 40, (rect?.height || window.innerHeight) - 150)), background: theme.toolbar.panel, color: theme.node.text, borderColor: theme.toolbar.border }} onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
                <div className="mb-2 flex items-center justify-between px-2 text-xs opacity-70">引用选中的 {gesture.ids.length} 个素材<button aria-label="取消素材连接" onClick={() => setGesture(null)}><X className="size-3.5" /></button></div>
                {([CanvasNodeType.Image, CanvasNodeType.Video] as const).map((type) => <button key={type} type="button" disabled={type === CanvasNodeType.Image && !imageAllowed} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-current/10 disabled:opacity-35" title={type === CanvasNodeType.Image && !imageAllowed ? "生图参考支持图片和文本" : undefined} onClick={() => { callbackRef.current(gesture.ids, type, { x: gesture.x, y: gesture.y }); setGesture(null); }}>{type === CanvasNodeType.Image ? <Image className="size-4" /> : <Video className="size-4" />}{type === CanvasNodeType.Image ? "生成图片" : "生成视频"}</button>)}
            </div> : null}
        </> : null}
    </div>;
}

import React, { useEffect, useLayoutEffect, useRef, useState } from "react";

import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { zoomAtPointer, canvasGridSpacing } from "@/lib/canvas/canvas-viewport";
import type { ViewportTransform } from "@/types/canvas";

type InfiniteCanvasProps = {
    containerRef: React.RefObject<HTMLDivElement | null>;
    viewport: ViewportTransform;
    backgroundMode?: CanvasBackgroundMode;
    onViewportChange: (viewport: ViewportTransform) => void;
    onCanvasMouseDown?: (event: React.PointerEvent<HTMLDivElement>) => void;
    onCanvasDeselect?: () => void;
    onCanvasDoubleClick?: (event: React.MouseEvent<HTMLDivElement>) => void;
    onContextMenu?: (event: React.MouseEvent) => void;
    onDrop?: (event: React.DragEvent<HTMLDivElement>) => void;
    children: React.ReactNode;
};

export function InfiniteCanvas({ containerRef, viewport, backgroundMode = "lines", onViewportChange, onCanvasMouseDown, onCanvasDeselect, onCanvasDoubleClick, onContextMenu, onDrop, children }: InfiniteCanvasProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const panState = useRef({
        isPanning: false,
        button: -1,
        startX: 0,
        startY: 0,
        initialX: 0,
        initialY: 0,
        hasMoved: false,
        startedOnBackground: false,
    });
    const liveViewportRef = useRef(viewport);
    const onViewportChangeRef = useRef(onViewportChange);
    const frameRef = useRef<number | null>(null);
    const nextViewportRef = useRef<ViewportTransform | null>(null);
    const viewportIdleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const spacePressedRef = useRef(false);
    const [isSpacePressed, setIsSpacePressed] = useState(false);
    const [isControlPressed, setIsControlPressed] = useState(false);
    const [isPanning, setIsPanning] = useState(false);

    useLayoutEffect(() => {
        liveViewportRef.current = nextViewportRef.current ?? viewport;
        onViewportChangeRef.current = onViewportChange;
    }, [viewport, onViewportChange]);

    const markViewportInteraction = () => {
        if (containerRef.current) containerRef.current.dataset.canvasViewportChanging = "true";
        if (viewportIdleTimerRef.current) clearTimeout(viewportIdleTimerRef.current);
        const settle = () => {
            if (panState.current.isPanning || frameRef.current !== null) {
                viewportIdleTimerRef.current = setTimeout(settle, 200);
                return;
            }
            if (containerRef.current) delete containerRef.current.dataset.canvasViewportChanging;
            viewportIdleTimerRef.current = null;
        };
        viewportIdleTimerRef.current = setTimeout(settle, 200);
    };

    const queueViewport = (next: ViewportTransform) => {
        markViewportInteraction();
        liveViewportRef.current = next;
        nextViewportRef.current = next;
        if (frameRef.current !== null) return;
        frameRef.current = requestAnimationFrame(() => {
            frameRef.current = null;
            const pending = nextViewportRef.current;
            nextViewportRef.current = null;
            if (pending) onViewportChangeRef.current(pending);
        });
    };

    const flushViewport = () => {
        if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
        frameRef.current = null;
        const pending = nextViewportRef.current;
        nextViewportRef.current = null;
        if (pending) onViewportChangeRef.current(pending);
    };

    useEffect(
        () => () => {
            if (frameRef.current) cancelAnimationFrame(frameRef.current);
            if (viewportIdleTimerRef.current) clearTimeout(viewportIdleTimerRef.current);
        },
        [],
    );

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Control") setIsControlPressed(true);
            if (event.code !== "Space") return;
            const target = event.target instanceof Element ? event.target : null;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true']")) return;
            event.preventDefault();
            spacePressedRef.current = true;
            setIsSpacePressed(true);
        };

        const handleKeyUp = (event: KeyboardEvent) => {
            if (event.code === "Space") {
                const target = event.target instanceof Element ? event.target : null;
                if (!(event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true']"))) event.preventDefault();
                spacePressedRef.current = false;
                setIsSpacePressed(false);
            }
            if (event.key === "Control") setIsControlPressed(false);
        };

        const handleBlur = () => {
            spacePressedRef.current = false;
            setIsSpacePressed(false);
            setIsControlPressed(false);
            flushViewport();
            panState.current.isPanning = false;
            markViewportInteraction();
            setIsPanning(false);
            document.body.style.cursor = "";
        };

        window.addEventListener("keydown", handleKeyDown);
        window.addEventListener("keyup", handleKeyUp);
        window.addEventListener("blur", handleBlur);
        return () => {
            window.removeEventListener("keydown", handleKeyDown);
            window.removeEventListener("keyup", handleKeyUp);
            window.removeEventListener("blur", handleBlur);
        };
    }, []);

    useEffect(() => {
        const element = containerRef.current;
        if (!element) return;
        element.dataset.connectionFlowPaused = "true";
        const timer = window.setTimeout(() => { delete element.dataset.connectionFlowPaused; }, 200);
        return () => window.clearTimeout(timer);
    }, [containerRef, viewport.x, viewport.y, viewport.k]);

    const handleWheel = (event: React.WheelEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown")) return;

        if (panState.current.isPanning || containerRef.current?.dataset.canvasSelecting === "true") return;
        const viewport = nextViewportRef.current ?? liveViewportRef.current;
        const rect = containerRef.current?.getBoundingClientRect();
        if (!rect) return;
        queueViewport(zoomAtPointer(viewport, event.clientX - rect.left, event.clientY - rect.top, event.deltaY, event.deltaMode, rect.height));
    };

    const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-node-resize-handle]")) return;
        if (target?.closest("[data-canvas-no-zoom]")) return;
        if (target?.closest("[data-connection-create-menu]")) return;
        const isBackgroundClick = !target?.closest("[data-node-id],[data-connection-id]");
        // The group body acts as a canvas pan surface; its header and child nodes keep their own drag behavior.
        const isGroupBody = target?.closest("[data-node-id]")?.getAttribute("data-node-type") === "group" &&
            !target.closest("[data-group-drag-handle]");
        const forceBoxSelect = event.ctrlKey || spacePressedRef.current;
        // 普通左键拖动始终平移；只有 Ctrl / Space + 左键拖动才框选。
        const activeTool = forceBoxSelect ? "select" : "pan";
        // 中键可从任意位置平移；普通左键仅从空白背景开始平移。右键始终留给上下文菜单。
        const shouldPan = event.button === 1 || (event.button === 0 && (isBackgroundClick || isGroupBody) && activeTool === "pan");

        if (shouldPan) {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            panState.current = {
                isPanning: true,
                button: event.button,
                startX: event.clientX,
                startY: event.clientY,
                initialX: liveViewportRef.current.x,
                initialY: liveViewportRef.current.y,
                hasMoved: false,
                startedOnBackground: isBackgroundClick || (event.button === 0 && isGroupBody),
            };
            markViewportInteraction();
            setIsPanning(true);
            document.body.style.cursor = "grabbing";
            return;
        }

        if (event.button === 0 && (isBackgroundClick || isGroupBody) && activeTool === "select") {
            event.preventDefault();
            event.currentTarget.setPointerCapture(event.pointerId);
            onCanvasMouseDown?.(event);
        }
    };

    const handleDoubleClick = (event: React.MouseEvent<HTMLDivElement>) => {
        const target = event.target instanceof Element ? event.target : null;
        if (target?.closest("[data-canvas-no-zoom],[data-node-id],[data-connection-id]")) return;
        onCanvasDoubleClick?.(event);
    };

    useEffect(() => {
        const handlePointerMove = (event: PointerEvent) => {
            if (!panState.current.isPanning) return;

            const dx = event.clientX - panState.current.startX;
            const dy = event.clientY - panState.current.startY;
            if (!panState.current.hasMoved && (Math.abs(dx) > 4 || Math.abs(dy) > 4)) {
                panState.current.hasMoved = true;
            }

            queueViewport({
                x: panState.current.initialX + dx,
                y: panState.current.initialY + dy,
                k: liveViewportRef.current.k,
            });
        };

        const handlePointerUp = () => {
            if (!panState.current.isPanning) return;

            if (!panState.current.hasMoved && panState.current.startedOnBackground) {
                onCanvasDeselect?.();
            }
            flushViewport();
            panState.current.isPanning = false;
            panState.current.button = -1;
            markViewportInteraction();
            setIsPanning(false);
            document.body.style.cursor = "";
        };

        window.addEventListener("pointermove", handlePointerMove);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointercancel", handlePointerUp);
        return () => {
            window.removeEventListener("pointermove", handlePointerMove);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointercancel", handlePointerUp);
            document.body.style.cursor = "";
        };
    }, [onCanvasDeselect, onViewportChange]);

    useEffect(() => {
        const container = containerRef.current;
        if (!container) return;

        // Prevent canvas scrolling from moving the page while preserving native scrolling inside overlays and dialogs.
        const preventWheelScroll = (event: WheelEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (target?.closest("[data-canvas-no-zoom],.ant-modal,.ant-popover,.ant-dropdown,.ant-select-dropdown,.ant-picker-dropdown")) return;
            event.preventDefault();
        };
        container.addEventListener("wheel", preventWheelScroll, { passive: false });
        return () => container.removeEventListener("wheel", preventWheelScroll);
    }, [containerRef]);

    const forceBoxSelect = isControlPressed || isSpacePressed;
    const activeTool = forceBoxSelect ? "select" : "pan";
    const cursor = isPanning ? "grabbing" : activeTool === "pan" ? "grab" : "crosshair";

    return (
        <div
            ref={containerRef}
            data-canvas-panning={isPanning ? "true" : undefined}
            className="relative h-full w-full select-none overflow-hidden"
            style={{ background: theme.canvas.background, cursor }}
            onPointerDown={handlePointerDown}
            onDoubleClick={handleDoubleClick}
            onWheel={handleWheel}
            onContextMenu={onContextMenu}
            onDragOver={(event) => event.preventDefault()}
            onDrop={onDrop}
        >
            <CanvasGrid viewport={viewport} mode={backgroundMode} />
            <div
                className="absolute origin-top-left"
                style={{
                    transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.k})`,
                }}
            >
                {children}
            </div>
        </div>
    );
}

export function CanvasGrid({ viewport, mode }: { viewport: ViewportTransform; mode: CanvasBackgroundMode }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (mode === "blank") return null;

    const gridSize = canvasGridSpacing(viewport.k);
    const x = viewport.x % gridSize;
    const y = viewport.y % gridSize;
    const dotSize = viewport.k < 0.12 ? 0.8 : 1.15;
    const backgroundImage =
        mode === "dots" ? `radial-gradient(circle, ${theme.canvas.dot} ${dotSize}px, transparent ${dotSize + 0.2}px)` : `linear-gradient(${theme.canvas.line} 1px, transparent 1px), linear-gradient(90deg, ${theme.canvas.line} 1px, transparent 1px)`;

    return (
        <div
            data-canvas-background={mode}
            className="pointer-events-none absolute inset-0 opacity-35"
            style={{
                backgroundImage,
                backgroundSize: `${gridSize}px ${gridSize}px`,
                backgroundPosition: `${x}px ${y}px`,
            }}
        />
    );
}

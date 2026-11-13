import { useEffect, useRef, useState } from "react";
import { InputNumber, Modal } from "antd";
import { resolveMediaUrl } from "@/services/file-storage";
import type { CanvasNodeData } from "@/types/canvas";

type Props = {
    node: CanvasNodeData | null;
    start: number;
    end: number;
    busy: boolean;
    progress?: number;
    onStartChange: (value: number) => void;
    onEndChange: (value: number) => void;
    onDuration: (value: number) => void;
    onCancel: () => void;
    onConfirm: () => void;
};

export function CanvasVideoTrimDialog({ node, start, end, busy, progress = 0, onStartChange, onEndChange, onDuration, onCancel, onConfirm }: Props) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const controlsRef = useRef<HTMLDivElement>(null);
    const timelineRef = useRef<HTMLDivElement>(null);
    const dragHandleRef = useRef<"start" | "end" | null>(null);
    const [url, setUrl] = useState("");
    const [duration, setDuration] = useState(0);
    const [activeHandle, setActiveHandle] = useState<"start" | "end">("start");
    useEffect(() => { setActiveHandle("start"); }, [node?.id]);
    useEffect(() => { if (busy) videoRef.current?.pause(); }, [busy]);
    useEffect(() => {
        let alive = true;
        if (!node?.metadata?.content) { setUrl(""); return; }
        setDuration((node.metadata.durationMs || 0) / 1000);
        void resolveMediaUrl(node.metadata.storageKey, node.metadata.content).then((value) => { if (alive) setUrl(value); });
        return () => { alive = false; };
    }, [node?.id, node?.metadata?.content, node?.metadata?.storageKey, node?.metadata?.durationMs]);

    const seek = (time: number) => {
        const video = videoRef.current;
        if (!video) return;
        video.pause();
        video.currentTime = time;
    };
    const timeAtPointer = (clientX: number) => {
        const bounds = timelineRef.current?.getBoundingClientRect();
        if (!bounds || !duration) return 0;
        return Math.round(Math.max(0, Math.min(1, (clientX - bounds.left) / bounds.width)) * duration * 100) / 100;
    };
    const moveHandle = (clientX: number, handle: "start" | "end") => {
        const time = timeAtPointer(clientX);
        if (handle === "start") onStartChange(Math.min(time, end));
        else onEndChange(Math.max(time, start));
        seek(time);
    };
    const setBoundaryFromPlayhead = (boundary: "start" | "end") => {
        const time = Number((videoRef.current?.currentTime || 0).toFixed(2));
        if (boundary === "start") { onStartChange(Math.min(time, end)); setActiveHandle("start"); }
        else { onEndChange(Math.max(time, start)); setActiveHandle("end"); }
    };
    return (
        <Modal title="截取视频片段" open={Boolean(node)} width={640} centered afterOpenChange={(open) => { if (open) controlsRef.current?.focus(); }} keyboard={!busy} onCancel={onCancel} onOk={onConfirm} okText="截取并添加" okButtonProps={{ loading: busy, disabled: !duration || end <= start }} cancelButtonProps={{ disabled: busy }} closable={!busy} maskClosable={!busy}>
            <div ref={controlsRef} className="space-y-4 outline-none" data-canvas-shortcuts-ignore tabIndex={0} onKeyDownCapture={(event) => {
                if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                event.preventDefault();
                event.stopPropagation();
                if (busy || !duration || event.altKey || event.ctrlKey || event.metaKey) return;
                const delta = (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 0.1 : 0.05);
                const current = activeHandle === "start" ? start : end;
                const next = Math.round(Math.max(activeHandle === "start" ? 0 : start, Math.min(activeHandle === "start" ? end : duration, current + delta)) * 100) / 100;
                if (activeHandle === "start") onStartChange(next);
                else onEndChange(next);
                seek(next);
            }}>
                <div className="flex justify-center rounded-lg bg-black p-2">
                    <video ref={videoRef} src={url} controls playsInline preload="metadata" className="max-h-[46vh] max-w-full" onLoadedMetadata={(event) => { const value = event.currentTarget.duration; if (Number.isFinite(value)) { setDuration(value); onDuration(value); } }} />
                </div>
                <div>
                    <div className="mb-1 flex justify-between text-xs opacity-70"><span>起点 {start.toFixed(2)}s</span><span>截取时长 {Math.max(0, end - start).toFixed(2)}s</span><span>终点 {end.toFixed(2)}s</span></div>
                    <div ref={timelineRef} tabIndex={0} className="relative my-4 h-8 cursor-ew-resize touch-none select-none" role="group" aria-label="视频截取范围" onPointerDown={(event) => {
                        if (busy || !duration) return;
                        const time = timeAtPointer(event.clientX);
                        const handle = Math.abs(time - start) <= Math.abs(time - end) ? "start" : "end";
                        dragHandleRef.current = handle;
                        setActiveHandle(handle);
                        event.currentTarget.focus();
                        event.currentTarget.setPointerCapture(event.pointerId);
                        moveHandle(event.clientX, handle);
                    }} onPointerMove={(event) => { if (dragHandleRef.current) moveHandle(event.clientX, dragHandleRef.current); }} onPointerUp={(event) => { dragHandleRef.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { dragHandleRef.current = null; }}>
                        <div className="absolute inset-x-0 top-3 h-2 rounded-full bg-neutral-500/40" />
                        <div className="absolute top-3 h-2 bg-blue-500" style={{ left: `${start / (duration || 1) * 100}%`, width: `${(end - start) / (duration || 1) * 100}%` }} />
                        <div className="absolute top-1 h-6 w-3 -translate-x-1/2 rounded border border-blue-700 bg-white shadow" style={{ left: `${start / (duration || 1) * 100}%` }} title={`起点 ${start.toFixed(2)} 秒`} />
                        <div className="absolute top-1 h-6 w-3 -translate-x-1/2 rounded border border-blue-700 bg-white shadow" style={{ left: `${end / (duration || 1) * 100}%` }} title={`终点 ${end.toFixed(2)} 秒`} />
                    </div>
                    <div className="flex justify-between gap-2 text-xs opacity-70"><span>拖动左侧手柄选起始帧，右侧手柄选结束帧</span><span>总长 {duration.toFixed(2)}s</span></div>
                </div>
                <div className="flex flex-wrap items-center gap-3">
                    <button type="button" disabled={busy} className="rounded border px-2 py-1 text-sm" onClick={() => setBoundaryFromPlayhead("start")}>将当前帧设为起点</button>
                    <button type="button" disabled={busy} className="rounded border px-2 py-1 text-sm" onClick={() => setBoundaryFromPlayhead("end")}>将当前帧设为终点</button>
                    <button type="button" disabled={busy} className="rounded border px-2 py-1 text-sm" onClick={() => { setActiveHandle("start"); seek(start); }} aria-pressed={activeHandle === "start"}>微调起点</button>
                    <button type="button" disabled={busy} className="rounded border px-2 py-1 text-sm" onClick={() => { setActiveHandle("end"); seek(end); }} aria-pressed={activeHandle === "end"}>微调终点</button>
                    <span className="text-xs opacity-60">正在调整：{activeHandle === "start" ? "起点" : "终点"}</span>
                </div>
                <div className="flex items-center gap-3 text-sm">
                    <label>起点（秒） <InputNumber disabled={busy} onFocus={() => setActiveHandle("start")} min={0} max={end} step={0.05} precision={2} value={start} onChange={(value) => { onStartChange(value ?? 0); seek(value ?? 0); }} /></label>
                    <label>终点（秒） <InputNumber disabled={busy} onFocus={() => setActiveHandle("end")} min={start} max={duration} step={0.05} precision={2} value={end} onChange={(value) => { onEndChange(value ?? 0); seek(value ?? 0); }} /></label>
                </div>
                <p className="text-xs opacity-70">← / → 微调当前端点 0.05 秒，Shift + ← / → 调整 0.1 秒。导出保留原视频格式、分辨率和编码，不重新压缩。</p>
                {busy && <p role="status" className="text-sm">{progress === 0 ? "正在读取原视频…" : progress >= 1 ? "正在保存片段到画布…" : `正在截取片段 ${Math.round(progress * 100)}%…`}</p>}
            </div>
        </Modal>
    );
}

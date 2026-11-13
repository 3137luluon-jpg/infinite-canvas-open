import { useEffect, useState } from "react";
import { Button } from "antd";
import { resolveImageUrl } from "@/services/image-storage";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";

export function CanvasBatchReferenceToolbar({ images, onCreate }: {
    images: CanvasNodeData[];
    onCreate: (type: CanvasNodeType.Image | CanvasNodeType.Video) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    if (!images.length) return null;
    return <div data-canvas-no-zoom data-batch-reference-toolbar className="absolute bottom-24 left-1/2 z-50 w-max max-w-[calc(100%-32px)] -translate-x-1/2 rounded-xl border p-3 shadow-lg" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }} onPointerDown={(event) => event.stopPropagation()} onMouseDown={(event) => event.stopPropagation()}>
        <div className="mb-2 text-xs">已选 {images.length} 张图片 · 从左到右<span className="ml-2 opacity-60">自动连接所选素材</span></div>
        <div className="mb-3 flex max-w-[640px] gap-2 overflow-x-auto">
            {images.map((node, index) => <ReferencePreview key={node.id} node={node} index={index} />)}
        </div>
        <div className="flex flex-wrap gap-2">
            <Button size="small" title="新建图片节点，自动连接所选参考图" onClick={() => onCreate(CanvasNodeType.Image)}>新建图片</Button>
            <Button size="small" title="新建视频节点，自动连接所选参考图" onClick={() => onCreate(CanvasNodeType.Video)}>新建视频</Button>
        </div>
    </div>;
}

function ReferencePreview({ node, index }: { node: CanvasNodeData; index: number }) {
    const [url, setUrl] = useState("");
    useEffect(() => {
        let active = true;
        void resolveImageUrl(node.metadata?.storageKey, node.metadata?.content).then((value) => { if (active) setUrl(value || ""); }).catch(() => { if (active) setUrl(""); });
        return () => { active = false; };
    }, [node.metadata?.storageKey, node.metadata?.content]);
    return <div className="w-16 shrink-0" title={`${index + 1}. ${node.title || "图片"}`}>
        <div className="relative h-12 overflow-hidden rounded-md border border-current/20">
            {url ? <img src={url} alt={node.title || "图片"} className="size-full object-cover" /> : null}
            <span className="absolute bottom-0 left-0 rounded-tr bg-black/70 px-1 text-xs text-white">{index + 1}</span>
        </div>
        <div className="mt-1 truncate text-[10px] opacity-70">{node.title || "图片"}</div>
    </div>;
}

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { ChevronRight, Copy, Download, Image as ImageIcon, LoaderCircle, Music2, Puzzle, RefreshCw, Star, Trash2, Video } from "lucide-react";

import { summarizeApiError } from "@/lib/api-error";
import { canvasThemes } from "@/lib/canvas-theme";
import { canvasGroupColorAppearance } from "@/lib/canvas/canvas-group-colors";
import { CanvasGroupColorPicker } from "./canvas-group-color-picker";
import { formatBytes } from "@/lib/image-utils";
import { getNodeDefinition } from "@/lib/canvas/node-registry";
import { CINEPACK_BASE_CHARACTER_REFERENCE_ID, cinePackBoundCharacterReference, cinePackCharacterReferences } from "@/lib/canvas/cinepack-character-looks";
import { CanvasVideoPlayer } from "./canvas-video-player";
import { cachedVideoPreview, loadVideoPreview, suspendVideoPreviews } from "@/lib/canvas/video-preview";
import { resolveImageUrl } from "@/services/image-storage";
import { buildNodeContext } from "@/lib/canvas/plugin-node-context";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasResourceMentionTextarea } from "./canvas-resource-mention-textarea";
import { CanvasNodeType, type CanvasGenerationPhase, type CanvasNodeData, type CanvasNodeImage, type Position } from "@/types/canvas";
import type { CanvasNodeContext, CanvasPluginHost } from "@/types/canvas-plugin";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { useTranslation } from "react-i18next";

type ResizeCorner = "top-left" | "top-right" | "bottom-left" | "bottom-right";
const selectionBlue = "#2f80ff";
const generationPhaseLabels = {
    packing: "正在准备生成请求",
    resolving: "正在读取参考资产",
    compressing: "正在压缩故事板参考图",
    planning: "故事板大模型正在编译",
    submitting: "正在提交生图请求",
    queued: "生图服务已接单，正在排队",
    generating: "正在生成图片",
    downloading: "正在下载生成结果",
    saving: "正在保存到画布与本地目录",
} satisfies Record<CanvasGenerationPhase, string>;
const videoGenerationPhaseLabels = {
    packing: "正在准备视频请求",
    resolving: "正在读取视频参考资产",
    compressing: "正在处理视频参考资产",
    planning: "正在整理视频生成参数",
    submitting: "正在提交视频任务",
    queued: "视频服务已接单，正在排队",
    generating: "正在生成视频",
    downloading: "正在下载生成视频",
    saving: "正在保存视频到画布与本地目录",
} satisfies Record<CanvasGenerationPhase, string>;

function getGenerationPhaseLabel(node: CanvasNodeData, phase: CanvasGenerationPhase) {
    return node.type === CanvasNodeType.Video ? videoGenerationPhaseLabels[phase] : generationPhaseLabels[phase];
}

function formatGenerationDuration(ms: number) {
    const seconds = Math.max(0.01, ms / 1_000);
    return `${seconds < 100 ? seconds.toFixed(2) : Math.round(seconds)}s`;
}

type CanvasNodeProps = {
    data: CanvasNodeData;
    scale: number;
    isSelected: boolean;
    isRelated: boolean;
    isFocusRelated: boolean;
    isConnectionTarget: boolean;
    isConnecting: boolean;
    editRequestNonce?: number;
    renameRequestNonce?: number;
    showPanel: boolean;
    showImageInfo: boolean;
    hasRunningStoryboard?: boolean;
    mentionReferences?: CanvasResourceReference[];
    activeCinePackShot?: CanvasNodeData;
    pluginHost?: CanvasPluginHost;
    registryVersion?: number;
    renderPanel?: (node: CanvasNodeData) => ReactNode;
    renderNodeContent?: (node: CanvasNodeData) => ReactNode;
    groupChildCount?: number;
    isGroupDropTarget?: boolean;
    batchExpanded?: boolean;
    onMouseDown: (event: React.MouseEvent, nodeId: string) => void;
    onSelectCapture?: (event: React.MouseEvent, nodeId: string) => void;
    onHoverStart: (nodeId: string) => void;
    onHoverEnd: (nodeId: string) => void;
    onConnectStart: (event: React.MouseEvent, nodeId: string, handleType: "source" | "target") => void;
    onResizeStart: (nodeId: string) => void;
    onResize: (nodeId: string, width: number, height: number, position?: Position) => void;
    onResizeEnd: (nodeId: string) => void;
    onContentChange: (nodeId: string, content: string) => void;
    onImageDimensions?: (nodeId: string, source: string, width: number, height: number) => void;
    onTitleChange: (nodeId: string, title: string) => void;
    onGroupColorChange?: (nodeId: string, color: string | undefined) => void;
    onToggleBatch?: (nodeId: string) => void;
    onSetBatchPrimary?: (nodeId: string, imageId: string) => void;
    onDuplicateBatchImage?: (node: CanvasNodeData, imageId: string) => void;
    onDownloadBatchImage?: (node: CanvasNodeData, imageId: string) => void;
    onRetryBatchImage?: (node: CanvasNodeData, imageId: string) => void;
    onDeleteBatchImage?: (nodeId: string, imageId: string) => void;
    onRetry?: (node: CanvasNodeData) => void;
    onGenerateImage?: (node: CanvasNodeData) => void;
    onSelectCinePackCharacterReference?: (shotId: string, characterNodeId: string, referenceId: string) => void;
    onViewImage?: (node: CanvasNodeData) => void;
    onViewBatchImage?: (node: CanvasNodeData, imageId: string) => void;
    onContextMenu: (event: React.MouseEvent, nodeId: string) => void;
};

type NodeContentRendererProps = {
    node: CanvasNodeData;
    isSelected: boolean;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    isEditingContent: boolean;
    isEditingTitle: boolean;
    textareaRef: React.RefObject<HTMLTextAreaElement | null>;
    titleInputRef: React.RefObject<HTMLInputElement | null>;
    titleDraft: string;
    isBatchRoot: boolean;
    batchCount: number;
    batchExpanded: boolean;
    renderNodeContent?: (node: CanvasNodeData) => ReactNode;
    pluginContext?: CanvasNodeContext | null;
    onContentChange: (nodeId: string, content: string) => void;
    onStartEditing: () => void;
    onStopEditing: () => void;
    onTitleDraftChange: (value: string) => void;
    onStartTitleEditing: () => void;
    onFinishTitleEditing: () => void;
    onCancelTitleEditing: () => void;
    mentionReferences: CanvasResourceReference[];
    activeCinePackShot?: CanvasNodeData;
    onRetry?: (node: CanvasNodeData) => void;
    onGenerateImage?: (node: CanvasNodeData) => void;
    onSelectCinePackCharacterReference?: (shotId: string, characterNodeId: string, referenceId: string) => void;
    onToggleBatch?: () => void;
    onSetBatchPrimary?: (imageId: string) => void;
    onDuplicateBatchImage?: (imageId: string) => void;
    onDownloadBatchImage?: (imageId: string) => void;
    onRetryBatchImage?: (imageId: string) => void;
    onDeleteBatchImage?: (imageId: string) => void;
    onViewBatchImage?: (imageId: string) => void;
    groupChildCount: number;
    onGroupColorChange?: (nodeId: string, color: string | undefined) => void;
};

export const CanvasNode = React.memo(function CanvasNode({
    data,
    scale,
    isSelected,
    isRelated,
    isFocusRelated,
    isConnectionTarget,
    isConnecting,
    editRequestNonce = 0,
    renameRequestNonce = 0,
    showPanel,
    showImageInfo,
    hasRunningStoryboard = false,
    mentionReferences = [],
    activeCinePackShot,
    pluginHost,
    renderPanel,
    renderNodeContent,
    groupChildCount = 0,
    isGroupDropTarget = false,
    batchExpanded = false,
    onMouseDown,
    onSelectCapture,
    onHoverStart,
    onHoverEnd,
    onConnectStart,
    onResizeStart,
    onResize,
    onResizeEnd,
    onContentChange,
    onImageDimensions,
    onTitleChange,
    onGroupColorChange,
    onToggleBatch,
    onSetBatchPrimary,
    onDuplicateBatchImage,
    onDownloadBatchImage,
    onRetryBatchImage,
    onDeleteBatchImage,
    onRetry,
    onGenerateImage,
    onSelectCinePackCharacterReference,
    onViewImage,
    onViewBatchImage,
    onContextMenu,
}: CanvasNodeProps) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const [hovered, setHovered] = useState(false);
    const definition = getNodeDefinition(data.type);
    const pluginContext = useMemo<CanvasNodeContext | null>(() => (pluginHost ? buildNodeContext(pluginHost, data, theme, scale, isSelected) : null), [pluginHost, data, theme, scale, isSelected]);
    const [isEditingContent, setIsEditingContent] = useState(false);
    const [isEditingTitle, setIsEditingTitle] = useState(false);
    const [titleDraft, setTitleDraft] = useState(data.title || "");
    const hasImageContent = data.type === CanvasNodeType.Image && Boolean(data.metadata?.content);
    const hasVideoContent = data.type === CanvasNodeType.Video && Boolean(data.metadata?.content);
    const hasAudioContent = data.type === CanvasNodeType.Audio && Boolean(data.metadata?.content);
    const primaryImage = data.type === CanvasNodeType.Image ? data.metadata?.images?.find((image) => image.id === data.metadata?.primaryImageId) || data.metadata?.images?.find((image) => Boolean(image.content)) : undefined;
    const generationDurationMs = primaryImage?.generationDurationMs || data.metadata?.generationDurationMs;
    const generationDurationLabel = generationDurationMs ? formatGenerationDuration(generationDurationMs) : "";
    const mediaInfo = primaryImage?.content ? primaryImage : data.metadata;
    const mediaFormat = mediaInfo?.mimeType?.split(";")[0].split("/")[1]?.replace(/^x-/, "").replace("svg+xml", "svg").toUpperCase();
    const mediaDimensions = mediaInfo?.naturalWidth && mediaInfo?.naturalHeight && mediaInfo.naturalWidth > 0 && mediaInfo.naturalHeight > 0 ? `${mediaInfo.naturalWidth}×${mediaInfo.naturalHeight}` : "";
    const mediaInfoLabel = (hasImageContent || hasVideoContent || hasAudioContent || primaryImage?.content) ? [mediaFormat, mediaDimensions].filter(Boolean).join(" ") : "";
    const isGroup = data.type === CanvasNodeType.Group;
    const groupColor = isGroup ? canvasGroupColorAppearance(data.metadata?.groupColor) : undefined;
    const batchCount = data.type === CanvasNodeType.Image ? data.metadata?.images?.length || 0 : 0;
    const isBatchRoot = batchCount > 1;
    // Nodes with the interaction/move toggle ignore content pointer events in move mode and allow interaction in interactive mode.
    // forceInteractive states such as editing stay interactive, as do empty nodes so their upload and generation actions remain usable.
    const supportsInteractionToggle = Boolean(definition?.interactionToggle);
    const forceInteractive = supportsInteractionToggle ? Boolean(definition?.forceInteractive?.(data)) : false;
    const contentInteractive = !supportsInteractionToggle || forceInteractive || !data.metadata?.content ? true : Boolean(data.metadata?.interactive);
    // Transparent nodes such as SVGs blend into the canvas while retaining outlines for selected or related states.
    const transparentBg = Boolean(definition?.transparentBackground);
    const isActive = isConnectionTarget || isSelected || isFocusRelated;
    // 默认描边与视频一致；选中/关联高亮仍用蓝/muted，避免和链接高亮冲突
    const imageBorderColor = isActive ? selectionBlue : isRelated ? theme.node.muted : theme.node.stroke;
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const titleInputRef = useRef<HTMLInputElement>(null);
    const mediaNodeRef = useRef<HTMLDivElement>(null);
    const reportImageDimensions = useCallback((image: HTMLImageElement) => {
        if (data.type !== CanvasNodeType.Image || !image.naturalWidth || !image.naturalHeight) return;
        onImageDimensions?.(data.id, image.getAttribute("src") || image.src, image.naturalWidth, image.naturalHeight);
    }, [data.id, data.type, onImageDimensions]);
    useEffect(() => {
        mediaNodeRef.current?.querySelectorAll("img").forEach(reportImageDimensions);
    }, [data.metadata?.content, data.metadata?.images, reportImageDimensions]);
    const resizeRef = useRef({
        isResizing: false,
        corner: "bottom-right" as ResizeCorner,
        startX: 0,
        startY: 0,
        startLeft: 0,
        startTop: 0,
        startWidth: 0,
        startHeight: 0,
        keepRatio: false,
        ratio: 1,
    });

    useEffect(() => {
        setTitleDraft(data.title || "");
    }, [data.title]);

    useEffect(() => {
        if (!isEditingTitle) return;
        titleInputRef.current?.focus({ preventScroll: true });
        titleInputRef.current?.select();
    }, [isEditingTitle]);

    const finishTitleEditing = useCallback(() => {
        const title = (titleInputRef.current?.value ?? titleDraft).trim() || data.title || t("canvas.node.untitled");
        setTitleDraft(title);
        setIsEditingTitle(false);
        if (title !== data.title) onTitleChange(data.id, title);
    }, [data.id, data.title, onTitleChange, t, titleDraft]);

    useEffect(() => {
        if (!isEditingTitle) return;
        const handleOutsidePointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (target instanceof Node && titleInputRef.current?.contains(target)) return;
            const titleInput = titleInputRef.current;
            if (titleInput && document.activeElement === titleInput) titleInput.blur();
            else finishTitleEditing();
        };
        window.addEventListener("pointerdown", handleOutsidePointerDown, true);
        return () => window.removeEventListener("pointerdown", handleOutsidePointerDown, true);
    }, [finishTitleEditing, isEditingTitle]);

    useEffect(() => {
        const textarea = textareaRef.current;
        if (!textarea) return;

        const handleWheel = (event: WheelEvent) => event.stopPropagation();
        textarea.addEventListener("wheel", handleWheel, { passive: false });
        return () => textarea.removeEventListener("wheel", handleWheel);
    }, [data.type, isEditingContent]);

    useEffect(() => {
        if (!isEditingContent) return;
        const textarea = textareaRef.current;
        textarea?.focus();
        textarea?.setSelectionRange(textarea.value.length, textarea.value.length);
    }, [isEditingContent]);

    useEffect(() => {
        if (!editRequestNonce || data.type !== CanvasNodeType.Text) return;
        setIsEditingContent(true);
    }, [data.type, editRequestNonce]);

    useEffect(() => {
        if (!renameRequestNonce) return;
        setIsEditingTitle(true);
    }, [renameRequestNonce]);

    useEffect(() => {
        if (!isEditingContent) return;

        const handleOutsidePointerDown = (event: PointerEvent) => {
            const target = event.target;
            if (!(target instanceof Node)) return;
            if (isEditingContent && textareaRef.current?.contains(target)) return;

            setIsEditingContent(false);
        };

        window.addEventListener("pointerdown", handleOutsidePointerDown, true);
        return () => window.removeEventListener("pointerdown", handleOutsidePointerDown, true);
    }, [isEditingContent]);

    const handleResizeMove = useCallback(
        (event: MouseEvent) => {
            if (!resizeRef.current.isResizing) return;

            const dx = (event.clientX - resizeRef.current.startX) / scale;
            const dy = (event.clientY - resizeRef.current.startY) / scale;
            const minWidth = 220;
            const minHeight = 160;
            const startRight = resizeRef.current.startLeft + resizeRef.current.startWidth;
            const startBottom = resizeRef.current.startTop + resizeRef.current.startHeight;
            const fromLeft = resizeRef.current.corner.includes("left");
            const fromTop = resizeRef.current.corner.includes("top");
            const rawWidth = Math.max(minWidth, resizeRef.current.startWidth + (fromLeft ? -dx : dx));
            const rawHeight = Math.max(minHeight, resizeRef.current.startHeight + (fromTop ? -dy : dy));
            let width = rawWidth;
            let height = rawHeight;
            if (resizeRef.current.keepRatio) {
                const ratio = resizeRef.current.ratio;
                if (Math.abs(dx) >= Math.abs(dy)) {
                    height = width / ratio;
                } else {
                    width = height * ratio;
                }
                if (height < minHeight) {
                    height = minHeight;
                    width = height * ratio;
                }
                if (width < minWidth) {
                    width = minWidth;
                    height = width / ratio;
                }
            }

            onResize(data.id, width, height, {
                x: fromLeft ? startRight - width : resizeRef.current.startLeft,
                y: fromTop ? startBottom - height : resizeRef.current.startTop,
            });
        },
        [data.id, onResize, scale],
    );

    const handleResizeUp = useCallback(() => {
        resizeRef.current.isResizing = false;
        window.removeEventListener("mousemove", handleResizeMove);
        window.removeEventListener("mouseup", handleResizeUp);
        onResizeEnd(data.id);
    }, [data.id, handleResizeMove, onResizeEnd]);

    const handleResizeMouseDown = (event: React.MouseEvent, corner: ResizeCorner) => {
        event.stopPropagation();
        event.preventDefault();
        onResizeStart(data.id);
        resizeRef.current = {
            isResizing: true,
            corner,
            startX: event.clientX,
            startY: event.clientY,
            startLeft: data.position.x,
            startTop: data.position.y,
            startWidth: data.width,
            startHeight: data.height,
            keepRatio: (data.type === CanvasNodeType.Image && !data.metadata?.freeResize) || data.type === CanvasNodeType.Video || Boolean(definition?.keepAspectRatio?.(data)),
            ratio: (data.metadata?.naturalWidth || data.width) / (data.metadata?.naturalHeight || data.height || 1),
        };
        window.addEventListener("mousemove", handleResizeMove);
        window.addEventListener("mouseup", handleResizeUp);
    };

    useEffect(() => {
        return () => {
            window.removeEventListener("mousemove", handleResizeMove);
            window.removeEventListener("mouseup", handleResizeUp);
        };
    }, [handleResizeMove, handleResizeUp]);

    // Geometry and zoom update the outer node, not unchanged text/media/editor trees.
    // Custom plugin renderers keep their full scale-aware context.
    const contentPluginContext = nodeContentRenderers[data.type as CanvasNodeType] ? null : pluginContext;
    const content = useMemo(() => (
        <NodeContent
            node={data}
            isSelected={isSelected}
            theme={theme}
            isEditingContent={isEditingContent}
            isEditingTitle={isEditingTitle}
            textareaRef={textareaRef}
            titleInputRef={titleInputRef}
            titleDraft={titleDraft}
            isBatchRoot={isBatchRoot}
            batchCount={batchCount}
            batchExpanded={batchExpanded}
            renderNodeContent={renderNodeContent}
            pluginContext={contentPluginContext}
            mentionReferences={mentionReferences}
            activeCinePackShot={activeCinePackShot}
            onContentChange={onContentChange}
            onStartEditing={() => setIsEditingContent(true)}
            onStopEditing={() => setIsEditingContent(false)}
            onTitleDraftChange={setTitleDraft}
            onStartTitleEditing={() => setIsEditingTitle(true)}
            onFinishTitleEditing={finishTitleEditing}
            onCancelTitleEditing={() => {
                setTitleDraft(data.title || "");
                setIsEditingTitle(false);
            }}
            onRetry={onRetry}
            onGenerateImage={onGenerateImage}
            onSelectCinePackCharacterReference={onSelectCinePackCharacterReference}
            onToggleBatch={() => onToggleBatch?.(data.id)}
            onSetBatchPrimary={(imageId) => onSetBatchPrimary?.(data.id, imageId)}
            onDuplicateBatchImage={(imageId) => onDuplicateBatchImage?.(data, imageId)}
            onDownloadBatchImage={(imageId) => onDownloadBatchImage?.(data, imageId)}
            onRetryBatchImage={(imageId) => onRetryBatchImage?.(data, imageId)}
            onDeleteBatchImage={(imageId) => onDeleteBatchImage?.(data.id, imageId)}
            onViewBatchImage={(imageId) => onViewBatchImage?.(data, imageId)}
            groupChildCount={groupChildCount}
            onGroupColorChange={onGroupColorChange}
        />
    ), [data, isSelected, theme, isEditingContent, isEditingTitle, titleDraft,
        isBatchRoot, batchCount, batchExpanded, renderNodeContent, contentPluginContext,
        mentionReferences, activeCinePackShot, onContentChange, finishTitleEditing,
        onRetry, onGenerateImage, onSelectCinePackCharacterReference, onToggleBatch,
        onSetBatchPrimary, onDuplicateBatchImage, onDownloadBatchImage, onRetryBatchImage,
        onDeleteBatchImage, onViewBatchImage, groupChildCount, onGroupColorChange]);

    return (
        <div
            ref={mediaNodeRef}
            data-node-id={data.id}
            onLoadCapture={(event) => { if (event.target instanceof HTMLImageElement) reportImageDimensions(event.target); }}
            data-node-type={data.type}
            className={`node-element absolute flex select-none flex-col transition-shadow duration-200 ${isGroup ? "z-[5]" : isSelected ? "z-50" : "z-10"}`}
            style={{
                "--canvas-node-scale": Number.isFinite(scale) && scale > 0 ? scale : 1,
                transform: `translate(${data.position.x}px, ${data.position.y}px)`,
                width: data.width,
                height: data.height,
                transition: "box-shadow 200ms ease",
                contain: "layout style",
            } as React.CSSProperties}
            onMouseEnter={() => {
                setHovered(true);
                onHoverStart(data.id);
            }}
            onMouseLeave={() => {
                setHovered(false);
                onHoverEnd(data.id);
            }}
            onMouseDownCapture={(event) => onSelectCapture?.(event, data.id)}
            onContextMenu={(event) => onContextMenu(event, data.id)}
        >
            {!isGroup && (isSelected || hovered || isEditingTitle) && (
                <div
                    className="absolute left-3 top-[-28px] z-[65] flex max-w-[calc(100%-24px)] items-center gap-2"
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    {isEditingTitle ? (
                        <input
                            ref={titleInputRef}
                            value={titleDraft}
                            maxLength={64}
                            className="h-6 max-w-full border-0 border-b border-dashed bg-transparent px-0 text-left text-xs font-medium outline-none"
                            style={{ borderColor: theme.node.muted, color: theme.node.text }}
                            aria-label={t("canvas.node.renameHint")}
                            onFocus={() => setIsEditingTitle(true)}
                            onChange={(event) => setTitleDraft(event.target.value)}
                            onBlur={finishTitleEditing}
                            onKeyDown={(event) => {
                                if (event.key === "Enter") finishTitleEditing();
                                if (event.key === "Escape") {
                                    setTitleDraft(data.title || "");
                                    setIsEditingTitle(false);
                                }
                            }}
                        />
                    ) : (
                        <button
                            type="button"
                            className="block min-w-0 max-w-full truncate border-b border-dashed border-transparent px-0 py-0.5 text-left text-xs font-medium opacity-75 transition hover:border-current hover:opacity-100"
                            style={{ color: theme.node.text }}
                            title={t("canvas.node.renameHint")}
                            onDoubleClick={(event) => {
                                event.stopPropagation();
                                setIsEditingTitle(true);
                            }}
                        >
                            {data.title || t("canvas.node.untitled")}
                        </button>
                    )}
                    {(hovered || isSelected || isEditingTitle || isEditingContent) && generationDurationLabel ? <span className="shrink-0 text-[11px] font-medium tabular-nums opacity-55">{generationDurationLabel}</span> : null}
                    {mediaInfoLabel ? <span className="absolute left-full ml-2 whitespace-nowrap text-[11px] font-medium tabular-nums opacity-55">{mediaInfoLabel}</span> : null}
                </div>
            )}

            <div
                className="relative h-full w-full overflow-visible rounded-3xl border"
                style={{
                    background: isGroup ? groupColor?.background || theme.canvas.groupBackground : hasImageContent || hasVideoContent || transparentBg ? "transparent" : theme.node.fill,
                    borderColor: isGroup ? (isGroupDropTarget || isActive ? selectionBlue : groupColor?.border || theme.node.stroke) : hasImageContent ? imageBorderColor : isActive ? selectionBlue : isRelated ? theme.node.muted : transparentBg ? "transparent" : theme.node.stroke,
                    borderStyle: isGroup && !groupColor ? "dashed" : "solid",
                    boxShadow: isGroupDropTarget ? `0 0 0 2px ${selectionBlue}66, inset 0 0 0 999px ${selectionBlue}10` : isActive ? `0 0 0 1px ${selectionBlue}55` : isRelated ? `0 0 0 1px ${theme.node.muted}55, 0 18px 48px rgba(0,0,0,.14)` : undefined,
                }}
                onMouseDown={(event) => onMouseDown(event, data.id)}
                onDoubleClick={(event) => {
                    if (isBatchRoot) {
                        event.stopPropagation();
                        onToggleBatch?.(data.id);
                        return;
                    }
                    if (definition?.onDoubleClick && pluginContext) {
                        if (definition.onDoubleClick(pluginContext)) event.stopPropagation();
                        return;
                    }
                    if (data.type === CanvasNodeType.Image && hasImageContent) {
                        event.stopPropagation();
                        onViewImage?.(data);
                        return;
                    }
                    if (data.type !== CanvasNodeType.Text) return;
                    event.stopPropagation();
                    setIsEditingContent(true);
                }}
            >
                <div
                    className={`relative flex h-full w-full items-center justify-center rounded-[inherit] ${isBatchRoot || isGroup ? "overflow-visible" : "overflow-hidden"}`}
                    style={
                        {
                            background: isGroup ? "transparent" : hasImageContent || hasVideoContent || transparentBg ? "transparent" : theme.node.fill,
                            pointerEvents: contentInteractive ? undefined : "none",
                        } as React.CSSProperties
                    }
                >
                    {content}
                </div>

                {showImageInfo && hasImageContent ? <ImageInfoBar node={data} /> : null}

                {data.type === CanvasNodeType.Video && hasRunningStoryboard ? (
                    <div
                        className="pointer-events-none absolute left-3 top-3 z-30 grid size-8 place-items-center rounded-full border backdrop-blur-md"
                        style={{ background: `${theme.toolbar.panel}dd`, borderColor: theme.toolbar.border }}
                        aria-label="故事板生成中"
                    >
                        <LoaderCircle className="size-5 animate-spin text-amber-500" />
                    </div>
                ) : null}

                {!isGroup && !hasImageContent && !hasVideoContent && !hasAudioContent ? <div className="pointer-events-none absolute inset-x-0 bottom-0 h-12" style={{ background: `linear-gradient(to top, ${theme.canvas.background}66, transparent)` }} /> : null}

                <ResizeHandle corner="top-left" onMouseDown={handleResizeMouseDown} />
                <ResizeHandle corner="top-right" onMouseDown={handleResizeMouseDown} />
                <ResizeHandle corner="bottom-left" onMouseDown={handleResizeMouseDown} />
                <ResizeHandle corner="bottom-right" onMouseDown={handleResizeMouseDown} />
            </div>

            {!isGroup ? <ConnectionHandleDot side="left" visible={hovered || isSelected || isConnecting} onMouseDown={(event) => onConnectStart(event, data.id, "target")} /> : null}
            {!isGroup ? <ConnectionHandleDot side="right" visible={(definition?.hasSourceHandle ?? true) && data.type !== CanvasNodeType.Config && (hovered || isSelected || isConnecting)} onMouseDown={(event) => onConnectStart(event, data.id, "source")} /> : null}

            {showPanel && !isGroup && renderPanel ? <div className="absolute left-1/2 top-full z-[70] w-[600px] -translate-x-1/2 pt-4">{renderPanel(data)}</div> : null}
        </div>
    );
});

function NodeContent(props: NodeContentRendererProps) {
    if (props.node.type === CanvasNodeType.Config && props.renderNodeContent) return props.renderNodeContent(props.node);
    if (props.isBatchRoot) return <ImageNodeContent {...props} />;
    if (props.node.metadata?.status === "loading") return <LoadingContent node={props.node} theme={props.theme} />;
    if (props.node.metadata?.status === "error") return <ErrorContent node={props.node} theme={props.theme} onRetry={props.onRetry} />;

    const Renderer = nodeContentRenderers[props.node.type as CanvasNodeType];
    if (Renderer) return <Renderer {...props} />;

    // Render plugin nodes with their registered renderer, or show the missing-plugin placeholder.
    const definition = getNodeDefinition(props.node.type);
    if (definition?.Content && props.pluginContext) {
        const PluginContent = definition.Content;
        return <PluginContent ctx={props.pluginContext} />;
    }
    return <MissingPluginContent theme={props.theme} type={props.node.type} />;
}

const nodeContentRenderers = {
    [CanvasNodeType.Text]: TextContent,
    [CanvasNodeType.Image]: ImageNodeContent,
    [CanvasNodeType.Config]: EmptyImageContent,
    [CanvasNodeType.Video]: VideoNodeContent,
    [CanvasNodeType.Audio]: AudioNodeContent,
    [CanvasNodeType.Group]: GroupNodeContent,
} satisfies Record<CanvasNodeType, (props: NodeContentRendererProps) => ReactNode>;

function GroupNodeContent({ node, theme, isEditingTitle, titleInputRef, titleDraft, onTitleDraftChange, onStartTitleEditing, onFinishTitleEditing, onCancelTitleEditing, onGroupColorChange }: NodeContentRendererProps) {
    const { t } = useTranslation();
    const groupColor = canvasGroupColorAppearance(node.metadata?.groupColor);
    return (
        <div className="pointer-events-none relative flex h-full w-full flex-col p-4">
            <div
                data-group-drag-handle
                className="pointer-events-auto absolute bottom-full left-0 flex cursor-grab items-center gap-2 text-sm font-semibold active:cursor-grabbing"
                style={{
                    color: theme.node.text,
                    fontSize: 14,
                    // Cancel only the viewport zoom. Keep the memoized content independent of zoom renders.
                    transform: "scale(calc(1 / var(--canvas-node-scale, 1)))",
                    transformOrigin: "left bottom",
                    width: "max-content",
                    marginBottom: "calc(8px / var(--canvas-node-scale, 1))",
                }}
            >
                {isEditingTitle ? <span className="inline-grid">
                    <span aria-hidden="true" className="invisible col-start-1 row-start-1 whitespace-pre px-2 text-sm font-semibold" style={{ minWidth: 32 }}>{titleDraft || " "}</span>
                    <input
                    ref={titleInputRef}
                    value={titleDraft}
                    maxLength={64}
                    aria-label={t("canvas.node.groupRenameHint")}
                    title={t("canvas.node.groupRenameHint")}
                    className="pointer-events-auto col-start-1 row-start-1 h-6 w-full min-w-0 rounded-md border border-transparent bg-transparent px-2 text-sm font-semibold outline-none transition hover:border-current focus:border-current"
                    style={{ width: 0, minWidth: "100%", color: groupColor?.titleText || theme.node.text, background: groupColor?.titleBackground || theme.toolbar.activeBg }}
                    onFocus={onStartTitleEditing}
                    onChange={(event) => onTitleDraftChange(event.target.value)}
                    onBlur={onFinishTitleEditing}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onKeyDown={(event) => {
                        if (event.key === "Enter") {
                            event.preventDefault();
                            event.currentTarget.blur();
                        }
                        if (event.key === "Escape") onCancelTitleEditing();
                    }}
                /></span> : <CanvasGroupColorPicker value={node.metadata?.groupColor} onChange={color => onGroupColorChange?.(node.id, color)} disabled={!onGroupColorChange}>
                <button
                    type="button"
                    className="h-6 cursor-grab whitespace-pre rounded-md px-2 text-left text-sm font-semibold active:cursor-grabbing"
                    style={{ background: groupColor?.titleBackground || theme.toolbar.activeBg, color: groupColor?.titleText || theme.node.text }}
                    title={t("canvas.node.groupRenameHint")}
                    onMouseDown={(event) => event.preventDefault()}
                    onDoubleClick={(event) => {
                        event.stopPropagation();
                        onStartTitleEditing();
                    }}
                >{node.title || t("canvas.node.untitled")}</button>
                </CanvasGroupColorPicker>}
            </div>
            <div className="mt-3 flex-1 rounded-2xl border border-dashed" style={{ borderColor: groupColor ? "transparent" : theme.canvas.groupInnerBorder, background: groupColor ? "transparent" : theme.canvas.groupInnerBackground }} />
        </div>
    );
}

function LoadingContent({ node, theme }: Pick<NodeContentRendererProps, "node" | "theme">) {
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-4 text-center">
            <div className="size-10 animate-spin rounded-full border-2" style={{ borderColor: theme.node.stroke, borderTopColor: theme.node.activeStroke }} />
            <GenerationStatus node={node} />
        </div>
    );
}

function GenerationStatus({ node }: { node: CanvasNodeData }) {
    const [now, setNow] = useState(Date.now());
    const phase = node.metadata?.generationPhase || "packing";
    const progress = node.metadata?.generationProgress;
    const detail = node.metadata?.generationDetail;
    useEffect(() => {
        const timer = window.setInterval(() => setNow(Date.now()), 1_000);
        return () => window.clearInterval(timer);
    }, []);
    const elapsed = node.metadata?.generationPhaseStartedAt ? Math.max(0, Math.round((now - node.metadata.generationPhaseStartedAt) / 1_000)) : 0;
    return (
        <div className="max-w-[240px] space-y-1 text-center" style={{ color: canvasThemes[useThemeStore.getState().theme].node.text }}>
            <div className="text-xs leading-5">{getGenerationPhaseLabel(node, phase)}{typeof progress === "number" ? ` · ${Math.round(progress)}%` : ""}</div>
            {detail ? <div className="line-clamp-2 text-[10px] leading-4 opacity-70">{detail}</div> : null}
            {elapsed ? <div className="text-[10px] opacity-50">当前阶段 {elapsed} 秒</div> : null}
        </div>
    );
}

function ErrorContent({ node, theme, onRetry }: Pick<NodeContentRendererProps, "node" | "theme" | "onRetry">) {
    const { t } = useTranslation();
    const errorText = summarizeApiError(node.metadata?.errorDetails, t("canvas.node.failed"));
    return (
        <div className="flex max-w-[260px] flex-col items-center gap-3 px-5 text-center">
            <div className="line-clamp-4 text-xs leading-5 text-red-300" title={errorText}>
                {errorText}
            </div>
            {node.metadata?.generationFailedPhase ? <div className="text-[10px] opacity-70">失败阶段：{getGenerationPhaseLabel(node, node.metadata.generationFailedPhase)}</div> : null}
            <button
                type="button"
                className="inline-flex h-8 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition hover:scale-[1.02]"
                style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                onClick={(event) => {
                    event.stopPropagation();
                    onRetry?.(node);
                }}
                onMouseDown={(event) => event.stopPropagation()}
            >
                <RefreshCw className="size-3.5" />
                {t("canvas.node.retry")}
            </button>
        </div>
    );
}

function MissingPluginContent({ theme, type }: Pick<NodeContentRendererProps, "theme"> & { type: string }) {
    const { t } = useTranslation();
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-4 text-center" style={{ color: theme.node.placeholder }}>
            <Puzzle className="size-7 opacity-40" />
            <span className="text-sm">{t("canvas.node.missingPlugin")}</span>
            <span className="text-[11px] opacity-70">{t("canvas.node.missingPluginDescription", { type })}</span>
        </div>
    );
}

function TextContent({ node, theme, isEditingContent, textareaRef, mentionReferences, onContentChange, onStartEditing, onStopEditing, onGenerateImage }: NodeContentRendererProps) {
    const { t } = useTranslation();
    const fontSize = node.metadata?.fontSize || 14;
    const textStyle = { fontSize: `${fontSize}px`, lineHeight: `${Math.round(fontSize * 1.7)}px`, color: theme.node.body, boxSizing: "border-box" } as React.CSSProperties;

    return (
        <div className="flex h-full w-full flex-col overflow-hidden pt-8">
            <button
                type="button"
                className="absolute right-3 top-3 z-20 inline-flex h-8 items-center gap-1 rounded-full border px-2.5 text-xs font-medium opacity-85 backdrop-blur-md transition hover:scale-[1.02] hover:opacity-100"
                style={{ background: `${theme.toolbar.panel}dd`, borderColor: theme.node.stroke, color: theme.node.text }}
                onClick={(event) => {
                    event.stopPropagation();
                    onGenerateImage?.(node);
                }}
                onMouseDown={(event) => event.stopPropagation()}
                onPointerDown={(event) => event.stopPropagation()}
                title={t("canvas.node.generateImage")}
                aria-label={t("canvas.node.generateImage")}
            >
                <ImageIcon className="size-3.5" />
                {t("canvas.node.generate")}
            </button>
            {isEditingContent ? (
                <CanvasResourceMentionTextarea
                    ref={textareaRef}
                    className="thin-scrollbar block h-full w-full resize-none overflow-y-auto whitespace-pre-wrap break-words border-none bg-transparent pl-4 pr-14 pt-0 pb-4 m-0 font-sans outline-none select-text appearance-none"
                    style={textStyle}
                    value={node.metadata?.content || ""}
                    references={mentionReferences}
                    highlightLabels={false}
                    onChange={(value) => onContentChange(node.id, value)}
                    onBlur={onStopEditing}
                    onKeyDown={(event) => {
                        if (event.key === "Escape") onStopEditing();
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                    onWheel={(event) => event.stopPropagation()}
                />
            ) : (
                <div
                    className="thin-scrollbar block h-full w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent pl-4 pr-14 pt-0 pb-4 font-sans"
                    style={textStyle}
                    onMouseDown={(event) => {
                        if (event.button !== 0) return;
                        event.stopPropagation();
                        onStartEditing();
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onWheel={(event) => event.stopPropagation()}
                >
                    {node.metadata?.content || <span style={{ color: theme.node.placeholder }}>{t("canvas.node.editText")}</span>}
                </div>
            )}
        </div>
    );
}

function ImageNodeContent(props: NodeContentRendererProps) {
    if (!props.node.metadata?.content && !props.isBatchRoot) return <EmptyImageContent {...props} />;

    return (
        <ImageContent
            node={props.node}
            batchExpanded={props.batchExpanded}
            onToggleBatch={props.onToggleBatch}
            onSetBatchPrimary={props.onSetBatchPrimary}
            onDuplicateBatchImage={props.onDuplicateBatchImage}
            onDownloadBatchImage={props.onDownloadBatchImage}
            onRetryBatchImage={props.onRetryBatchImage}
            onDeleteBatchImage={props.onDeleteBatchImage}
            onViewBatchImage={props.onViewBatchImage}
            activeCinePackShot={props.activeCinePackShot}
            onSelectCinePackCharacterReference={props.onSelectCinePackCharacterReference}
        />
    );
}

function EmptyImageContent({ theme }: NodeContentRendererProps) {
    const { t } = useTranslation();
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: theme.node.placeholder }}>
            <div className="flex size-14 items-center justify-center rounded-2xl" style={{ background: theme.toolbar.activeBg }}>
                <ImageIcon className="size-6 opacity-30" />
            </div>
            <span className="text-[10px] tracking-[0.18em] opacity-50">{t("canvas.node.emptyImage")}</span>
        </div>
    );
}

function VideoNodeContent({ node, theme, isSelected }: NodeContentRendererProps) {
    const { t } = useTranslation();
    const source = node.metadata?.content || "";
    const [cover, setCover] = useState(() => cachedVideoPreview(source));
    const [playing, setPlaying] = useState(false);
    const [previewFailed, setPreviewFailed] = useState(false);
    useEffect(() => {
        if (isSelected) return suspendVideoPreviews();
    }, [isSelected]);
    useEffect(() => {
        let disposed = false;
        const controller = new AbortController();
        setCover(cachedVideoPreview(source));
        setPlaying(false);
        setPreviewFailed(false);
        if (source) void loadVideoPreview(source, controller.signal).then((image) => {
            if (!disposed) { setCover(image || undefined); setPreviewFailed(!image); }
        });
        return () => { disposed = true; controller.abort(); };
    }, [source]);
    if (!node.metadata?.content)
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-3" style={{ color: theme.node.placeholder }}>
                <Video className="size-7 opacity-35" />
                <span className="text-sm">{t("canvas.node.emptyVideo")}</span>
            </div>
        );
    return (
        <div className="relative h-full w-full bg-black" data-canvas-no-zoom>
            {!isSelected && !playing ? (
                cover ? <img src={cover} alt={node.title} draggable={false} className="h-full w-full object-cover" /> :
                    <div className="flex h-full w-full flex-col items-center justify-center gap-2 text-white/60">
                        {previewFailed ? <Video className="size-6" /> : <LoaderCircle className="size-6 animate-spin" />}<span className="text-xs">{previewFailed ? "点击选择后播放" : "正在加载预览"}</span>
                    </div>
            ) : (
                <CanvasVideoPlayer source={source} cover={cover} nodeId={node.id} onPlayingChange={setPlaying} />
            )}
            <div className="absolute inset-x-0 top-0 bottom-24 z-10" aria-hidden />
        </div>
    );
}

function AudioNodeContent({ node, theme }: NodeContentRendererProps) {
    const { t } = useTranslation();
    if (!node.metadata?.content)
        return (
            <div className="flex h-full w-full flex-col items-center justify-center gap-2" style={{ color: theme.node.placeholder }}>
                <Music2 className="size-7 opacity-35" />
                <span className="text-sm">{t("canvas.node.emptyAudio")}</span>
            </div>
        );
    return (
        <div className="flex h-full w-full flex-col justify-center gap-3 px-4" style={{ background: theme.node.fill, color: theme.node.text }}>
            <div className="flex min-w-0 items-center gap-2 text-sm opacity-70">
                <Music2 className="size-4 shrink-0" />
                <span className="truncate">{t("canvas.node.audio")}</span>
            </div>
            <audio src={node.metadata.content} preload="metadata" controls className="w-full" data-canvas-no-zoom />
        </div>
    );
}

function ImageContent({
    node,
    batchExpanded,
    onToggleBatch,
    onSetBatchPrimary,
    onDuplicateBatchImage,
    onDownloadBatchImage,
    onRetryBatchImage,
    onDeleteBatchImage,
    onViewBatchImage,
    activeCinePackShot,
    onSelectCinePackCharacterReference,
}: {
    node: CanvasNodeData;
    batchExpanded: boolean;
    onToggleBatch?: () => void;
    onSetBatchPrimary?: (imageId: string) => void;
    onDuplicateBatchImage?: (imageId: string) => void;
    onDownloadBatchImage?: (imageId: string) => void;
    onRetryBatchImage?: (imageId: string) => void;
    onDeleteBatchImage?: (imageId: string) => void;
    onViewBatchImage?: (imageId: string) => void;
    activeCinePackShot?: CanvasNodeData;
    onSelectCinePackCharacterReference?: (shotId: string, characterNodeId: string, referenceId: string) => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const images = node.metadata?.images || [];
    const batchCount = images.length;
    const isBatchRoot = batchCount > 1;
    const primaryImageId = node.metadata?.primaryImageId || images[0]?.id;
    const primaryImage = images.find((image) => image.id === primaryImageId);
    const primaryContent = primaryImage?.content || node.metadata?.content;
    const characterReferences = useMemo(() => cinePackCharacterReferences(node), [node]);
    const [previewCharacterReferenceId, setPreviewCharacterReferenceId] = useState(CINEPACK_BASE_CHARACTER_REFERENCE_ID);
    const [characterReferenceUrls, setCharacterReferenceUrls] = useState<Record<string, string>>({});
    const characterReferenceSignature = characterReferences.map((reference) => `${reference.id}:${reference.storageKey || reference.dataUrl}`).join("|");

    useEffect(() => {
        let current = true;
        void Promise.all(characterReferences.map(async (reference) => [reference.id, await resolveImageUrl(reference.storageKey, reference.dataUrl)] as const)).then((entries) => {
            if (current) setCharacterReferenceUrls(Object.fromEntries(entries));
        });
        return () => {
            current = false;
        };
    }, [characterReferenceSignature]);

    useEffect(() => {
        if (!characterReferences.some((reference) => reference.id === previewCharacterReferenceId)) setPreviewCharacterReferenceId(CINEPACK_BASE_CHARACTER_REFERENCE_ID);
    }, [characterReferenceSignature, previewCharacterReferenceId]);

    const boundCharacterReference = activeCinePackShot ? cinePackBoundCharacterReference(activeCinePackShot, node) : undefined;
    const activeCharacterReferenceId = activeCinePackShot ? boundCharacterReference?.id || CINEPACK_BASE_CHARACTER_REFERENCE_ID : previewCharacterReferenceId;
    const activeCharacterReference = characterReferences.find((reference) => reference.id === activeCharacterReferenceId);
    const displayedContent = characterReferences.length ? (activeCharacterReference?.available ? characterReferenceUrls[activeCharacterReference.id] || activeCharacterReference.dataUrl : "") : primaryContent;

    return (
        <BatchFrame batchCount={batchCount} batchExpanded={batchExpanded} onToggleBatch={onToggleBatch}>
            {batchExpanded
                ? images
                      .filter((image) => image.id !== primaryImageId)
                      .map((image, index) => <ExpandedImageCard key={image.id} node={node} image={image} index={index} onSetPrimary={() => onSetBatchPrimary?.(image.id)} onDuplicate={() => onDuplicateBatchImage?.(image.id)} onDownload={() => onDownloadBatchImage?.(image.id)} onRetry={() => onRetryBatchImage?.(image.id)} onDelete={() => onDeleteBatchImage?.(image.id)} onView={() => onViewBatchImage?.(image.id)} />)
                : null}
            <div className="h-full w-full overflow-hidden rounded-3xl">
                {displayedContent ? (
                    <img
                        src={displayedContent}
                        alt={activeCharacterReference ? `${node.title} · ${activeCharacterReference.name}` : node.title}
                        draggable={false}
                        onDragStart={(event) => event.preventDefault()}
                        className={`pointer-events-none block h-full w-full select-none ${node.metadata?.freeResize ? "object-fill" : "object-cover"}`}
                    />
                ) : activeCharacterReference && !activeCharacterReference.available ? (
                    <div className="flex h-full w-full flex-col items-center justify-center gap-2 px-5 text-center" style={{ color: theme.node.placeholder }}>
                        <ImageIcon className="size-7 opacity-45" />
                        <span className="text-xs">当前“{activeCharacterReference.name}”暂无参考图</span>
                        <span className="text-[10px] opacity-65">请先生成/上传该造型，或选择使用基础设定</span>
                    </div>
                ) : (
                    <ImageSlotStatus node={node} image={primaryImage} />
                )}
            </div>
            {characterReferences.length > 1 ? (
                <div className="absolute inset-x-2 bottom-2 z-30 flex gap-1.5 overflow-x-auto rounded-xl border border-white/15 bg-black/70 p-1.5 text-white shadow-lg backdrop-blur-md" data-canvas-no-zoom>
                    {characterReferences.map((reference) => {
                        const url = characterReferenceUrls[reference.id] || reference.dataUrl;
                        const active = reference.id === activeCharacterReferenceId;
                        return (
                            <button
                                key={reference.id}
                                type="button"
                                title={`${reference.name}${reference.available ? "" : "（无已导入图片）"}${activeCinePackShot ? ` · 应用于${activeCinePackShot.title}` : " · 仅预览"}`}
                                className={`flex min-w-[92px] items-center gap-1.5 rounded-lg border px-1.5 py-1 text-left text-[10px] transition ${active ? "border-blue-400 bg-blue-500/25" : "border-white/10 bg-white/5 hover:bg-white/10"} ${reference.available ? "" : "opacity-55"}`}
                                onClick={(event) => {
                                    event.stopPropagation();
                                    if (activeCinePackShot && onSelectCinePackCharacterReference) onSelectCinePackCharacterReference(activeCinePackShot.id, node.id, reference.id);
                                    else setPreviewCharacterReferenceId(reference.id);
                                }}
                                onMouseDown={(event) => event.stopPropagation()}
                                onPointerDown={(event) => event.stopPropagation()}
                            >
                                {url ? <img src={url} alt="" className="size-7 shrink-0 rounded object-cover" /> : <span className="grid size-7 shrink-0 place-items-center rounded bg-white/10"><ImageIcon className="size-3.5" /></span>}
                                <span className="line-clamp-2 leading-3">{reference.name}</span>
                            </button>
                        );
                    })}
                </div>
            ) : null}
            {primaryImage?.status === "error" ? <BatchImageFailureActions placement="left" onRetry={() => onRetryBatchImage?.(primaryImage.id)} onDelete={() => onDeleteBatchImage?.(primaryImage.id)} /> : null}
            {isBatchRoot ? (
                <button
                    type="button"
                    className="absolute right-2.5 top-2.5 z-30 flex h-8 items-center justify-center gap-1.5 rounded-full border px-3 text-xs font-semibold shadow-[0_6px_18px_rgba(28,25,23,.16)] backdrop-blur-md transition hover:scale-[1.02]"
                    style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }}
                    aria-label={batchExpanded ? t("canvas.node.batchExpanded") : t("canvas.node.batchCollapsed")}
                    title="展开为独立图片，每张可单独编辑；撤销可恢复图片组"
                    onClick={(event) => {
                        event.stopPropagation();
                        onToggleBatch?.();
                    }}
                    onMouseDown={(event) => event.stopPropagation()}
                    onPointerDown={(event) => event.stopPropagation()}
                >
                    <span className="leading-none">{t("canvas.controls.images", { count: batchCount })}</span>
                    <ChevronRight className={`size-3.5 opacity-80 transition-transform ${batchExpanded ? "rotate-90" : ""}`} />
                </button>
            ) : null}
        </BatchFrame>
    );
}

function ExpandedImageCard({ node, image, index, onSetPrimary, onDuplicate, onDownload, onRetry, onDelete, onView }: { node: CanvasNodeData; image: CanvasNodeImage; index: number; onSetPrimary: () => void; onDuplicate: () => void; onDownload: () => void; onRetry: () => void; onDelete: () => void; onView: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const count = node.metadata?.images?.length || 0;
    const columns = Math.min(count, 4);
    const rows = Math.ceil(count / columns);
    const rootSlot = (rows - 1) * columns;
    const slot = index >= rootSlot ? index + 1 : index;
    const column = slot % columns;
    const row = Math.floor(slot / columns);
    const x = column * (node.width + 18);
    const y = (row - rows + 1) * (node.height + 18);

    return (
        <div
            className="absolute z-20 overflow-hidden rounded-3xl border shadow-[0_18px_50px_rgba(28,25,23,.18)]"
            style={
                {
                    left: x,
                    top: y,
                    width: node.width,
                    height: node.height,
                    background: theme.node.panel,
                    borderColor: theme.node.stroke,
                    "--batch-from-x": `${-x}px`,
                    "--batch-from-y": `${-y}px`,
                    "--batch-from-rotate": `${4 + index * 2}deg`,
                    animation: `canvas-batch-child-in 320ms ${index * 35}ms cubic-bezier(.2,.85,.18,1) both`,
                } as React.CSSProperties
            }
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onDoubleClick={(event) => {
                event.stopPropagation();
                if (image.content) onView();
            }}
        >
            {image.content ? <img src={image.content} alt={node.title} draggable={false} className="pointer-events-none h-full w-full select-none object-cover" /> : <ImageSlotStatus node={node} image={image} />}
            {image.content && image.generationDurationMs ? <span className="pointer-events-none absolute bottom-2 left-2 rounded-md bg-black/55 px-2 py-1 text-[11px] font-medium tabular-nums text-white backdrop-blur-sm">{formatGenerationDuration(image.generationDurationMs)}</span> : null}
            {image.content ? (
                <div className="absolute inset-x-2 top-2 flex items-center gap-1">
                    <button type="button" className="flex h-8 min-w-0 flex-1 items-center justify-center gap-1 rounded-lg border px-1.5 text-[10px] font-medium shadow-[0_6px_18px_rgba(15,23,42,.16)] backdrop-blur-md transition hover:scale-[1.02]" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }} title={t("common.download")} onClick={(event) => (event.stopPropagation(), onDownload())}>
                        <Download className="size-3 shrink-0" />
                        <span className="truncate">{t("common.download")}</span>
                    </button>
                    <button type="button" className="flex h-8 min-w-0 flex-1 items-center justify-center gap-1 rounded-lg border px-1.5 text-[10px] font-medium shadow-[0_6px_18px_rgba(15,23,42,.16)] backdrop-blur-md transition hover:scale-[1.02]" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }} title={t("canvas.node.createCopy")} onClick={(event) => (event.stopPropagation(), onDuplicate())}>
                        <Copy className="size-3 shrink-0" />
                        <span className="truncate">{t("canvas.node.createCopy")}</span>
                    </button>
                    <button type="button" className="flex h-8 min-w-0 flex-1 items-center justify-center gap-1 rounded-lg border px-1.5 text-[10px] font-medium shadow-[0_6px_18px_rgba(15,23,42,.16)] backdrop-blur-md transition hover:scale-[1.02]" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.activeText }} title={t("canvas.node.setPrimary")} onClick={(event) => (event.stopPropagation(), onSetPrimary())}>
                        <Star className="size-3 shrink-0" style={{ color: selectionBlue }} />
                        <span className="truncate">{t("canvas.node.setPrimary")}</span>
                    </button>
                </div>
            ) : null}
            {image.status === "error" ? <BatchImageFailureActions placement="right" onRetry={onRetry} onDelete={onDelete} /> : null}
        </div>
    );
}

function BatchImageFailureActions({ placement, onRetry, onDelete }: { placement: "left" | "right"; onRetry: () => void; onDelete: () => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    return (
        <div className={`absolute top-3 z-30 flex items-center gap-1.5 ${placement === "left" ? "left-3" : "right-3"}`}>
            <button type="button" className="flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium shadow-sm transition hover:scale-[1.02]" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }} onClick={(event) => (event.stopPropagation(), onRetry())}>
                <RefreshCw className="size-3.5" />
                {t("canvas.node.retry")}
            </button>
            <button type="button" className="grid size-8 place-items-center rounded-lg border shadow-sm transition hover:scale-[1.02]" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }} onClick={(event) => (event.stopPropagation(), onDelete())} aria-label={t("common.delete")} title={t("common.delete")}>
                <Trash2 className="size-3.5" />
            </button>
        </div>
    );
}

function ImageSlotStatus({ node, image }: { node: CanvasNodeData; image?: CanvasNodeImage }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const { t } = useTranslation();
    const failed = image?.status === "error";
    return (
        <div className="flex h-full w-full flex-col items-center justify-center gap-3 px-6 text-center" style={{ background: theme.node.fill, color: failed ? theme.node.text : theme.node.activeStroke }}>
            {failed ? <span className="line-clamp-3 text-xs leading-5" title={summarizeApiError(image.errorDetails, t("canvas.node.failed"))}>{summarizeApiError(image.errorDetails, t("canvas.node.failed"))}</span> : <div className="size-10 animate-spin rounded-full border-2" style={{ borderColor: theme.node.stroke, borderTopColor: theme.node.activeStroke }} />}
            {failed && node.metadata?.generationFailedPhase ? <span className="text-[10px] opacity-70">失败阶段：{getGenerationPhaseLabel(node, node.metadata.generationFailedPhase)}</span> : null}
            {!failed ? <GenerationStatus node={node} /> : null}
        </div>
    );
}

function ImageInfoBar({ node }: { node: CanvasNodeData }) {
    const size = formatBytes(node.metadata?.bytes || 0);
    if (!size) return null;
    return (
        <div className="pointer-events-none absolute bottom-3 right-3 z-40 max-w-[calc(100%-24px)]">
            <span className="max-w-full truncate rounded-md bg-black/55 px-2 py-1 text-[11px] font-medium leading-none text-white backdrop-blur-sm">
                {size}
            </span>
        </div>
    );
}

function BatchFrame({ batchCount, batchExpanded, onToggleBatch, children }: { batchCount: number; batchExpanded: boolean; onToggleBatch?: () => void; children: ReactNode }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const isBatchRoot = batchCount > 1;
    return (
        <div
            className="group/batch relative h-full w-full overflow-visible"
            onDoubleClick={
                isBatchRoot
                    ? (event) => {
                          event.stopPropagation();
                          onToggleBatch?.();
                      }
                    : undefined
            }
        >
            {isBatchRoot ? (
                <div className="pointer-events-none absolute inset-0 overflow-visible">
                    {Array.from({ length: Math.min(batchCount - 1, 3) }).map((_, index) => (
                        <div
                            key={index}
                            className="absolute rounded-[inherit] border shadow-[0_10px_24px_rgba(68,64,60,.12)] transition-all duration-300 group-hover/batch:translate-x-1"
                            style={{
                                inset: 0,
                                background: `linear-gradient(135deg, ${theme.node.panel}, ${theme.node.fill})`,
                                borderColor: theme.node.stroke,
                                opacity: batchExpanded ? 0 : 1,
                                transform: `translate(${10 + index * 6}px, ${4 + index * 3}px) rotate(${1.5 + index}deg)`,
                                zIndex: -index - 1,
                            }}
                        />
                    ))}
                </div>
            ) : null}
            {children}
        </div>
    );
}
function ResizeHandle({ corner, onMouseDown }: { corner: ResizeCorner; onMouseDown: (event: React.MouseEvent, corner: ResizeCorner) => void }) {
    const positionClass = {
        "top-left": "-left-[14px] -top-[14px] cursor-nwse-resize",
        "top-right": "-right-[14px] -top-[14px] cursor-nesw-resize",
        "bottom-left": "-bottom-[14px] -left-[14px] cursor-nesw-resize",
        "bottom-right": "-bottom-[14px] -right-[14px] cursor-nwse-resize",
    }[corner];

    return <div
        data-node-resize-handle={corner}
        className={`absolute z-50 size-7 ${positionClass}`}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => onMouseDown(event, corner)}
    />;
}

function ConnectionHandleDot({ side, visible, onMouseDown }: { side: "left" | "right"; visible: boolean; onMouseDown: (event: React.MouseEvent) => void }) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];

    return (
        <div
            className={`absolute top-1/2 z-30 flex size-12 -translate-y-1/2 cursor-crosshair items-center justify-center transition-opacity duration-150 ${
                side === "left" ? "-left-6" : "-right-6"
            } ${visible ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0"}`}
            onMouseDown={onMouseDown}
        >
            <div className="size-3 rounded-full border-2 transition-all hover:scale-125" style={{ background: theme.node.panel, borderColor: theme.node.muted }} />
        </div>
    );
}

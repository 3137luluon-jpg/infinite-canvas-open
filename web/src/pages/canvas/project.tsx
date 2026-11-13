import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { canvasInteractionActive } from "@/lib/canvas/canvas-interaction";
import type { ChangeEvent as ReactChangeEvent, DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ChevronLeft, ChevronRight, Group, Video, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { requestEdit, requestGeneration, requestImageQuestion, type ImageGenerationTask, type ImageRequestOptions } from "@/services/api/image";
import { getZealmanWorkflowUsage, isZealmanWorkflowModel } from "@/services/api/zealman-comfyui";
import { requestAudioGeneration, storeGeneratedAudio } from "@/services/api/audio";
import { createVideoGenerationTask, pollVideoGenerationTask, storeGeneratedVideo } from "@/services/api/video";
import { defaultConfig, modelOptionLabel, resolveModelForCapability, resolveModelRequestConfig, useConfigStore, useEffectiveConfig, waitForConfigHydration } from "@/stores/use-config-store";
import { deleteStoredImages, getImageBlob, uploadImage } from "@/services/image-storage";
import { getMediaBlob, uploadMediaFile } from "@/services/file-storage";
import { trimVideo, videoFileExtension } from "@/lib/canvas/trim-video";
import { nanoid } from "nanoid";
import { summarizeApiError } from "@/lib/api-error";
import { isOfficialOpenAiImageUrl } from "@/lib/openai-image";
import { isChatgpt2ApiUrl, normalizeImageAspect } from "@/lib/apimart-image";
import { applyLoadedImageDimensions } from "@/lib/canvas/loaded-image-dimensions";
import { downloadFile } from "@/lib/download-file";
import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { useAssetStore } from "@/stores/use-asset-store";
import { useThemeStore } from "@/stores/use-theme-store";
import { cropDataUrl, splitDataUrl, upscaleDataUrl } from "@/lib/canvas/canvas-image-data";
import { fitNodeSize, MEDIA_NODE_LONG_EDGE, nodeSizeFromRatio } from "@/lib/canvas/canvas-node-size";
import { reuseMentionResourceNodes } from "@/lib/canvas/canvas-resource-nodes";
import { backupGeneratedCanvasMedia, writeGeneratedBlob, type CanvasFolderLabels } from "@/lib/canvas/canvas-local-folders";
import { listResumableJobs, markJobsStoppedForNodes, patchGenerationJob } from "@/lib/canvas/generation-job-store";
import { attachRemoteTaskToJob, beginCanvasGenerationJob, resumeCanvasGenerationJobs } from "@/lib/canvas/resume-generation-jobs";
import { App, Button, Modal } from "antd";
import { NODE_DEFAULT_SIZE, getNodeSpec } from "@/constant/canvas";
import { ActiveConnectionPath, ConnectionPath } from "@/components/canvas/canvas-connections";
import { CanvasConfigComposer } from "@/components/canvas/canvas-config-composer";
import { CanvasImagePreview } from "@/components/canvas/canvas-image-preview";
import { CanvasConfigNodePanel } from "@/components/canvas/canvas-config-node-panel";
import { CanvasNodeContextMenu } from "@/components/canvas/canvas-context-menu";
import { CanvasLocalFoldersModal } from "@/components/canvas/canvas-local-folders-modal";
import { CanvasDiskMediaModal } from "@/components/canvas/canvas-disk-media-modal";
import { watchProjectDiskMedia } from "@/lib/canvas/canvas-disk-backup";
import { CanvasNodeAngleDialog, type CanvasImageAngleParams } from "@/components/canvas/canvas-node-angle-dialog";
import { CanvasNodeCropDialog, type CanvasImageCropRect } from "@/components/canvas/canvas-node-crop-dialog";
import { CanvasNodeMaskEditDialog, type CanvasImageMaskEditPayload } from "@/components/canvas/canvas-node-mask-edit-dialog";
import { CanvasNodeSplitDialog, type CanvasImageSplitParams } from "@/components/canvas/canvas-node-split-dialog";
import { CanvasNodeUpscaleDialog, type CanvasImageUpscaleParams } from "@/components/canvas/canvas-node-upscale-dialog";
import { imageGenerationReferences, buildNodeGenerationContext, buildNodeGenerationInputs, buildNodeResponseMessages, hydrateNodeGenerationContext, nodeGenerationReferenceIssue, type NodeGenerationInput } from "@/components/canvas/canvas-node-generation";
import { CanvasNodeHoverToolbar, CanvasNodeInfoModal } from "@/components/canvas/canvas-node-hover-toolbar";
import { CanvasVideoTrimDialog } from "@/components/canvas/canvas-video-trim-dialog";
import { AssetDetailModal, type NewAssetDraft } from "@/components/assets/asset-detail-modal";
import { InfiniteCanvas } from "@/components/canvas/infinite-canvas";
import { Minimap } from "@/components/canvas/canvas-mini-map";
import { CanvasNode } from "@/components/canvas/canvas-node";
import { CanvasNodePromptPanel, type CanvasNodeGenerationMode } from "@/components/canvas/canvas-node-prompt-panel";
import { alignCanvasSelection, canvasAlignmentSelection, type CanvasAlignment } from "@/lib/canvas/canvas-alignment";
import { CanvasToolbar } from "@/components/canvas/canvas-toolbar";
import { CanvasSelectionConnector } from "@/components/canvas/canvas-selection-connector";
import { appendGenerationReferences, marqueeSelectsNode, reorderGenerationReferences, selectedReferenceImages, selectedReferenceResources } from "@/lib/canvas/batch-generation-references";
import { expandImageBatch } from "@/lib/canvas/expand-image-batch";
import type { InsertAssetPayload } from "@/components/canvas/asset-picker-modal";
import { CanvasSidePanel } from "@/components/canvas/canvas-side-panel";
import { CanvasZoomControls } from "@/components/canvas/canvas-zoom-controls";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { useAgentBridge, type AgentGenerateNode } from "@/pages/canvas/hooks/use-agent-bridge";
import { LocalAgentPanel } from "@/components/agent/local-agent-panel";
import { usePluginHost } from "@/pages/canvas/hooks/use-plugin-host";
import { buildNodeMentionReferences, resolveCanvasReferenceImages, type CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { fitCinePackVideoPrompt, isCinePackVideoShotNode, repairCinePackVideoPrompts } from "@/lib/canvas/cinepack-video-prompt";
import { selectCinePackCharacterReference } from "@/lib/canvas/cinepack-character-looks";
import { compileKinStoryboardPlan, isStoryboardNode, mentionedStoryboardReferences, storyboardNodesFor } from "@/lib/canvas/storyboard-generation";
import { applyNodeConfigPatch, audioMetadata, buildAudioGenerationMetadata, buildImageGenerationMetadata, createCanvasNode, defaultVideoNodeMetadata, imageMetadata, videoMetadata } from "@/lib/canvas/canvas-node-factory";
import { findContainingGroupId, findGroupDropTarget, getConnectionTargetAnchor, nodeBounds, normalizeConnection, snapNodesIntoGroup } from "@/lib/canvas/canvas-node-geometry";
import {
    audioExtension,
    buildAngleLabel,
    buildAnglePrompt,
    buildGenerationConfig,
    findRetrySourceNode,
    generationReferenceUrls,
    getGenerationCount,
    buildBatchImagePrompt,
    getInputSummary,
    hydrateAssistantImages,
    hydrateCanvasImages,
    imageExtension,
    isAudioFile,
    isGenerationCanceled,
    patchNodeGenerationUi,
    resetInterruptedGeneration,
    resolveMetadataReferences,
    sourceNodeReferenceImages,
} from "@/lib/canvas/canvas-generation-helpers";
import { getNodeDefinition, isBuiltinNodeType as isBuiltinType, useNodeRegistryVersion } from "@/lib/canvas/node-registry";
import { registerBuiltinNodes } from "@/components/canvas/nodes/builtin-nodes";
import { CanvasPluginManagerModal } from "@/components/canvas/canvas-plugin-manager-modal";
import { CanvasRefreshShell } from "@/components/canvas/canvas-refresh-shell";
import { CanvasTopBar } from "@/components/canvas/canvas-top-bar";
import { CanvasJianyingExport } from "@/components/canvas/canvas-jianying-export";
import { buildVideoLibrary, currentVideoOrganization, inheritVideoOrganization, preservePreviousVideo, type VideoLibrarySection } from "@/lib/canvas/video-library";
import { ConnectionCreateMenu, NodeCreateMenu, type PendingConnectionCreate } from "@/components/canvas/canvas-create-menus";
import {
    CanvasNodeType,
    type CanvasGenerationPhase,
    type CanvasAssistantImage,
    type CanvasAssistantSession,
    type CanvasConnection,
    type CanvasNodeData,
    type CanvasNodeImage,
    type CanvasNodeMetadata,
    type CanvasNodeTypeId,
    type ConnectionHandle,
    type ContextMenuState,
    type Position,
    type SelectionBox,
    type ViewportTransform,
} from "@/types/canvas";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio } from "@/types/media";

// Register built-in nodes in the shared registry once when the module loads.
registerBuiltinNodes();

type CanvasClipboard = {
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
};

type ConnectionDropTarget = {
    nodeId: string | null;
    isNearNode: boolean;
};

type CanvasHistoryEntry = Pick<CanvasClipboard, "nodes" | "connections"> & {
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
};

type CanvasGenerationRequest = {
    targetNodeId: string;
    originNodeId: string;
    runningNodeId: string;
    controller: AbortController;
};

// Stable empty reference array prevents `... || []` from invalidating CanvasNode's React.memo on every render.
const EMPTY_REFERENCES: CanvasResourceReference[] = [];
const EMPTY_NODES: CanvasNodeData[] = [];
const CONNECTION_HANDLE_HIT_RADIUS = 40;
const CONNECTION_NODE_HIT_PADDING = 32;
const NODE_STATUS_IDLE = "idle" as const;
const NODE_STATUS_LOADING = "loading" as const;
const NODE_STATUS_SUCCESS = "success" as const;
const NODE_STATUS_ERROR = "error" as const;

function sameVisibleNodeReferences(previous: CanvasNodeData[], next: CanvasNodeData[]) {
    const previousVisible = previous.filter((node) => !isStoryboardNode(node));
    const nextVisible = next.filter((node) => !isStoryboardNode(node));
    return previousVisible.length === nextVisible.length && previousVisible.every((node, index) => node === nextVisible[index]);
}

function nextMediaNodeTitle(nodes: CanvasNodeData[], type: CanvasNodeType.Image | CanvasNodeType.Video, replacedNodeId?: string) {
    const prefix = type === CanvasNodeType.Image ? "图片" : "视频";
    const retainedNodes = nodes.filter((node) => node.id !== replacedNodeId && !isStoryboardNode(node));
    const titles = new Set(retainedNodes.map((node) => node.title));
    let index = retainedNodes.filter((node) => node.type === type).length + 1;
    while (titles.has(`${prefix}${index}`)) index += 1;
    return `${prefix}${index}`;
}

// 复制资产：保留媒体内容，清空提示词、引用、生成相关元数据，类似新导入的资产
function stripMetadataForAssetCopy(source?: CanvasNodeMetadata): CanvasNodeMetadata | undefined {
    if (!source) return source;
    const out: CanvasNodeMetadata = {
        content: source.content,
        status: source.content ? "success" : "idle",
        storageKey: source.storageKey,
        mimeType: source.mimeType,
        bytes: source.bytes,
        naturalWidth: source.naturalWidth,
        naturalHeight: source.naturalHeight,
        durationMs: source.durationMs,
        generationDurationMs: source.generationDurationMs,
        fontSize: source.fontSize,
        freeResize: source.freeResize,
        groupId: source.groupId,
    };
    if (source.images?.length) out.images = source.images;
    if (source.primaryImageId) out.primaryImageId = source.primaryImageId;
    return out;
}

// 复制节点：保留提示词和引用，清空已生成的资源、故事板、生成状态
function stripMetadataForNodeCopy(source?: CanvasNodeMetadata): CanvasNodeMetadata | undefined {
    if (!source) return source;
    return {
        composerContent: source.composerContent,
        prompt: source.prompt,
        status: "idle",
        generationMode: source.generationMode,
        generationType: source.generationType,
        model: source.model,
        reasoningEffort: source.reasoningEffort,
        size: source.size,
        quality: source.quality,
        background: source.background,
        count: source.count,
        seconds: source.seconds,
        vquality: source.vquality,
        generateAudio: source.generateAudio,
        watermark: source.watermark,
        audioVoice: source.audioVoice,
        audioFormat: source.audioFormat,
        audioSpeed: source.audioSpeed,
        audioInstructions: source.audioInstructions,
        references: source.references ? [...source.references] : undefined,
        fontSize: source.fontSize,
        freeResize: source.freeResize,
        groupId: source.groupId,
    };
}

export default function CanvasPage() {
    const [mounted, setMounted] = useState(false);
    const { id } = useParams();
    const pendingProject = useCanvasStore(state => mounted ? null : state.projects.find(project => project.id === id));

    useEffect(() => {
        setMounted(true);
    }, []);

    if (!mounted) return <CanvasRefreshShell backgroundMode={pendingProject?.backgroundMode} viewport={pendingProject?.viewport} />;

    return <InfiniteCanvasPage />;
}

function InfiniteCanvasPage() {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    // Subscribe to the registry version so plugin registration changes rerender the canvas.
    const nodeRegistryVersion = useNodeRegistryVersion((state) => state.version);
    const params = useParams<{ id: string }>();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const projectId = params.id || "";
    const containerRef = useRef<HTMLDivElement>(null);
    const imageInputRef = useRef<HTMLInputElement>(null);
    const uploadTargetRef = useRef<{ nodeId?: string; position?: Position } | null>(null);
    const clipboardRef = useRef<CanvasClipboard | null>(null);
    const historyRef = useRef<{ past: CanvasHistoryEntry[]; future: CanvasHistoryEntry[] }>({ past: [], future: [] });
    const lastHistoryRef = useRef<CanvasHistoryEntry | null>(null);
    const historyCommitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const viewportSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const applyingHistoryRef = useRef(false);
    const historyPausedRef = useRef(false);
    const didInitialCenterRef = useRef(false);
    const rafRef = useRef<number | null>(null);
    const nodeDraggingRef = useRef(false);
    const dragRef = useRef<{
        isDraggingNode: boolean;
        hasMoved: boolean;
        startX: number;
        startY: number;
        initialSelectedNodes: { id: string; x: number; y: number }[];
        duplicatedNodeIds: string[];
        originalSelectedNodeIds: string[];
    }>({
        isDraggingNode: false,
        hasMoved: false,
        startX: 0,
        startY: 0,
        initialSelectedNodes: [],
        duplicatedNodeIds: [],
        originalSelectedNodeIds: [],
    });

    const config = useConfigStore((state) => state.config);
    const effectiveConfig = useEffectiveConfig();
    const isAiConfigReady = useConfigStore((state) => state.isAiConfigReady);
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const cleanupAssetImages = useAssetStore((state) => state.cleanupImages);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const openProject = useCanvasStore((state) => state.openProject);
    const updateProject = useCanvasStore((state) => state.updateProject);
    const renameProject = useCanvasStore((state) => state.renameProject);
    const currentProject = useCanvasStore((state) => state.projects.find((project) => project.id === projectId));
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const [nodes, setNodes] = useState<CanvasNodeData[]>([]);
    const [connections, setConnections] = useState<CanvasConnection[]>([]);
    const [chatSessions, setChatSessions] = useState<CanvasAssistantSession[]>([]);
    const [activeChatId, setActiveChatId] = useState<string | null>(null);
    const [viewport, setViewport] = useState<ViewportTransform>({ x: 0, y: 0, k: 1 });
    const [referenceReturn, setReferenceReturn] = useState<{ projectId: string; nodeId: string; viewport: ViewportTransform } | null>(null);
    const [size, setSize] = useState({ width: 1200, height: 720 });
    const [selectedNodeIds, setSelectedNodeIds] = useState<Set<string>>(new Set());
    const [selectedConnectionId, setSelectedConnectionId] = useState<string | null>(null);
    const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null);
    const [connectingParams, setConnectingParams] = useState<ConnectionHandle | null>(null);
    const [connectionTargetNodeId, setConnectionTargetNodeId] = useState<string | null>(null);
    const [pendingConnectionCreate, setPendingConnectionCreate] = useState<PendingConnectionCreate | null>(null);
    const [mouseWorld, setMouseWorld] = useState<Position>({ x: 0, y: 0 });
    const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
    const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
    const [nodeCreatePosition, setNodeCreatePosition] = useState<Position | null>(null);
    const [runningNodeId, setRunningNodeId] = useState<string | null>(null);
    const [isMiniMapOpen, setIsMiniMapOpen] = useState(false);
    const [backgroundMode, setBackgroundMode] = useState<CanvasBackgroundMode>("lines");
    const [showImageInfo, setShowImageInfo] = useState(false);
    const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
    const [deleteConfirm, setDeleteConfirm] = useState<{ ids: Set<string> } | null>(null);
    const [newAssetDraft, setNewAssetDraft] = useState<NewAssetDraft | null>(null);
    const [projectLoaded, setProjectLoaded] = useState(false);
    const [restoreMetrics, setRestoreMetrics] = useState<Record<string, number>>({});
    const [toolbarNodeId, setToolbarNodeId] = useState<string | null>(null);
    const [nodeImageSettingsOpen, setNodeImageSettingsOpen] = useState(false);
    const [dialogNodeId, setDialogNodeId] = useState<string | null>(null);
    const [editingNodeId, setEditingNodeId] = useState<string | null>(null);
    const [editRequestNonce, setEditRequestNonce] = useState(0);
    const [renamingNodeId, setRenamingNodeId] = useState<string | null>(null);
    const [renameRequestNonce, setRenameRequestNonce] = useState(0);
    const [infoNodeId, setInfoNodeId] = useState<string | null>(null);
    const [pluginManagerOpen, setPluginManagerOpen] = useState(false);
    const [localFoldersOpen, setLocalFoldersOpen] = useState(false);
    const [legacyFoldersOpen, setLegacyFoldersOpen] = useState(false);
    const [jianyingSelection, setJianyingSelection] = useState<{ projectId: string; sections: VideoLibrarySection[]; selectedIds: Set<string> } | null>(null);
    const resumeJobIdsRef = useRef(new Set<string>());
    const resumeAbortRef = useRef<AbortController | null>(null);
    const [cropNodeId, setCropNodeId] = useState<string | null>(null);
    const [maskEditNodeId, setMaskEditNodeId] = useState<string | null>(null);
    const [splitNodeId, setSplitNodeId] = useState<string | null>(null);
    const [trimNodeId, setTrimNodeId] = useState<string | null>(null);
    const [trimStart, setTrimStart] = useState(0);
    const [trimEnd, setTrimEnd] = useState(4);
    const [trimDuration, setTrimDuration] = useState(0);
    const [trimming, setTrimming] = useState(false);
    const [trimProgress, setTrimProgress] = useState(0);
    const [upscaleNodeId, setUpscaleNodeId] = useState<string | null>(null);
    const [superResolveNodeId, setSuperResolveNodeId] = useState<string | null>(null);
    const [angleNodeId, setAngleNodeId] = useState<string | null>(null);
    const [previewNodeId, setPreviewNodeId] = useState<string | null>(null);
    const [previewImageId, setPreviewImageId] = useState<string | null>(null);
    const [titleEditing, setTitleEditing] = useState(false);
    const [titleDraft, setTitleDraft] = useState("");
    const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
    const [expandedImageNodeId, setExpandedImageNodeId] = useState<string | null>(null);
    const [isNodeDragging, setIsNodeDragging] = useState(false);
    const [isNodeResizing, setIsNodeResizing] = useState(false);
    const [dropTargetGroupId, setDropTargetGroupId] = useState<string | null>(null);

    const nodesRef = useRef(nodes);
    const connectionsRef = useRef(connections);
    const selectedNodeIdsRef = useRef(selectedNodeIds);
    const viewportRef = useRef(viewport);
    const focusAnimRef = useRef<number | null>(null);
    const commitCanvasNodes = useCallback(
        async (updater: (current: CanvasNodeData[]) => CanvasNodeData[], checkpoint = false) => {
            const next = updater(nodesRef.current);
            nodesRef.current = next;
            setNodes(next);
            updateProject(projectId, checkpoint ? { nodes: next, connections: connectionsRef.current } : { nodes: next });
            await (checkpoint ? useCanvasStore.getState().flushPersistSnapshot() : useCanvasStore.getState().flushPersist());
        },
        [projectId, updateProject],
    );
    const generateNodeRef = useRef<AgentGenerateNode | null>(null);
    const connectingParamsRef = useRef(connectingParams);
    const connectionTargetNodeIdRef = useRef(connectionTargetNodeId);
    const selectionBoxRef = useRef(selectionBox);
    const selectionSvgRef = useRef<SVGSVGElement>(null);
    const selectionFrameRef = useRef<number | null>(null);
    const selectionPointerRef = useRef<number | null>(null);
    const selectionClientRef = useRef({ x: 0, y: 0 });
    const clearMarquee = useCallback(() => {
        if (selectionFrameRef.current !== null) cancelAnimationFrame(selectionFrameRef.current);
        selectionFrameRef.current = null;
        selectionPointerRef.current = null;
        selectionBoxRef.current = null;
        if (containerRef.current) delete containerRef.current.dataset.canvasSelecting;
        setSelectionBox(null);
    }, []);
    useEffect(() => () => {
        if (selectionFrameRef.current !== null) cancelAnimationFrame(selectionFrameRef.current);
    }, []);
    const pendingConnectionCreateRef = useRef(pendingConnectionCreate);
    const generationRequestsRef = useRef(new Map<string, CanvasGenerationRequest>());
    const createHistoryEntry = useCallback(
        (): CanvasHistoryEntry => ({
            nodes: nodesRef.current,
            connections: connectionsRef.current,
            chatSessions,
            activeChatId,
            backgroundMode,
            showImageInfo,
        }),
        [activeChatId, backgroundMode, chatSessions, showImageInfo],
    );

    const cleanupCanvasFiles = useCallback(
        (extra?: unknown) => {
            cleanupAssetImages({ extra, history: historyRef.current, lastHistory: lastHistoryRef.current });
        },
        [cleanupAssetImages],
    );

    const startGenerationRequest = useCallback((targetNodeId: string, originNodeId: string, runningId = originNodeId, controller = new AbortController()) => {
        const previous = generationRequestsRef.current.get(targetNodeId);
        if (previous?.controller !== controller) previous?.controller.abort();
        generationRequestsRef.current.set(targetNodeId, { targetNodeId, originNodeId, runningNodeId: runningId, controller });
        return controller;
    }, []);

    const finishGenerationRequest = useCallback((targetNodeId: string, controller: AbortController) => {
        const request = generationRequestsRef.current.get(targetNodeId);
        if (request?.controller === controller) generationRequestsRef.current.delete(targetNodeId);
    }, []);

    const notifyGenerationSuccess = useCallback(
        (nodeId: string) => {
            const name = nodesRef.current.find((node) => node.id === nodeId)?.title?.trim() || t("canvas.node.node");
            message.success(t("canvas.generation.succeeded", { name }));
        },
        [message, t],
    );

    const stopGenerationByRunningId = useCallback((runningId: string) => {
        const affectedNodeIds = new Set<string>([runningId]);
        generationRequestsRef.current.forEach((request) => {
            if (request.runningNodeId !== runningId) return;
            request.controller.abort();
            generationRequestsRef.current.delete(request.targetNodeId);
            affectedNodeIds.add(request.targetNodeId);
            affectedNodeIds.add(request.originNodeId);
        });
        setRunningNodeId((current) => (current === runningId ? null : current));
        void markJobsStoppedForNodes(affectedNodeIds);
        setNodes((prev) =>
            prev.map((node) =>
                affectedNodeIds.has(node.id) && node.metadata?.status === NODE_STATUS_LOADING
                    ? {
                          ...node,
                          metadata: {
                              ...node.metadata,
                              status: NODE_STATUS_IDLE,
                              errorDetails: undefined,
                              generationJobId: undefined,
                              generationPhase: undefined,
                              generationProgress: undefined,
                              images: node.metadata.images?.map((image) => (image.status === NODE_STATUS_LOADING ? { ...image, status: NODE_STATUS_ERROR, errorDetails: t("common.requestCanceled") } : image)),
                          },
                      }
                    : node,
            ),
        );
    }, [t]);

    const confirmStopGeneration = useCallback(
        (nodeId: string) => {
            modal.confirm({
                title: t("canvas.projectPage.stopTitle"),
                content: (
                    <div className="space-y-2 text-sm">
                        <p>{t("canvas.projectPage.stopDescription")}</p>
                        <p>{t("canvas.projectPage.stopCreditWarning")}</p>
                        <p>{t("canvas.projectPage.stopResultWarning")}</p>
                    </div>
                ),
                okText: t("canvas.projectPage.stop"),
                cancelText: t("canvas.projectPage.continue"),
                okButtonProps: { danger: true },
                onOk: () => stopGenerationByRunningId(nodeId),
            });
        },
        [modal, stopGenerationByRunningId, t],
    );

    useEffect(() => {
        if (!hydrated) return;
        const startedAt = performance.now();
        let previousStageAt = startedAt;
        const timings: Record<string, number> = {};
        const markRestore = (stage: string) => { const now = performance.now(); timings[stage] = Math.round(now - previousStageAt); previousStageAt = now; };
        setProjectLoaded(false);
        setReferenceReturn(null);
        const storedProject = openProject(projectId);
        if (!storedProject) {
            navigate("/", { replace: true });
            return;
        }
        const [project] = repairCinePackVideoPrompts([storedProject]);
        markRestore("structureMs");

        const activateProject = (restoredNodes: CanvasNodeData[], restoredSessions: CanvasAssistantSession[]) => {
            setNodes(restoredNodes);
            setConnections(project.connections);
            setChatSessions(restoredSessions);
            setActiveChatId(project.activeChatId || null);
            setBackgroundMode(project.backgroundMode);
            setShowImageInfo(project.showImageInfo || false);
            setViewport(project.viewport);
            historyRef.current = { past: [], future: [] };
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
            lastHistoryRef.current = {
                nodes: restoredNodes, connections: project.connections, chatSessions: restoredSessions,
                activeChatId: project.activeChatId || null, backgroundMode: project.backgroundMode,
                showImageInfo: project.showImageInfo || false,
            };
            setHistoryState({ canUndo: false, canRedo: false });
            timings.readyMs = Math.round(performance.now() - startedAt);
            setRestoreMetrics({ ...timings });
            setProjectLoaded(true);
        };

        // An empty project has no media or node jobs to restore. Its original
        // create/save operation remains owned by the store; do not scan every
        // historical order or trigger another whole-library save before opening.
        if (!project.nodes.length && !project.connections.length && !project.chatSessions?.length) {
            activateProject([], []);
            return;
        }

        resumeAbortRef.current?.abort();
        const resumeController = new AbortController();
        resumeAbortRef.current = resumeController;
        const restore = async () => {
            await waitForConfigHydration();
            markRestore("configMs");
            if (resumeController.signal.aborted) return;
            const config = useConfigStore.getState().config;
            const resumable = await listResumableJobs(projectId);
            markRestore("ordersMs");
            if (resumeController.signal.aborted) return;
            const resumableIds = new Set(resumable.map((job) => job.id));
            const resumableJobByNodeId = new Map(resumable.map((job) => [job.nodeId, job.id]));
            const ratioAdjustedNodes = project.nodes.map((node) => {
                if (node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video) return node;
                // 已有媒体：按真实像素比例归一到统一长边，同宽高比在画布上一样大
                if (node.metadata?.content && !node.metadata?.freeResize) {
                    const naturalW = node.metadata.naturalWidth || 0;
                    const naturalH = node.metadata.naturalHeight || 0;
                    if (naturalW > 0 && naturalH > 0) {
                        const size = fitNodeSize(naturalW, naturalH, MEDIA_NODE_LONG_EDGE, MEDIA_NODE_LONG_EDGE);
                        if (Math.abs(size.width - node.width) < 1 && Math.abs(size.height - node.height) < 1) return node;
                        return {
                            ...node,
                            position: {
                                x: node.position.x + node.width / 2 - size.width / 2,
                                y: node.position.y + node.height / 2 - size.height / 2,
                            },
                            ...size,
                        };
                    }
                }
                if (node.metadata?.content) return node;
                const spec = getNodeSpec(node.type);
                const ratio = node.metadata?.size || (node.type === CanvasNodeType.Image ? config.imageSize : config.videoSize);
                const size = nodeSizeFromRatio(ratio, spec.width, spec.height);
                if (!size) return node;
                return {
                    ...node,
                    position: {
                        x: node.position.x + node.width / 2 - size.width / 2,
                        y: node.position.y + node.height / 2 - size.height / 2,
                    },
                    ...size,
                    metadata: { ...node.metadata, size: ratio },
                };
            });
            const restoredNodes = await hydrateCanvasImages(resetInterruptedGeneration(ratioAdjustedNodes, resumableIds, resumableJobByNodeId));
            markRestore("mediaMs");
            void backupGeneratedCanvasMedia(projectId, restoredNodes).catch(() => 0);
            const restoredSessions = await hydrateAssistantImages(project.chatSessions || []);
            markRestore("assistantMs");
            if (resumeController.signal.aborted) return;
            updateProject(projectId, { nodes: restoredNodes, connections: project.connections, chatSessions: restoredSessions });
            // Media and structure are usable now. A slow whole-library disk
            // acknowledgement must not hide the restored canvas. Keep the
            // persistence barrier only for task recovery below, never repaint
            // this initial snapshot after the user has started editing it.
            activateProject(restoredNodes, restoredSessions);
            await useCanvasStore.getState().flushPersist();
            markRestore("persistMs");
            if (resumeController.signal.aborted) return;
            setRestoreMetrics({ ...timings });
            if (resumableIds.size) {
                void resumeCanvasGenerationJobs({
                    projectId,
                    config,
                    nodes: restoredNodes,
                    setNodes,
                    commitNodes: commitCanvasNodes,
                    signal: resumeController.signal,
                    activeJobIds: resumeJobIdsRef.current,
                    onGenerationSuccess: ({ nodeId }) => {
                        const node = nodesRef.current.find((item) => item.id === nodeId);
                        if (!node || !isStoryboardNode(node)) notifyGenerationSuccess(nodeId);
                    },
                    onGenerationFailure: ({ nodeId, error }) => {
                        const node = nodesRef.current.find((item) => item.id === nodeId);
                        if (node && isStoryboardNode(node)) message.error(summarizeApiError(error, "故事板生成失败"));
                    },
                });
            }
        };
        void restore().catch(error => {
            if (!resumeController.signal.aborted) message.error(summarizeApiError(error, "画布恢复未完成，请保留当前页面"));
        });
        return () => resumeController.abort();
    }, [commitCanvasNodes, hydrated, message, navigate, notifyGenerationSuccess, openProject, projectId, updateProject]);

    useEffect(() => {
        if (!projectLoaded || searchParams.get("setupFolders") !== "1") return;
        setLocalFoldersOpen(true);
        const next = new URLSearchParams(searchParams);
        next.delete("setupFolders");
        navigate({ search: next.toString() ? `?${next}` : "" }, { replace: true });
    }, [navigate, projectLoaded, searchParams]);

    useEffect(() => {
        if (projectId && projectLoaded) return watchProjectDiskMedia(projectId);
    }, [projectId, projectLoaded]);

    useEffect(() => {
        if (!projectLoaded || applyingHistoryRef.current || historyPausedRef.current || isNodeDragging || isNodeResizing) return;
        const next = createHistoryEntry();
        const previous = lastHistoryRef.current;
        if (
            previous && sameVisibleNodeReferences(previous.nodes, next.nodes) &&
            previous.connections === next.connections &&
            previous.chatSessions === next.chatSessions &&
            previous.activeChatId === next.activeChatId &&
            previous.backgroundMode === next.backgroundMode &&
            previous.showImageInfo === next.showImageInfo
        )
            return;

        if (historyCommitTimerRef.current) clearTimeout(historyCommitTimerRef.current);
        historyCommitTimerRef.current = setTimeout(() => {
            const current = createHistoryEntry();
            const last = lastHistoryRef.current;
            if (!last) return;
            historyRef.current.past = [...historyRef.current.past.slice(-49), last];
            historyRef.current.future = [];
            setHistoryState({ canUndo: true, canRedo: false });
            lastHistoryRef.current = current;
            historyCommitTimerRef.current = null;
        }, 180);

        return () => {
            if (historyCommitTimerRef.current) {
                clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
            }
        };
    }, [activeChatId, backgroundMode, chatSessions, connections, createHistoryEntry, isNodeDragging, isNodeResizing, nodes, projectLoaded, showImageInfo]);

    useEffect(() => {
        if (!projectLoaded || historyPausedRef.current || isNodeDragging || isNodeResizing) return;
        updateProject(projectId, { nodes, connections, chatSessions, activeChatId, backgroundMode, showImageInfo });
    }, [activeChatId, backgroundMode, chatSessions, connections, isNodeDragging, isNodeResizing, nodes, projectId, projectLoaded, showImageInfo, updateProject]);

    useEffect(() => {
        return () => {
            void useCanvasStore.getState().flushPersist();
        };
    }, []);

    useEffect(() => {
        if (!projectLoaded) return;
        const saveOnHide = () => {
            if (canvasInteractionActive() || viewportSaveTimerRef.current || nodeDraggingRef.current) {
                updateProject(projectId, { nodes: nodesRef.current, connections: connectionsRef.current, viewport: viewportRef.current });
            }
            void useCanvasStore.getState().flushPersist();
        };
        window.addEventListener("pagehide", saveOnHide);
        window.addEventListener("beforeunload", saveOnHide);
        return () => {
            window.removeEventListener("pagehide", saveOnHide);
            window.removeEventListener("beforeunload", saveOnHide);
        };
    }, [projectId, projectLoaded, updateProject]);

    useEffect(() => {
        if (!dialogNodeId) setNodeImageSettingsOpen(false);
    }, [dialogNodeId]);

    useEffect(() => {
        if (!projectLoaded) return;
        if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        const saveViewport = () => {
            if (canvasInteractionActive()) {
                viewportSaveTimerRef.current = setTimeout(saveViewport, 500);
                return;
            }
            updateProject(projectId, { viewport: viewportRef.current });
            viewportSaveTimerRef.current = null;
        };
        viewportSaveTimerRef.current = setTimeout(saveViewport, 500);
        return () => {
            if (viewportSaveTimerRef.current) clearTimeout(viewportSaveTimerRef.current);
        };
    }, [projectId, projectLoaded, updateProject, viewport]);

    useLayoutEffect(() => {
        nodesRef.current = nodes;
        connectionsRef.current = connections;
        selectedNodeIdsRef.current = selectedNodeIds;
        viewportRef.current = viewport;
        connectingParamsRef.current = connectingParams;
        connectionTargetNodeIdRef.current = connectionTargetNodeId;
        pendingConnectionCreateRef.current = pendingConnectionCreate;
    }, [nodes, connections, selectedNodeIds, viewport, connectingParams, connectionTargetNodeId, pendingConnectionCreate]);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;

        const updateSize = () => {
            const rect = el.getBoundingClientRect();
            setSize({ width: rect.width, height: rect.height });
            if (!didInitialCenterRef.current) {
                didInitialCenterRef.current = true;
                setViewport({ x: rect.width / 2, y: rect.height / 2, k: 1 });
            }
        };

        updateSize();
        const resizeObserver = new ResizeObserver(updateSize);
        resizeObserver.observe(el);
        return () => resizeObserver.disconnect();
    }, []);

    const screenToCanvas = useCallback((clientX: number, clientY: number) => {
        const rect = containerRef.current?.getBoundingClientRect();
        const currentViewport = viewportRef.current;
        const localX = clientX - (rect?.left || 0);
        const localY = clientY - (rect?.top || 0);

        return {
            x: (localX - currentViewport.x) / currentViewport.k,
            y: (localY - currentViewport.y) / currentViewport.k,
        };
    }, []);

    const getCanvasCenter = useCallback(() => {
        const rect = containerRef.current?.getBoundingClientRect();
        return screenToCanvas((rect?.left || 0) + (rect?.width || size.width) / 2, (rect?.top || 0) + (rect?.height || size.height) / 2);
    }, [screenToCanvas, size.height, size.width]);

    const setConnecting = useCallback((next: ConnectionHandle | null) => {
        connectingParamsRef.current = next;
        setConnectingParams(next);
        if (!next) {
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
        }
    }, []);

    const keepNodeToolbar = useCallback(
        (nodeId: string) => {
            if (nodeDraggingRef.current || nodeImageSettingsOpen || !selectedNodeIdsRef.current.has(nodeId)) return;
            setToolbarNodeId(nodeId);
        },
        [nodeImageSettingsOpen],
    );

    const hideNodeToolbar = useCallback(() => {}, []);

    const connectNodes = useCallback(
        (current: ConnectionHandle, targetNodeId: string) => {
            if (current.nodeId === targetNodeId) return;

            const connection = normalizeConnection(current.nodeId, targetNodeId, nodesRef.current, current.handleType);
            if (!connection) {
                message.warning(t("canvas.projectPage.configConnection"));
                return;
            }
            const { fromNodeId, toNodeId } = connection;
            const exists = connectionsRef.current.some((conn) => conn.fromNodeId === fromNodeId && conn.toNodeId === toNodeId);
            if (!exists) {
                setConnections((prev) => [...prev, { id: `conn-${Date.now()}`, fromNodeId, toNodeId }]);
            }
            setContextMenu(null);
        },
        [message, t],
    );

    const createConnectedNode = useCallback(
        (type: CanvasNodeType.Image | CanvasNodeType.Text | CanvasNodeType.Config | CanvasNodeType.Video | CanvasNodeType.Audio, pending: PendingConnectionCreate) => {
            const metadata =
                type === CanvasNodeType.Config
                    ? { model: effectiveConfig.imageModel || effectiveConfig.model, size: effectiveConfig.imageSize, count: 1 }
                    : type === CanvasNodeType.Image
                      ? { size: effectiveConfig.imageSize }
                      : type === CanvasNodeType.Video
                        ? defaultVideoNodeMetadata(effectiveConfig)
                        : undefined;
            const newNode = createCanvasNode(type, pending.position, metadata);
            const connection = normalizeConnection(pending.connection.nodeId, newNode.id, [...nodesRef.current, newNode], pending.connection.handleType);
            if (!connection) {
                message.warning(t("canvas.projectPage.configConnection"));
                return;
            }
            setNodes((prev) => [...prev, newNode]);
            setConnections((prev) => [...prev, { id: nanoid(), ...connection }]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            if (type !== CanvasNodeType.Text && type !== CanvasNodeType.Audio) setDialogNodeId(newNode.id);
            setPendingConnectionCreate(null);
            setConnecting(null);
        },
        [effectiveConfig.imageModel, effectiveConfig.imageSize, effectiveConfig.model, effectiveConfig.videoSize, message, setConnecting, t],
    );

    const cancelPendingConnectionCreate = useCallback(() => {
        setPendingConnectionCreate(null);
        setConnecting(null);
    }, [setConnecting]);

    const getConnectionDropTarget = useCallback(
        (clientX: number, clientY: number, current: ConnectionHandle): ConnectionDropTarget => {
            const world = screenToCanvas(clientX, clientY);
            const scale = Math.max(viewportRef.current.k, 0.05);
            const padding = CONNECTION_NODE_HIT_PADDING / scale;
            const handleRadius = CONNECTION_HANDLE_HIT_RADIUS / scale;
            let isNearNode = false;
            let bestNodeId: string | null = null;
            let bestPriority = Number.POSITIVE_INFINITY;

            [...nodesRef.current]
                .reverse()
                .forEach((node) => {
                    if (node.type === CanvasNodeType.Group || isStoryboardNode(node)) return;
                    const anchor = getConnectionTargetAnchor(node, current);
                    const dx = world.x - anchor.x;
                    const dy = world.y - anchor.y;
                    const hitsHandle = dx * dx + dy * dy <= handleRadius * handleRadius;
                    const hitsInside = world.x >= node.position.x && world.x <= node.position.x + node.width && world.y >= node.position.y && world.y <= node.position.y + node.height;
                    const hitsExpanded = world.x >= node.position.x - padding && world.x <= node.position.x + node.width + padding && world.y >= node.position.y - padding && world.y <= node.position.y + node.height + padding;

                    if (!hitsHandle && !hitsInside && !hitsExpanded) return;
                    isNearNode = true;
                    if (node.id === current.nodeId || !normalizeConnection(current.nodeId, node.id, nodesRef.current, current.handleType)) return;

                    const priority = hitsInside ? 0 : hitsHandle ? 1 : 2;
                    if (priority < bestPriority) {
                        bestNodeId = node.id;
                        bestPriority = priority;
                    }
                });

            return { nodeId: bestNodeId, isNearNode };
        },
        [screenToCanvas],
    );

    const visibleNodes = useMemo(() => {
        const padding = 280;
        const rect = containerRef.current?.getBoundingClientRect();
        const width = rect?.width || size.width;
        const height = rect?.height || size.height;
        const viewLeft = -viewport.x / viewport.k - padding;
        const viewTop = -viewport.y / viewport.k - padding;
        const viewRight = viewLeft + width / viewport.k + padding * 2;
        const viewBottom = viewTop + height / viewport.k + padding * 2;

        return nodes.filter((node) => !isStoryboardNode(node) && node.position.x + node.width > viewLeft && node.position.x < viewRight && node.position.y + node.height > viewTop && node.position.y < viewBottom);
    }, [nodes, size.height, size.width, viewport.k, viewport.x, viewport.y]);
    const canvasNodes = useMemo(() => nodes.filter((node) => !isStoryboardNode(node)), [nodes]);
    const runningStoryboardSourceIds = useMemo(
        () => new Set(nodes.filter((node) => isStoryboardNode(node) && node.metadata?.status === NODE_STATUS_LOADING).map((node) => node.metadata!.storyboardSourceNodeId!)),
        [nodes],
    );

    const nodeById = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
    // Include the Bezier control points: a curve can cross the viewport even
    // when both endpoint nodes are off screen.
    const visibleConnections = useMemo(() => {
        const padding = 280;
        const left = -viewport.x / viewport.k - padding;
        const top = -viewport.y / viewport.k - padding;
        const right = left + size.width / viewport.k + padding * 2;
        const bottom = top + size.height / viewport.k + padding * 2;
        return connections.filter((connection) => {
            const from = nodeById.get(connection.fromNodeId);
            const to = nodeById.get(connection.toNodeId);
            if (!from || !to) return false;
            const x1 = from.position.x + from.width;
            const y1 = from.position.y + from.height / 2;
            const x2 = to.position.x;
            const y2 = to.position.y + to.height / 2;
            const curve = Math.max(Math.abs(x2 - x1) * 0.5, 50);
            return Math.max(x1, x1 + curve, x2 - curve, x2) >= left
                && Math.min(x1, x1 + curve, x2 - curve, x2) <= right
                && Math.max(y1, y2) >= top && Math.min(y1, y2) <= bottom;
        });
    }, [connections, nodeById, viewport.x, viewport.y, viewport.k, size.width, size.height]);
    // The toolbar follows a single selected node selected by click, creation, marquee, or keyboard.
    // It stays hidden for multi-selection and while isNodeDragging is true.
    const singleSelectedNodeId = selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null;
    const activeCinePackShot = useMemo(() => {
        const dialogNode = dialogNodeId ? nodeById.get(dialogNodeId) : undefined;
        if (dialogNode && isCinePackVideoShotNode(dialogNode)) return dialogNode;
        const selectedNode = singleSelectedNodeId ? nodeById.get(singleSelectedNodeId) : undefined;
        return selectedNode && isCinePackVideoShotNode(selectedNode) ? selectedNode : undefined;
    }, [dialogNodeId, nodeById, singleSelectedNodeId]);
    const toolbarNode = (toolbarNodeId ? nodeById.get(toolbarNodeId) || null : null) || (singleSelectedNodeId ? nodeById.get(singleSelectedNodeId) || null : null);
    const infoNode = infoNodeId ? nodeById.get(infoNodeId) || null : null;
    const cropNode = cropNodeId ? nodeById.get(cropNodeId) || null : null;
    const maskEditNode = maskEditNodeId ? nodeById.get(maskEditNodeId) || null : null;
    const splitNode = splitNodeId ? nodeById.get(splitNodeId) || null : null;
    const trimNode = trimNodeId ? nodeById.get(trimNodeId) || null : null;
    const upscaleNode = upscaleNodeId ? nodeById.get(upscaleNodeId) || null : null;
    const superResolveNode = superResolveNodeId ? nodeById.get(superResolveNodeId) || null : null;
    const angleNode = angleNodeId ? nodeById.get(angleNodeId) || null : null;
    const previewNode = previewNodeId ? nodeById.get(previewNodeId) || null : null;
    const previewPrimaryImage = previewNode?.metadata?.images?.find((image) => image.id === previewNode.metadata?.primaryImageId) || previewNode?.metadata?.images?.find((image) => Boolean(image.content));
    const previewImage = previewNode?.metadata?.images?.find((image) => image.id === previewImageId) || previewPrimaryImage;
    const previewContent = previewImage?.content || previewNode?.metadata?.content;
    const previewBatchImages = previewNode?.metadata?.images?.filter((image) => Boolean(image.content)) || [];
    const previewIndex = previewBatchImages.findIndex((image) => image.id === previewImage?.id);
    const previewNaturalWidth = previewImage?.naturalWidth || previewNode?.metadata?.naturalWidth;
    const previewNaturalHeight = previewImage?.naturalHeight || previewNode?.metadata?.naturalHeight;
    const previewPixelSize = previewNaturalWidth && previewNaturalHeight ? `${Math.round(previewNaturalWidth)} × ${Math.round(previewNaturalHeight)}` : "";
    const showAdjacentPreview = useCallback(
        (direction: -1 | 1) => {
            if (previewBatchImages.length <= 1) return;
            const currentIndex = previewIndex >= 0 ? previewIndex : 0;
            const nextIndex = (currentIndex + direction + previewBatchImages.length) % previewBatchImages.length;
            setPreviewImageId(previewBatchImages[nextIndex].id);
        },
        [previewBatchImages, previewIndex],
    );
    useEffect(() => {
        if (!previewContent || previewBatchImages.length <= 1) return;
        const handleKeyDown = (event: KeyboardEvent) => {
            if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
            event.preventDefault();
            showAdjacentPreview(event.key === "ArrowLeft" ? -1 : 1);
        };
        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [previewBatchImages.length, previewContent, showAdjacentPreview]);
    const hasMultipleSelectedNodes = selectedNodeIds.size > 1;
    const selectedImagesForGeneration = useMemo(() => selectedReferenceImages(nodes, selectedNodeIds), [nodes, selectedNodeIds]);
    const selectedResourcesForGeneration = useMemo(() => selectedReferenceResources(nodes, selectedNodeIds), [nodes, selectedNodeIds]);
    const showBatchReferenceToolbar = selectedImagesForGeneration.length > 0 && (hasMultipleSelectedNodes || selectedImagesForGeneration.length > 1);
    const alignmentSelection = useMemo(() => canvasAlignmentSelection(nodes, selectedNodeIds), [nodes, selectedNodeIds]);
    const activeNodeId = hasMultipleSelectedNodes ? null : hoveredNodeId || (selectedNodeIds.size === 1 ? Array.from(selectedNodeIds)[0] : null);
    const groupChildCountById = useMemo(() => {
        const map = new Map<string, number>();
        canvasNodes.forEach((node) => {
            const groupId = node.metadata?.groupId;
            if (groupId) map.set(groupId, (map.get(groupId) || 0) + 1);
        });
        return map;
    }, [canvasNodes]);
    const relatedHighlight = useMemo(() => {
        const nodeIds = new Set<string>();
        const connectionIds = new Set<string>();

        if (!activeNodeId) return { nodeIds, connectionIds };

        nodeIds.add(activeNodeId);
        connections.forEach((connection) => {
            if (connection.fromNodeId !== activeNodeId && connection.toNodeId !== activeNodeId) return;
            connectionIds.add(connection.id);
            nodeIds.add(connection.fromNodeId);
            nodeIds.add(connection.toNodeId);
        });

        return { nodeIds, connectionIds };
    }, [activeNodeId, connections]);

    const configInputsById = useMemo(() => {
        const map = new Map<string, NodeGenerationInput[]>();
        nodes.forEach((node) => {
            if (node.type !== CanvasNodeType.Config) return;
            map.set(node.id, buildNodeGenerationInputs(node.id, nodes, connections));
        });
        return map;
    }, [connections, nodes]);
    const mentionResourceNodesRef = useRef<CanvasNodeData[]>([]);
    const mentionResourceNodes = useMemo(() => {
        const next = reuseMentionResourceNodes(mentionResourceNodesRef.current, nodes);
        mentionResourceNodesRef.current = next;
        return next;
    }, [nodes]);
    const mentionReferencesByNodeId = useMemo(() => {
        const map = new Map<string, ReturnType<typeof buildNodeMentionReferences>>();
        mentionResourceNodes.forEach((node) => map.set(node.id, buildNodeMentionReferences(node, mentionResourceNodes, connections)));
        return map;
    }, [connections, mentionResourceNodes, nodeRegistryVersion]);
    const { applyAgentOps } = useAgentBridge({
        publishAgentContext: projectLoaded,
        projectId,
        title: currentProject?.title,
        nodes,
        connections,
        selectedNodeIds,
        viewport,
        nodesRef,
        connectionsRef,
        selectedNodeIdsRef,
        viewportRef,
        generateNodeRef,
        setNodes,
        setConnections,
        setSelectedNodeIds,
        setSelectedConnectionId,
        setViewport,
        setContextMenu,
    });

    const { pluginHost, renderPluginPanel, buildNodeToolbarItems } = usePluginHost({
        effectiveConfig,
        isAiConfigReady,
        openConfigDialog,
        theme,
        nodesRef,
        connectionsRef,
        viewportRef,
        setNodes,
        setDialogNodeId,
        applyAgentOps,
    });
    const createNode = useCallback(
        (type: CanvasNodeTypeId, position?: Position) => {
            const targetPosition = position || getCanvasCenter();
            const configMetadata =
                type === CanvasNodeType.Config
                    ? {
                          model: effectiveConfig.imageModel || effectiveConfig.model,
                          size: effectiveConfig.imageSize,
                          count: 1,
                      }
                    : type === CanvasNodeType.Image
                      ? { size: effectiveConfig.imageSize }
                      : type === CanvasNodeType.Video
                        ? defaultVideoNodeMetadata(effectiveConfig)
                        : undefined;
            const newNode = createCanvasNode(type, targetPosition, configMetadata);

            setNodes((prev) => [...prev, newNode]);
            setSelectedNodeIds(new Set([newNode.id]));
            setSelectedConnectionId(null);
            const definition = getNodeDefinition(type);
            // Display-only plugin nodes with hidePanel do not open a panel; custom Panels require autoOpenPanel on creation.
            // Plugin nodes declaring useBuiltinPanel open the built-in generation panel on creation, like image nodes.
            // Built-in image, video, and config nodes retain their existing open-on-create behavior.
            const wantsPanel = definition?.hidePanel
                ? false
                : definition?.Panel
                  ? Boolean(definition.autoOpenPanel)
                  : definition?.useBuiltinPanel
                    ? true
                    : isBuiltinType(type) && type !== CanvasNodeType.Text && type !== CanvasNodeType.Audio && type !== CanvasNodeType.Group;
            if (wantsPanel) setDialogNodeId(newNode.id);
        },
        [effectiveConfig.imageModel, effectiveConfig.imageSize, effectiveConfig.model, effectiveConfig.videoSize, getCanvasCenter],
    );

    const deleteNodes = useCallback(
        (ids: Set<string>) => {
            if (!ids.size) return;
            const allIds = new Set(ids);
            nodesRef.current.forEach((node) => {
                if (node.metadata?.storyboardSourceNodeId && ids.has(node.metadata.storyboardSourceNodeId)) allIds.add(node.id);
            });
            generationRequestsRef.current.forEach((request, targetNodeId) => {
                if (!allIds.has(targetNodeId) && !allIds.has(request.originNodeId)) return;
                request.controller.abort();
                generationRequestsRef.current.delete(targetNodeId);
            });
            void markJobsStoppedForNodes(allIds);
            setNodes((prev) => {
                const next = prev.filter((node) => !allIds.has(node.id));
                return next.map((node) => {
                    const groupId = node.metadata?.groupId;
                    if (groupId && allIds.has(groupId)) return { ...node, metadata: { ...node.metadata, groupId: undefined } };
                    return node;
                });
            });
            setConnections((prev) => prev.filter((conn) => !allIds.has(conn.fromNodeId) && !allIds.has(conn.toNodeId)));
            setSelectedNodeIds(new Set());
            setSelectedConnectionId(null);
            setHoveredNodeId((current) => (current && allIds.has(current) ? null : current));
            setToolbarNodeId((current) => (current && allIds.has(current) ? null : current));
            setDialogNodeId((current) => (current && allIds.has(current) ? null : current));
            setEditingNodeId((current) => (current && allIds.has(current) ? null : current));
            setInfoNodeId((current) => (current && allIds.has(current) ? null : current));
            setCropNodeId((current) => (current && allIds.has(current) ? null : current));
            setMaskEditNodeId((current) => (current && allIds.has(current) ? null : current));
            setAngleNodeId((current) => (current && allIds.has(current) ? null : current));
            setPreviewNodeId((current) => (current && allIds.has(current) ? null : current));
            setRunningNodeId((current) => (current && allIds.has(current) ? null : current));
            setContextMenu((current) => (current?.type === "node" && allIds.has(current.nodeId) ? null : current));
            cleanupCanvasFiles({ projectId, nodes: nodesRef.current.filter((node) => !allIds.has(node.id)), chatSessions });
        },
        [chatSessions, cleanupCanvasFiles, projectId],
    );

    const deleteConnection = useCallback((connectionId: string) => {
        setConnections((prev) => prev.filter((conn) => conn.id !== connectionId));
        setSelectedConnectionId((current) => (current === connectionId ? null : current));
        setContextMenu((current) => (current?.type === "connection" && current.connectionId === connectionId ? null : current));
    }, []);

    const disconnectPromptReference = useCallback(
        (reference: CanvasResourceReference) => {
            if (!reference.connectionId) return;
            deleteConnection(reference.connectionId);
        },
        [deleteConnection],
    );

    const generateStoryboard = useCallback(
        async (sourceNodeId: string, sourcePrompt: string) => {
            const prompt = sourcePrompt;
            if (!prompt.trim()) {
                message.warning("还未书写任何提示词");
                return;
            }
            const sourceNode = nodesRef.current.find((node) => node.id === sourceNodeId && node.type === CanvasNodeType.Video);
            if (!sourceNode) return;
            const storyboardImageModel = resolveModelForCapability(effectiveConfig, effectiveConfig.storyboardImageModel || effectiveConfig.imageModel, "image");
            const storyboardImageLabel = modelOptionLabel(effectiveConfig, storyboardImageModel);
            const imageConfig = {
                ...buildGenerationConfig(effectiveConfig, undefined, "image"),
                model: storyboardImageModel,
                count: "1",
                quality: "1k",
                size: normalizeImageAspect(
                    sourceNode.metadata?.size ||
                        (sourceNode.metadata?.naturalWidth && sourceNode.metadata.naturalHeight ? `${sourceNode.metadata.naturalWidth}x${sourceNode.metadata.naturalHeight}` : effectiveConfig.videoSize || "16:9"),
                ),
            };
            if (!isAiConfigReady(imageConfig, imageConfig.model)) {
                openConfigDialog(true);
                message.warning("请先完成故事板生图模型配置");
                return;
            }

            const storyboardId = `storyboard-${nanoid()}`;
            const storyboardIndex = Math.max(0, ...storyboardNodesFor(sourceNodeId, nodesRef.current).map((node) => node.metadata?.storyboardIndex || 0)) + 1;
            const spec = nodeSizeFromRatio(imageConfig.size, NODE_DEFAULT_SIZE[CanvasNodeType.Image].width, NODE_DEFAULT_SIZE[CanvasNodeType.Image].height) || NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const hiddenNode: CanvasNodeData = {
                id: storyboardId,
                type: CanvasNodeType.Image,
                title: `故事板${storyboardIndex}`,
                position: { ...sourceNode.position },
                width: spec.width,
                height: spec.height,
                metadata: {
                    hidden: true,
                    storyboardSourceNodeId: sourceNodeId,
                    storyboardIndex,
                    prompt,
                    status: NODE_STATUS_LOADING,
                    generationPhase: "resolving",
                    generationDetail: "正在读取提示词引用的资产",
                    generationPhaseStartedAt: Date.now(),
                    model: imageConfig.model,
                    size: imageConfig.size,
                    quality: "1k",
                },
            };
            await commitCanvasNodes((prev) => [...prev, hiddenNode]);

            let jobId = "";
            let currentPhase: CanvasGenerationPhase = "resolving";
            let remoteTaskId = "";
            const updateStoryboardPhase = (phase: CanvasGenerationPhase, detail: string, progress?: number) => {
                currentPhase = phase;
                setNodes((prev) => patchNodeGenerationUi(prev, storyboardId, { phase, detail, progress, clearProgress: typeof progress !== "number" }));
            };
            const controller = startGenerationRequest(storyboardId, sourceNodeId, storyboardId);
            try {
                const job = await beginCanvasGenerationJob({ projectId, nodeId: storyboardId, kind: "image", prompt, model: imageConfig.model });
                jobId = job.id;
                await commitCanvasNodes((prev) => prev.map((node) => (node.id === storyboardId ? { ...node, metadata: { ...node.metadata, generationJobId: job.id } } : node)));

                const mentionReferences = buildNodeMentionReferences(sourceNode, nodesRef.current, connectionsRef.current);
                const referencedAssets = mentionedStoryboardReferences(prompt, mentionReferences);
                updateStoryboardPhase("resolving", `正在读取 ${referencedAssets.length} 张实际引用资产`);
                const resolvedAssets = await resolveCanvasReferenceImages(referencedAssets, nodesRef.current);
                const plan = await compileKinStoryboardPlan(
                    effectiveConfig,
                    prompt,
                    (resolvedAssets as ReferenceImage[]).map((reference, index) => ({ canvasLabel: referencedAssets[index]?.label || `图片${index + 1}`, reference })),
                    imageConfig.size,
                    {
                        signal: controller.signal,
                        onStage: (phase, detail) => updateStoryboardPhase(phase, detail),
                    },
                );
                const storyboardRequestConfig = resolveModelRequestConfig(effectiveConfig, storyboardImageModel);
                let storyboardReferences = plan.references;
                if (storyboardRequestConfig.apiFormat === "comfyui") {
                    if (isZealmanWorkflowModel(storyboardRequestConfig.model, storyboardRequestConfig)) {
                        const usage = await getZealmanWorkflowUsage(storyboardRequestConfig, storyboardRequestConfig.model, controller.signal);
                        const imageSlotCount = usage.referenceSlots.filter((slot) => slot.kind === "image").length;
                        storyboardReferences = imageSlotCount ? plan.references.slice(0, imageSlotCount) : [];
                    } else {
                        storyboardReferences = [];
                    }
                }
                updateStoryboardPhase("submitting", storyboardReferences.length ? `正在向 ${storyboardImageLabel} 上传并提交 ${storyboardReferences.length} 张参考图` : `正在向 ${storyboardImageLabel} 提交已编译 Prompt`);
                const onRemoteTask = async (task: ImageGenerationTask) => {
                    remoteTaskId = task.id;
                    updateStoryboardPhase("queued", `${storyboardImageLabel} 已接单 · ${task.id.slice(-8)}`);
                    await attachRemoteTaskToJob(job.id, task);
                    await commitCanvasNodes((prev) => patchNodeGenerationUi(prev, storyboardId, { phase: "queued", detail: `${storyboardImageLabel} 已接单 · ${task.id.slice(-8)}`, clearProgress: true }));
                };
                const storyboardRequestOptions: ImageRequestOptions = {
                    signal: controller.signal,
                    onRemoteTask,
                    onTaskState: ({ stage, progress, attempt }) => {
                        if (stage === "downloading") {
                            updateStoryboardPhase("downloading", "故事板已生成，正在下载结果", 100);
                            return;
                        }
                        const taskHint = remoteTaskId ? ` · ${remoteTaskId.slice(-8)}` : "";
                        const pollHint = attempt ? ` · 第 ${attempt} 次查询` : "";
                        updateStoryboardPhase(stage, `${storyboardImageLabel}${stage === "queued" ? " 排队中" : " 正在生成"}${taskHint}${pollHint}`, progress);
                    },
                };
                const image = await (storyboardReferences.length ? requestEdit(imageConfig, plan.prompt, storyboardReferences, undefined, storyboardRequestOptions) : requestGeneration(imageConfig, plan.prompt, storyboardRequestOptions)).then((items) => items[0]);
                updateStoryboardPhase("saving", "正在保存到画布与本地目录", 100);
                const uploaded = await uploadImage(image.dataUrl);
                const blob = uploaded.storageKey ? await getImageBlob(uploaded.storageKey).catch(() => null) : null;
                if (blob) await writeGeneratedBlob(projectId, "image", blob, "png", uploaded.storageKey).catch(() => false);
                await commitCanvasNodes((prev) =>
                    prev.map((node) =>
                        node.id === storyboardId
                            ? {
                                  ...node,
                                  metadata: {
                                      ...node.metadata,
                                      ...imageMetadata(uploaded),
                                      hidden: true,
                                      storyboardSourceNodeId: sourceNodeId,
                                      storyboardIndex,
                                      prompt,
                                      model: imageConfig.model,
                                      size: imageConfig.size,
                                      quality: "1k",
                                      generationJobId: undefined,
                                      generationPhase: undefined,
                                      generationDetail: undefined,
                                      generationPhaseStartedAt: undefined,
                                      generationFailedPhase: undefined,
                                      generationProgress: undefined,
                                  },
                              }
                            : node,
                    ),
                );
                await patchGenerationJob(job.id, { status: "done" });
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                console.error("[Storyboard Generation Error]", error);
                const errorMessage = error instanceof Error ? error.message : String(error);
                const errorStack = error instanceof Error ? error.stack : "";
                console.error("[Storyboard Error Details]", { errorMessage, errorStack, storyboardId, sourceNodeId });
                const errorDetails = summarizeApiError(errorMessage, "故事板生成失败");
                if (jobId) await patchGenerationJob(jobId, { status: "failed", error: errorDetails });
                await commitCanvasNodes((prev) =>
                    prev.map((node) =>
                        node.id === storyboardId
                            ? {
                                  ...node,
                                  metadata: {
                                      ...node.metadata,
                                      status: NODE_STATUS_ERROR,
                                      errorDetails,
                                      generationJobId: undefined,
                                      generationFailedPhase: currentPhase,
                                      generationPhase: undefined,
                                      generationProgress: undefined,
                                  },
                              }
                            : node,
                    ),
                );
                message.error(errorDetails);
            } finally {
                finishGenerationRequest(storyboardId, controller);
            }
        },
        [commitCanvasNodes, effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, projectId, startGenerationRequest],
    );

    const deleteStoryboard = useCallback(
        (storyboardId: string) => {
            const storyboard = nodesRef.current.find((node) => node.id === storyboardId && isStoryboardNode(node));
            if (!storyboard || storyboard.metadata?.status === NODE_STATUS_LOADING) return;
            modal.confirm({
                title: `删除故事板${storyboard.metadata?.storyboardIndex || ""}？`,
                content: "删除后将从当前视频节点的故事板列表中移除。",
                okText: "删除",
                cancelText: "取消",
                okButtonProps: { danger: true },
                onOk: async () => {
                    const remaining = nodesRef.current.filter((node) => node.id !== storyboardId);
                    await markJobsStoppedForNodes([storyboardId]);
                    await commitCanvasNodes(() => remaining);
                    if (storyboard.metadata?.storageKey) await deleteStoredImages([storyboard.metadata.storageKey]);
                    cleanupCanvasFiles({ projectId, nodes: remaining, chatSessions });
                },
            });
        },
        [chatSessions, cleanupCanvasFiles, commitCanvasNodes, modal, projectId],
    );

    const deselectCanvas = useCallback(() => {
        cancelPendingConnectionCreate();
        setExpandedImageNodeId(null);
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        clearMarquee();
        setHoveredNodeId(null);
        setToolbarNodeId(null);
        setDialogNodeId(null);
        setEditingNodeId(null);
    }, [cancelPendingConnectionCreate, clearMarquee]);

    const clearCanvas = useCallback(() => {
        setNodes([]);
        setConnections([]);
        setInfoNodeId(null);
        setCropNodeId(null);
        setMaskEditNodeId(null);
        setAngleNodeId(null);
        setPreviewNodeId(null);
        setRunningNodeId(null);
        deselectCanvas();
        setClearConfirmOpen(false);
        cleanupCanvasFiles({ projectId, nodes: [], chatSessions: [] });
    }, [cleanupCanvasFiles, deselectCanvas, projectId]);

    const duplicateNode = useCallback((nodeId: string) => {
        const source = nodesRef.current.find((node) => node.id === nodeId);
        if (!source) return;

        const id = `${source.type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        // 复制资产：保留媒体/文本内容，清空提示词、引用、生成相关元数据，类似新导入的资产
        const newMetadata = stripMetadataForAssetCopy(source.metadata);
        const next: CanvasNodeData = {
            ...source,
            id,
            title: source.title,
            position: { x: source.position.x + 36, y: source.position.y + 36 },
            metadata: newMetadata,
        };

        // 复制原节点的连线关系
        const newConnections = connectionsRef.current
            .filter((conn) => conn.fromNodeId === nodeId || conn.toNodeId === nodeId)
            .map((conn) => ({
                ...conn,
                id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                fromNodeId: conn.fromNodeId === nodeId ? id : conn.fromNodeId,
                toNodeId: conn.toNodeId === nodeId ? id : conn.toNodeId,
            }));

        setNodes((prev) => [...prev, next]);
        if (newConnections.length) setConnections((prev) => [...prev, ...newConnections]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        if (next.type !== CanvasNodeType.Group) setDialogNodeId(id);
    }, []);

    const copyNodeWithPrompt = useCallback((nodeId: string) => {
        const source = nodesRef.current.find((node) => node.id === nodeId);
        if (!source) return;

        const id = `${source.type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        // 复制节点：保留提示词和引用，清空已生成的资源/故事板/生成状态，需要重新生成
        const newMetadata = stripMetadataForNodeCopy(source.metadata);
        if (newMetadata && source.type === CanvasNodeType.Video) newMetadata.videoOrganization = inheritVideoOrganization(source, nodesRef.current);
        const next: CanvasNodeData = {
            ...source,
            id,
            title: source.title,
            position: { x: source.position.x + 36, y: source.position.y + 36 },
            metadata: newMetadata,
        };

        // 复制原节点的连线关系
        const newConnections = connectionsRef.current
            .filter((conn) => conn.fromNodeId === nodeId || conn.toNodeId === nodeId)
            .map((conn) => ({
                ...conn,
                id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                fromNodeId: conn.fromNodeId === nodeId ? id : conn.fromNodeId,
                toNodeId: conn.toNodeId === nodeId ? id : conn.toNodeId,
            }));

        setNodes((prev) => [...prev, next]);
        if (newConnections.length) setConnections((prev) => [...prev, ...newConnections]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        if (next.type !== CanvasNodeType.Group) setDialogNodeId(id);
    }, []);

    const copySelectedNodes = useCallback(() => {
        const selectedIds = selectedNodeIdsRef.current;
        if (!selectedIds.size) return;

        // 快捷键 Ctrl+C 复制资产：保留媒体/文本内容，清空提示词与引用
        const copiedNodes = nodesRef.current
            .filter((node) => selectedIds.has(node.id))
            .map((node) => ({
                ...node,
                position: { ...node.position },
                metadata: stripMetadataForAssetCopy(node.metadata),
            }));

        if (!copiedNodes.length) return;

        clipboardRef.current = {
            nodes: copiedNodes,
            connections: connectionsRef.current.filter((connection) => selectedIds.has(connection.fromNodeId) && selectedIds.has(connection.toNodeId)).map((connection) => ({ ...connection })),
        };
    }, []);

    const pasteCopiedNodes = useCallback(() => {
        const clipboard = clipboardRef.current;
        if (!clipboard?.nodes.length) return false;

        const center = getCanvasCenter();
        const bounds = clipboard.nodes.reduce(
            (acc, node) => ({
                left: Math.min(acc.left, node.position.x),
                top: Math.min(acc.top, node.position.y),
                right: Math.max(acc.right, node.position.x + node.width),
                bottom: Math.max(acc.bottom, node.position.y + node.height),
            }),
            { left: Infinity, top: Infinity, right: -Infinity, bottom: -Infinity },
        );
        const dx = center.x - (bounds.left + bounds.right) / 2;
        const dy = center.y - (bounds.top + bounds.bottom) / 2;
        const idMap = new Map<string, string>();
        const nextNodes = clipboard.nodes.map((node, index) => {
            const id = `${node.type}-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
            idMap.set(node.id, id);
            return {
                ...node,
                id,
                title: node.title.endsWith(" Copy") ? node.title : `${node.title} Copy`,
                position: {
                    x: node.position.x + dx,
                    y: node.position.y + dy,
                },
                metadata: node.metadata ? { ...node.metadata } : undefined,
            };
        });

        const pastedNodes = nextNodes.map((node) => {
            const groupId = node.metadata?.groupId;
            if (!groupId) return node;
            return { ...node, metadata: { ...node.metadata, groupId: idMap.get(groupId) } };
        });

        const nextConnections = clipboard.connections.flatMap((connection, index) => {
            const fromNodeId = idMap.get(connection.fromNodeId);
            const toNodeId = idMap.get(connection.toNodeId);
            if (!fromNodeId || !toNodeId) return [];
            return [
                {
                    ...connection,
                    id: `conn-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`,
                    fromNodeId,
                    toNodeId,
                },
            ];
        });

        setNodes((prev) => [...prev, ...pastedNodes]);
        setConnections((prev) => [...prev, ...nextConnections]);
        setSelectedNodeIds(new Set(pastedNodes.map((node) => node.id)));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(pastedNodes[0]?.type === CanvasNodeType.Group ? null : pastedNodes[0]?.id || null);
        return true;
    }, [getCanvasCenter]);

    const buildDuplicatedSelection = useCallback((selectedIds: Set<string>, offset: number, editableGenerationCopy = false) => {
        const currentNodes = nodesRef.current;
        const sourceIds = new Set(selectedIds);
        currentNodes.forEach((node) => {
            if (node.metadata?.groupId && sourceIds.has(node.metadata.groupId)) sourceIds.add(node.id);
        });
        const sourceNodes = currentNodes.filter((node) => sourceIds.has(node.id) && !isStoryboardNode(node));
        if (!sourceNodes.length) return null;

        const stamp = Date.now();
        const idMap = new Map(sourceNodes.map((node, index) => [node.id, `${node.type}-${stamp}-${index}-${Math.random().toString(36).slice(2, 7)}`]));
        const copies = sourceNodes.map((node) => ({
            ...node,
            id: idMap.get(node.id)!,
            title: node.title.endsWith(" 副本") ? node.title : `${node.title} 副本`,
            position: { x: node.position.x + offset, y: node.position.y + offset },
            metadata: node.metadata
                ? {
                      ...node.metadata,
                      groupId: node.metadata.groupId ? idMap.get(node.metadata.groupId) : undefined,
                      ...(editableGenerationCopy && node.type === CanvasNodeType.Image ? { regenerateInPlace: true } : {}),
                  }
                : undefined,
        }));
        const connections = connectionsRef.current.flatMap((connection, index) => {
            const fromNodeId = idMap.get(connection.fromNodeId);
            const toNodeId = idMap.get(connection.toNodeId);
            return fromNodeId && toNodeId ? [{ ...connection, id: `conn-${stamp}-${index}-${Math.random().toString(36).slice(2, 7)}`, fromNodeId, toNodeId }] : [];
        });
        const selectedCopyIds = [...selectedIds].map((id) => idMap.get(id)).filter((id): id is string => Boolean(id));
        return { copies, connections, selectedCopyIds: selectedCopyIds.length ? selectedCopyIds : copies.map((node) => node.id) };
    }, []);

    const duplicateSelectedNodes = useCallback(() => {
        const duplication = buildDuplicatedSelection(new Set(selectedNodeIdsRef.current), 36);
        if (!duplication) return;

        setNodes((prev) => [...prev, ...duplication.copies]);
        setConnections((prev) => [...prev, ...duplication.connections]);
        setSelectedNodeIds(new Set(duplication.selectedCopyIds));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setDialogNodeId(null);
    }, [buildDuplicatedSelection]);

    const nudgeSelectedNodes = useCallback((dx: number, dy: number) => {
        const moveIds = new Set(selectedNodeIdsRef.current);
        nodesRef.current.forEach((node) => {
            if (node.metadata?.groupId && moveIds.has(node.metadata.groupId)) moveIds.add(node.id);
        });
        if (!moveIds.size) return;
        setNodes((prev) => prev.map((node) => (moveIds.has(node.id) ? { ...node, position: { x: node.position.x + dx, y: node.position.y + dy } } : node)));
        setContextMenu(null);
    }, []);

    const alignSelectedNodes = useCallback((alignment: CanvasAlignment) => {
        setNodes((current) => alignCanvasSelection(current, selectedNodeIdsRef.current, alignment));
        setContextMenu(null);
    }, []);

    const groupSelectedNodes = useCallback(() => {
        const currentNodes = nodesRef.current;
        const selected = currentNodes.filter((node) => selectedNodeIdsRef.current.has(node.id) && node.type !== CanvasNodeType.Group && !isStoryboardNode(node));
        if (selected.length < 2) {
            message.warning(t("canvas.shortcut.groupNeedMultiple"));
            return;
        }

        const selectedIds = new Set(selected.map((node) => node.id));
        const bounds = nodeBounds(selected);
        const width = Math.max(240, bounds.right - bounds.left + 48);
        const height = Math.max(160, bounds.bottom - bounds.top + 80);
        const group = {
            ...createCanvasNode(CanvasNodeType.Group, { x: 0, y: 0 }),
            position: { x: (bounds.left + bounds.right - width) / 2, y: bounds.top - 56 },
            width,
            height,
        };
        const previousGroupIds = new Set(selected.map((node) => node.metadata?.groupId).filter((id): id is string => Boolean(id)));
        const retainedGroupIds = new Set(currentNodes.filter((node) => !selectedIds.has(node.id) && node.metadata?.groupId && previousGroupIds.has(node.metadata.groupId)).map((node) => node.metadata!.groupId!));
        const emptiedGroupIds = new Set([...previousGroupIds].filter((id) => !retainedGroupIds.has(id)));
        const nextNodes = [
            group,
            ...currentNodes
                .filter((node) => !emptiedGroupIds.has(node.id))
                .map((node) => (selectedIds.has(node.id) ? { ...node, metadata: { ...node.metadata, groupId: group.id } } : node)),
        ];

        setNodes(nextNodes);
        setSelectedNodeIds(new Set([group.id]));
        setSelectedConnectionId(null);
        setContextMenu(null);
        setToolbarNodeId(group.id);
        setDialogNodeId(null);
    }, [message, t]);

    const ungroupSelectedNodes = useCallback(() => {
        const currentNodes = nodesRef.current;
        const selected = currentNodes.filter((node) => selectedNodeIdsRef.current.has(node.id) && !isStoryboardNode(node));
        const groupIds = new Set<string>();
        selected.forEach((node) => {
            if (node.type === CanvasNodeType.Group) groupIds.add(node.id);
            else if (node.metadata?.groupId) groupIds.add(node.metadata.groupId);
        });
        if (!groupIds.size) {
            message.warning(t("canvas.shortcut.ungroupNeedGroup"));
            return;
        }

        const releasedIds = new Set(currentNodes.filter((node) => node.metadata?.groupId && groupIds.has(node.metadata.groupId)).map((node) => node.id));
        const nextNodes = currentNodes
            .filter((node) => !groupIds.has(node.id))
            .map((node) => (node.metadata?.groupId && groupIds.has(node.metadata.groupId) ? { ...node, metadata: { ...node.metadata, groupId: undefined } } : node));

        setNodes(nextNodes);
        setSelectedNodeIds(releasedIds);
        setSelectedConnectionId(null);
        setContextMenu(null);
        setToolbarNodeId(null);
        setDialogNodeId(null);
    }, [message, t]);

    const changeViewport = useCallback((next: ViewportTransform) => {
        if (focusAnimRef.current !== null) cancelAnimationFrame(focusAnimRef.current);
        focusAnimRef.current = null;
        viewportRef.current = next;
        setViewport(next);
        setContextMenu(null);
    }, []);

    const resetViewport = useCallback(() => {
        if (focusAnimRef.current !== null) cancelAnimationFrame(focusAnimRef.current);
        focusAnimRef.current = null;
        setViewport({ x: size.width / 2, y: size.height / 2, k: 1 });
        setContextMenu(null);
    }, [size.height, size.width]);

    const focusNode = useCallback(
        (nodeId: string) => {
            const node = nodesRef.current.find((item) => item.id === nodeId);
            if (!node) return;
            const worldX = node.position.x + node.width / 2;
            const worldY = node.position.y + node.height / 2;
            const k = Math.min(Math.max(Math.min((size.width * 0.6) / node.width, (size.height * 0.6) / node.height), 0.05), 1);
            const target = { x: size.width / 2 - worldX * k, y: size.height / 2 - worldY * k, k };
            setSelectedNodeIds(new Set([nodeId]));
            setSelectedConnectionId(null);
            setContextMenu(null);

            if (focusAnimRef.current) cancelAnimationFrame(focusAnimRef.current);
            const start = { ...viewportRef.current };
            const duration = 450;
            const easeOutCubic = (t: number) => 1 - Math.pow(1 - t, 3);
            let startTime: number | null = null;
            const step = (now: number) => {
                if (startTime === null) startTime = now;
                const progress = Math.min((now - startTime) / duration, 1);
                const t = easeOutCubic(progress);
                setViewport({ x: start.x + (target.x - start.x) * t, y: start.y + (target.y - start.y) * t, k: start.k + (target.k - start.k) * t });
                focusAnimRef.current = progress < 1 ? requestAnimationFrame(step) : null;
            };
            focusAnimRef.current = requestAnimationFrame(step);
        },
        [size.height, size.width],
    );

    const focusReferenceNode = useCallback((sourceNodeId: string, referenceNodeId: string) => {
        if (sourceNodeId === referenceNodeId || !nodesRef.current.some((node) => node.id === referenceNodeId && !isStoryboardNode(node))) return;
        setReferenceReturn({ projectId, nodeId: sourceNodeId, viewport: { ...viewportRef.current } });
        setDialogNodeId(null);
        setToolbarNodeId(null);
        focusNode(referenceNodeId);
    }, [focusNode, projectId]);

    const cineflowFocus = searchParams.get("cineflowNode");
    useEffect(() => {
        if (!projectLoaded || !cineflowFocus || !size.width || !size.height) return;
        const target = nodesRef.current.find(node => node.id === cineflowFocus && (node.metadata?.cineflowHandoff || node.metadata?.cineflowAgent));
        if (!target) return;
        focusNode(target.id);
        if (!target.metadata?.content) setDialogNodeId(target.id);
    }, [cineflowFocus, focusNode, projectLoaded, projectId, size.height, size.width]);

    const returnToReferenceSource = useCallback(() => {
        if (!referenceReturn || referenceReturn.projectId !== projectId) return;
        const sourceExists = nodesRef.current.some((node) => node.id === referenceReturn.nodeId);
        changeViewport(referenceReturn.viewport);
        setSelectedNodeIds(sourceExists ? new Set([referenceReturn.nodeId]) : new Set());
        setSelectedConnectionId(null);
        setDialogNodeId(sourceExists ? referenceReturn.nodeId : null);
        setToolbarNodeId(null);
        setReferenceReturn(null);
    }, [changeViewport, projectId, referenceReturn]);

    const fitNodesInView = useCallback(
        (targets: CanvasNodeData[]) => {
            if (!targets.length) return;
            const bounds = nodeBounds(targets);
            const width = Math.max(bounds.right - bounds.left, 1);
            const height = Math.max(bounds.bottom - bounds.top, 1);
            const padding = 96;
            const k = Math.min(Math.max(Math.min((size.width - padding * 2) / width, (size.height - padding * 2) / height), 0.05), 1);
            const worldX = (bounds.left + bounds.right) / 2;
            const worldY = (bounds.top + bounds.bottom) / 2;
            setViewport({ x: size.width / 2 - worldX * k, y: size.height / 2 - worldY * k, k });
            setContextMenu(null);
        },
        [size.height, size.width],
    );

    const cineflowOverview = searchParams.get("cineflowOverview");
    const fittedCineflowOverview = useRef("");
    useEffect(() => {
        const key=`${projectId}:${cineflowOverview}`;
        if(cineflowOverview !== "1" || !projectLoaded || !size.width || !size.height || fittedCineflowOverview.current===key)return;
        const targets=nodesRef.current.filter(n=>n.metadata?.cineflowAgent || n.metadata?.cineflowGroup);
        if(!targets.length)return;
        fitNodesInView(targets);fittedCineflowOverview.current=key;
    },[cineflowOverview,projectId,projectLoaded,size.width,size.height,fitNodesInView]);

    useEffect(() => () => {
        if (focusAnimRef.current !== null) cancelAnimationFrame(focusAnimRef.current);
        focusAnimRef.current = null;
    }, [projectId]);

    const setZoomScale = useCallback(
        (scale: number) => {
            if (focusAnimRef.current !== null) cancelAnimationFrame(focusAnimRef.current);
            focusAnimRef.current = null;
            const nextScale = Math.min(Math.max(scale, 0.05), 5);
            setViewport((prev) => ({
                x: size.width / 2 - ((size.width / 2 - prev.x) / prev.k) * nextScale,
                y: size.height / 2 - ((size.height / 2 - prev.y) / prev.k) * nextScale,
                k: nextScale,
            }));
            setContextMenu(null);
        },
        [size.height, size.width],
    );

    const applyHistory = useCallback((entry: CanvasHistoryEntry) => {
        if (historyCommitTimerRef.current) {
            clearTimeout(historyCommitTimerRef.current);
            historyCommitTimerRef.current = null;
        }
        applyingHistoryRef.current = true;
        const visibleNodes = entry.nodes.filter((node) => !isStoryboardNode(node));
        const visibleIds = new Set(visibleNodes.map((node) => node.id));
        const storyboards = nodesRef.current.filter((node) => isStoryboardNode(node) && visibleIds.has(node.metadata!.storyboardSourceNodeId!));
        const nextNodes = [...visibleNodes, ...storyboards];
        const nextEntry = { ...entry, nodes: nextNodes };
        nodesRef.current = nextNodes;
        setNodes(nextNodes);
        setConnections(entry.connections);
        setChatSessions(entry.chatSessions);
        setActiveChatId(entry.activeChatId);
        setBackgroundMode(entry.backgroundMode);
        setShowImageInfo(entry.showImageInfo);
        setSelectedNodeIds(new Set());
        setSelectedConnectionId(null);
        setContextMenu(null);
        setTimeout(() => {
            lastHistoryRef.current = nextEntry;
            applyingHistoryRef.current = false;
            setHistoryState({ canUndo: historyRef.current.past.length > 0, canRedo: historyRef.current.future.length > 0 });
        });
    }, []);

    const undoCanvas = useCallback(() => {
        const previous = historyRef.current.past.pop();
        const current = lastHistoryRef.current;
        if (!previous || !current) return;
        historyRef.current.future.push(current);
        applyHistory(previous);
    }, [applyHistory]);

    const redoCanvas = useCallback(() => {
        const next = historyRef.current.future.pop();
        const current = lastHistoryRef.current;
        if (!next || !current) return;
        historyRef.current.past.push(current);
        applyHistory(next);
    }, [applyHistory]);

    // Commit a batch immediately as one undo step, separate from preceding pending edits.
    const addImagesToGeneration = useCallback((imageIds: string[], type: CanvasNodeType.Image | CanvasNodeType.Video, targetId?: string, position?: Position) => {
        if (!imageIds.length) return;
        const currentNodes = nodesRef.current;
        const images = imageIds.flatMap((id) => { const node = currentNodes.find((item) => item.id === id); return node ? [node] : []; });
        if (!images.length) return;
        const created = targetId ? null : createCanvasNode(type, position || {
            x: Math.max(...images.map((node) => node.position.x + node.width)) + 100 + NODE_DEFAULT_SIZE[type].width / 2,
            y: Math.min(...images.map((node) => node.position.y)) + NODE_DEFAULT_SIZE[type].height / 2,
        }, type === CanvasNodeType.Image ? { size: effectiveConfig.imageSize } : defaultVideoNodeMetadata(effectiveConfig));
        if (created) {
            // Keep the new card to the right of the sources without covering an existing card.
            for (let attempt = 0; attempt <= currentNodes.length; attempt++) {
                const overlaps = currentNodes.filter((node) => !node.metadata?.hidden && node.type !== CanvasNodeType.Group && created.position.x < node.position.x + node.width + 24 && created.position.x + created.width + 24 > node.position.x && created.position.y < node.position.y + node.height + 24 && created.position.y + created.height + 24 > node.position.y);
                if (!overlaps.length) break;
                created.position.y = Math.max(...overlaps.map((node) => node.position.y + node.height)) + 60;
            }
        }
        const nextNodes = created ? [...currentNodes, created] : currentNodes;
        const generationNodeId = targetId || created!.id;
        try {
            const result = appendGenerationReferences(nextNodes, connectionsRef.current, generationNodeId, imageIds);
            if (result.added || created) {
                if (historyCommitTimerRef.current) clearTimeout(historyCommitTimerRef.current);
                historyCommitTimerRef.current = null;
                const before = createHistoryEntry();
                const last = lastHistoryRef.current;
                if (last && (last.nodes !== before.nodes || last.connections !== before.connections)) historyRef.current.past.push(last);
                historyRef.current.past = [...historyRef.current.past.slice(-49), before];
                historyRef.current.future = [];
                nodesRef.current = nextNodes;
                connectionsRef.current = result.connections;
                lastHistoryRef.current = { ...before, nodes: nextNodes, connections: result.connections };
                setNodes(nextNodes);
                setConnections(result.connections);
                setHistoryState({ canUndo: true, canRedo: false });
            }
            setSelectedNodeIds(new Set([generationNodeId]));
            setDialogNodeId(generationNodeId);
            setToolbarNodeId(generationNodeId);
            message.success(result.added ? `已添加 ${result.added} 个参考素材${result.skipped ? `，跳过 ${result.skipped} 个已连接素材` : ""}` : "所选素材已全部连接，无需重复添加");
        } catch (error) {
            message.warning(error instanceof Error ? error.message : "添加参考图失败");
        }
    }, [createHistoryEntry, effectiveConfig.imageSize, effectiveConfig.videoSize, message]);

    const connectSelectedResources = useCallback((ids: string[], type: CanvasNodeType.Image | CanvasNodeType.Video, client: { x: number; y: number }, targetId?: string) => {
        addImagesToGeneration(ids, type, targetId, screenToCanvas(client.x, client.y));
    }, [addImagesToGeneration, screenToCanvas]);

    const reorderNodeReferences = useCallback((nodeId: string, ids: string[]) => {
        try {
            const result = reorderGenerationReferences(nodesRef.current, connectionsRef.current, nodeId, ids);
            if (historyCommitTimerRef.current) clearTimeout(historyCommitTimerRef.current);
            historyCommitTimerRef.current = null;
            const before = createHistoryEntry();
            const last = lastHistoryRef.current;
            if (last && (last.nodes !== before.nodes || last.connections !== before.connections)) historyRef.current.past.push(last);
            historyRef.current.past = [...historyRef.current.past.slice(-49), before];
            historyRef.current.future = [];
            nodesRef.current = result.nodes;
            connectionsRef.current = result.connections;
            lastHistoryRef.current = { ...before, ...result };
            setNodes(result.nodes);
            setConnections(result.connections);
            setHistoryState({ canUndo: true, canRedo: false });
        } catch (error) { message.warning(error instanceof Error ? error.message : "参考素材排序失败"); }
    }, [createHistoryEntry, message]);


    const handleCanvasMouseDown = useCallback(
        (event: ReactPointerEvent<HTMLDivElement>) => {
            setContextMenu(null);
            setNodeCreatePosition(null);
            setExpandedImageNodeId(null);
            setHoveredNodeId(null);
            setToolbarNodeId(null);
            setDialogNodeId(null);
            setEditingNodeId(null);
            if (pendingConnectionCreateRef.current) cancelPendingConnectionCreate();
            if (event.button !== 0) return;

            const world = screenToCanvas(event.clientX, event.clientY);
            const nextSelectionBox = {
                startWorldX: world.x,
                startWorldY: world.y,
                currentWorldX: world.x,
                currentWorldY: world.y,
                additive: event.shiftKey,
                initialSelectedNodeIds: event.shiftKey ? Array.from(selectedNodeIdsRef.current) : [],
            };
            selectionBoxRef.current = nextSelectionBox;
            selectionPointerRef.current = event.pointerId;
            selectionClientRef.current = { x: event.clientX, y: event.clientY };
            if (containerRef.current) containerRef.current.dataset.canvasSelecting = "true";
            setSelectionBox(nextSelectionBox);
            if (!event.shiftKey) {
                setSelectedNodeIds(new Set());
            }

            setSelectedConnectionId(null);
        },
        [cancelPendingConnectionCreate, screenToCanvas],
    );

    // Selection-only logic shared by the bubbling drag entry point and outer capture handler.
    // Returns the single target ID after the click, or null for multi-selection or deselection, to sync the toolbar.
    const selectNodeByEvent = useCallback((event: Pick<ReactMouseEvent, "shiftKey" | "metaKey" | "ctrlKey">, nodeId: string) => {
        const nextSelected = new Set(selectedNodeIdsRef.current);
        if (event.shiftKey || event.metaKey || event.ctrlKey) {
            if (nextSelected.has(nodeId)) nextSelected.delete(nodeId);
            else nextSelected.add(nodeId);
        } else if (!nextSelected.has(nodeId)) {
            nextSelected.clear();
            nextSelected.add(nodeId);
        }
        setSelectedNodeIds(nextSelected);
        const soloId = nextSelected.size === 1 && nextSelected.has(nodeId) ? nodeId : null;
        setToolbarNodeId(soloId);
        return { nextSelected, soloId };
    }, []);

    // Capture-phase selection lets any inner element, including textarea or iframe, select the node and show its toolbar.
    // It only selects; body onMouseDown still starts dragging, so text selection inside editors does not drag the node.
    // Cache the capture result for the following bubbling drag handler to avoid applying shift-selection twice.
    const pendingSelectionRef = useRef<Set<string> | null>(null);
    const handleNodeSelectCapture = useCallback(
        (event: ReactMouseEvent, nodeId: string) => {
            if (event.button !== 0) return;
            setContextMenu(null);
            setHoveredNodeId(null);
            setSelectedConnectionId(null);
            const { nextSelected } = selectNodeByEvent(event, nodeId);
            if (nodesRef.current.find((node) => node.id === nodeId)?.type === CanvasNodeType.Group &&
                (!(event.target instanceof Element) || !event.target.closest('[data-group-drag-handle]') || event.target.closest('input'))) {
                pendingSelectionRef.current = null;
                return;
            }
            if (event.altKey) {
                const duplication = buildDuplicatedSelection(nextSelected, 0, true);
                if (!duplication) return;
                event.preventDefault();
                event.stopPropagation();
                pendingSelectionRef.current = null;
                setNodes((prev) => [...prev, ...duplication.copies]);
                setConnections((prev) => [...prev, ...duplication.connections]);
                setSelectedNodeIds(new Set(duplication.selectedCopyIds));
                setDialogNodeId(null);
                dragRef.current = {
                    isDraggingNode: true,
                    hasMoved: false,
                    startX: event.clientX,
                    startY: event.clientY,
                    initialSelectedNodes: duplication.copies.map((node) => ({ id: node.id, x: node.position.x, y: node.position.y })),
                    duplicatedNodeIds: duplication.copies.map((node) => node.id),
                    originalSelectedNodeIds: [...nextSelected],
                };
                historyPausedRef.current = true;
                nodeDraggingRef.current = true;
                setIsNodeDragging(true);
                return;
            }
            pendingSelectionRef.current = nextSelected;
        },
        [buildDuplicatedSelection, selectNodeByEvent],
    );

    const cancelNodeDrag = useCallback(() => {
        if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
        if (!dragRef.current.isDraggingNode) return;
        const initialPositions = dragRef.current.initialSelectedNodes;
        setNodes((prev) =>
            prev.map((node) => {
                const initial = initialPositions.find((item) => item.id === node.id);
                return initial ? { ...node, position: { x: initial.x, y: initial.y } } : node;
            }),
        );
        historyPausedRef.current = false;
        nodeDraggingRef.current = false;
        setIsNodeDragging(false);
        setDropTargetGroupId(null);
        dragRef.current.isDraggingNode = false;
        dragRef.current.hasMoved = false;
        dragRef.current.initialSelectedNodes = [];
        const duplicatedIds = new Set(dragRef.current.duplicatedNodeIds);
        if (duplicatedIds.size) {
            setNodes((prev) => prev.filter((node) => !duplicatedIds.has(node.id)));
            setConnections((prev) => prev.filter((connection) => !duplicatedIds.has(connection.fromNodeId) && !duplicatedIds.has(connection.toNodeId)));
            setSelectedNodeIds(new Set(dragRef.current.originalSelectedNodeIds));
        }
        dragRef.current.duplicatedNodeIds = [];
        dragRef.current.originalSelectedNodeIds = [];
    }, []);

    const handleNodeMouseDown = useCallback((event: ReactMouseEvent, nodeId: string) => {
        // 仅左键开始拖节点；右键/中键留给平移或取消，避免多选拖拽时右键卡死
        if (event.button !== 0) return;
        event.stopPropagation();
        // Capture already selected the node; this only starts dragging, with a fallback selection if capture did not run.
        const currentNodes = nodesRef.current;
        if (currentNodes.find((node) => node.id === nodeId)?.type === CanvasNodeType.Group &&
            (!(event.target instanceof Element) || !event.target.closest('[data-group-drag-handle]') || event.target.closest('input'))) {
            pendingSelectionRef.current = null;
            return;
        }
        const nextSelected = pendingSelectionRef.current ?? selectNodeByEvent(event, nodeId).nextSelected;
        pendingSelectionRef.current = null;
        const dragIds = new Set(nextSelected);
        currentNodes.forEach((node) => {
            if (!nextSelected.has(node.id)) return;
            if (node.type === CanvasNodeType.Group) {
                currentNodes.forEach((child) => {
                    if (child.metadata?.groupId === node.id) dragIds.add(child.id);
                });
            }
        });
        dragRef.current = {
            isDraggingNode: true,
            hasMoved: false,
            startX: event.clientX,
            startY: event.clientY,
            initialSelectedNodes: currentNodes.filter((node) => dragIds.has(node.id)).map((node) => ({ id: node.id, x: node.position.x, y: node.position.y })),
            duplicatedNodeIds: [],
            originalSelectedNodeIds: [],
        };
        historyPausedRef.current = true;
        nodeDraggingRef.current = true;
        setIsNodeDragging(true);
    }, [selectNodeByEvent]);

    const finishNodeDrag = useCallback((clientX?: number, clientY?: number) => {
        if (rafRef.current) {
            cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        }
        if (!dragRef.current.isDraggingNode) return;

        const duplicated = dragRef.current.duplicatedNodeIds.length > 0;
        const wasClick = !duplicated && !dragRef.current.hasMoved && dragRef.current.initialSelectedNodes.length === 1;
        const clickedNodeId = dragRef.current.initialSelectedNodes[0]?.id;
        const currentViewport = viewportRef.current;
        const dx = clientX == null ? 0 : (clientX - dragRef.current.startX) / currentViewport.k;
        const dy = clientY == null ? 0 : (clientY - dragRef.current.startY) / currentViewport.k;
        const initialPositions = dragRef.current.initialSelectedNodes;

        historyPausedRef.current = false;
        nodeDraggingRef.current = false;
        setIsNodeDragging(false);
        setDropTargetGroupId(null);
        if (dragRef.current.hasMoved && clientX != null && clientY != null) {
            const movedIds = new Set(initialPositions.map((item) => item.id));
            setNodes((prev) => {
                const moved = prev.map((node) => {
                    const initial = initialPositions.find((item) => item.id === node.id);
                    return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                });
                const targetGroup = findGroupDropTarget(movedIds, moved);
                if (targetGroup) return snapNodesIntoGroup(movedIds, moved, targetGroup);
                return moved.map((node) => {
                    if (!movedIds.has(node.id) || node.type === CanvasNodeType.Group) return node;
                    const groupId = findContainingGroupId(node, moved);
                    if (node.metadata?.groupId === groupId) return node;
                    return { ...node, metadata: { ...node.metadata, groupId } };
                });
            });
        } else if (duplicated) {
            // Alt+click without movement still creates one copy and must trigger persistence/history after the paused drag phase.
            setNodes((prev) => [...prev]);
        }

        dragRef.current.isDraggingNode = false;
        dragRef.current.hasMoved = false;
        dragRef.current.initialSelectedNodes = [];
        dragRef.current.duplicatedNodeIds = [];
        dragRef.current.originalSelectedNodeIds = [];
        if (wasClick && clickedNodeId) {
            const clickedNode = nodesRef.current.find((node) => node.id === clickedNodeId);
            const clickedDefinition = clickedNode ? getNodeDefinition(clickedNode.type) : undefined;
            if (clickedNode?.type === CanvasNodeType.Text) {
                setDialogNodeId((current) => (current === clickedNodeId ? current : null));
            } else if (clickedDefinition?.hidePanel) {
                // Clicking a display-only plugin node selects it without opening a lower panel.
                setDialogNodeId((current) => (current === clickedNodeId ? current : null));
            } else if (clickedNode?.type === CanvasNodeType.Image || clickedNode?.type === CanvasNodeType.Video) {
                setDialogNodeId((current) => (current === clickedNodeId ? null : clickedNodeId));
            } else if (clickedNode?.type !== CanvasNodeType.Group) {
                setDialogNodeId(clickedNodeId);
            }
        }
    }, []);

    const handleGlobalMouseMove = useCallback(
        (event: MouseEvent) => {
            const currentViewport = viewportRef.current;

            if (dragRef.current.isDraggingNode) {
                // 拖拽中按下右键(2)/中键(4)则取消，避免卡在“跟着鼠标拖”的状态
                if (event.buttons & 2 || event.buttons & 4) {
                    cancelNodeDrag();
                    return;
                }
                const dx = (event.clientX - dragRef.current.startX) / currentViewport.k;
                const dy = (event.clientY - dragRef.current.startY) / currentViewport.k;
                const initialPositions = dragRef.current.initialSelectedNodes;
                if (Math.abs(event.clientX - dragRef.current.startX) > 4 || Math.abs(event.clientY - dragRef.current.startY) > 4) {
                    dragRef.current.hasMoved = true;
                }

                const movedIds = new Set(initialPositions.map((item) => item.id));
                const previewNodes = nodesRef.current.map((node) => {
                    const initial = initialPositions.find((item) => item.id === node.id);
                    return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                });
                setDropTargetGroupId(findGroupDropTarget(movedIds, previewNodes)?.id || null);

                if (rafRef.current) cancelAnimationFrame(rafRef.current);
                rafRef.current = requestAnimationFrame(() => {
                    setNodes((prev) =>
                        prev.map((node) => {
                            const initial = initialPositions.find((item) => item.id === node.id);
                            return initial ? { ...node, position: { x: initial.x + dx, y: initial.y + dy } } : node;
                        }),
                    );
                    rafRef.current = null;
                });
                return;
            }

            if (connectingParamsRef.current && !pendingConnectionCreateRef.current) {
                const dropTarget = getConnectionDropTarget(event.clientX, event.clientY, connectingParamsRef.current);
                connectionTargetNodeIdRef.current = dropTarget.nodeId;
                setConnectionTargetNodeId(dropTarget.nodeId);
                setMouseWorld(screenToCanvas(event.clientX, event.clientY));
            }
        },
        [cancelNodeDrag, finishNodeDrag, getConnectionDropTarget, screenToCanvas],
    );

    const updateMarqueeSelection = useCallback(
        (clientX: number, clientY: number) => {
            const currentSelection = selectionBoxRef.current;
            if (!currentSelection) return;
            const world = screenToCanvas(clientX, clientY);
            const rectX = Math.min(currentSelection.startWorldX, world.x);
            const rectY = Math.min(currentSelection.startWorldY, world.y);
            const rectW = Math.abs(world.x - currentSelection.startWorldX);
            const rectH = Math.abs(world.y - currentSelection.startWorldY);
            const nextSelected = new Set<string>(currentSelection.additive ? currentSelection.initialSelectedNodeIds : []);

            nodesRef.current
                .filter((node) => !isStoryboardNode(node))
                .forEach((node) => {
                    // A partial marquee inside a group selects its intersecting materials, not every child of the group.
                    if (marqueeSelectsNode(node, { x: rectX, y: rectY, width: rectW, height: rectH })) nextSelected.add(node.id);
                });

            const nextSelectionBox = { ...currentSelection, currentWorldX: world.x, currentWorldY: world.y };
            selectionBoxRef.current = nextSelectionBox;
            // Keep the marquee responsive without rerendering every node/ribbon for
            // every pointer event. React owns its lifetime; this frame owns its rect.
            if (selectionSvgRef.current) Object.assign(selectionSvgRef.current.style, {
                left: `${rectX}px`, top: `${rectY}px`, width: `${rectW}px`, height: `${rectH}px`,
            });
            setSelectedNodeIds(previous => previous.size === nextSelected.size && [...previous].every(id => nextSelected.has(id)) ? previous : nextSelected);
        },
        [screenToCanvas],
    );

    const handleGlobalPointerMove = useCallback((event: PointerEvent) => {
        if (!selectionBoxRef.current || event.pointerId !== selectionPointerRef.current) return;
        if (!(event.buttons & 1)) {
            updateMarqueeSelection(event.clientX, event.clientY);
            clearMarquee();
            return;
        }
        selectionClientRef.current = { x: event.clientX, y: event.clientY };
        if (selectionFrameRef.current !== null) return;
        selectionFrameRef.current = requestAnimationFrame(() => {
            selectionFrameRef.current = null;
            updateMarqueeSelection(selectionClientRef.current.x, selectionClientRef.current.y);
        });
    }, [clearMarquee, updateMarqueeSelection]);

    const handleGlobalMouseUp = useCallback(
        (event: MouseEvent) => {
            finishNodeDrag(event.clientX, event.clientY);

            if (event.button === 0 && selectionBoxRef.current) {
                updateMarqueeSelection(event.clientX, event.clientY);
                clearMarquee();
            }

            if (pendingConnectionCreateRef.current) return;

            const currentConnection = connectingParamsRef.current;
            if (currentConnection) {
                const dropTarget = getConnectionDropTarget(event.clientX, event.clientY, currentConnection);
                if (dropTarget.nodeId) {
                    connectNodes(currentConnection, dropTarget.nodeId);
                    setConnecting(null);
                } else if (dropTarget.isNearNode) {
                    setConnecting(null);
                } else {
                    setMouseWorld(screenToCanvas(event.clientX, event.clientY));
                    setPendingConnectionCreate({ connection: currentConnection, position: screenToCanvas(event.clientX, event.clientY) });
                }
            }
        },
        [clearMarquee, updateMarqueeSelection, connectNodes, finishNodeDrag, getConnectionDropTarget, screenToCanvas, setConnecting],
    );

    useEffect(() => {
        const handlePointerUp = (event: PointerEvent) => {
            finishNodeDrag(event.clientX, event.clientY);
            if (selectionBoxRef.current && event.pointerId === selectionPointerRef.current) {
                updateMarqueeSelection(event.clientX, event.clientY);
                clearMarquee();
            }
        };
        const cancelInteraction = () => { cancelNodeDrag(); clearMarquee(); };
        const handlePointerDown = (event: PointerEvent) => {
            if (!dragRef.current.isDraggingNode) return;
            if (event.button === 1 || event.button === 2) {
                event.preventDefault();
                cancelNodeDrag();
            }
        };
        window.addEventListener("mousemove", handleGlobalMouseMove);
        window.addEventListener("mouseup", handleGlobalMouseUp);
        window.addEventListener("pointerup", handlePointerUp);
        window.addEventListener("pointerdown", handlePointerDown, true);
        window.addEventListener("pointercancel", cancelInteraction);
        window.addEventListener("blur", cancelInteraction);
        window.addEventListener("lostpointercapture", clearMarquee);
        window.addEventListener("pointermove", handleGlobalPointerMove);
        return () => {
            window.removeEventListener("mousemove", handleGlobalMouseMove);
            window.removeEventListener("mouseup", handleGlobalMouseUp);
            window.removeEventListener("pointerup", handlePointerUp);
            window.removeEventListener("pointerdown", handlePointerDown, true);
            window.removeEventListener("pointercancel", cancelInteraction);
            window.removeEventListener("blur", cancelInteraction);
            window.removeEventListener("lostpointercapture", clearMarquee);
            window.removeEventListener("pointermove", handleGlobalPointerMove);
        };
    }, [clearMarquee, updateMarqueeSelection, cancelNodeDrag, finishNodeDrag, handleGlobalMouseMove, handleGlobalMouseUp, handleGlobalPointerMove]);

    const createImageFileNode = useCallback(async (file: File, position: Position) => {
        const image = await uploadImage(file);
        const size = fitNodeSize(image.width, image.height);
        const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        const newNode: CanvasNodeData = {
            id,
            type: CanvasNodeType.Image,
            title: file.name,
            position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
            width: size.width,
            height: size.height,
            metadata: imageMetadata(image),
        };

        setNodes((prev) => [...prev, newNode]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const createVideoFileNode = useCallback(async (file: File, position: Position) => {
        const video = await uploadMediaFile(file, "video");
        const size = fitNodeSize(video.width || 1280, video.height || 720, MEDIA_NODE_LONG_EDGE, MEDIA_NODE_LONG_EDGE);
        const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Video,
                title: file.name,
                position: { x: position.x - size.width / 2, y: position.y - size.height / 2 },
                width: size.width,
                height: size.height,
                metadata: videoMetadata(video),
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const createAudioFileNode = useCallback(async (file: File, position: Position) => {
        const audio = await uploadMediaFile(file, "audio");
        const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
        const id = `audio-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
        setNodes((prev) => [
            ...prev,
            {
                id,
                type: CanvasNodeType.Audio,
                title: file.name,
                position: { x: position.x - spec.width / 2, y: position.y - spec.height / 2 },
                width: spec.width,
                height: spec.height,
                metadata: audioMetadata(audio),
            },
        ]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
    }, []);

    const createTextNodeFromClipboard = useCallback(
        (text: string) => {
            const trimmed = text.trim();
            if (!trimmed) return false;

            const node = {
                ...createCanvasNode(CanvasNodeType.Text, getCanvasCenter(), { content: trimmed, status: NODE_STATUS_SUCCESS }),
                title: trimmed.slice(0, 32) || t("canvas.projectPage.clipboardText"),
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
            setContextMenu(null);
            setDialogNodeId(node.id);
            return true;
        },
        [getCanvasCenter, t],
    );

    const pasteSystemClipboard = useCallback(async () => {
        if (!navigator.clipboard) return;

        const items = await navigator.clipboard.read();
        const imageItem = items.find((item) => item.types.some((type) => type.startsWith("image/")));
        if (imageItem) {
            const imageType = imageItem.types.find((type) => type.startsWith("image/"));
            if (!imageType) return;
            const blob = await imageItem.getType(imageType);
            const file = new File([blob], "clipboard-image.png", { type: imageType });
            void createImageFileNode(file, getCanvasCenter());
            message.success(t("canvas.projectPage.clipboardImageAdded"));
            return;
        }

        const text = await navigator.clipboard.readText();
        if (createTextNodeFromClipboard(text)) message.success(t("canvas.projectPage.clipboardTextAdded"));
    }, [createImageFileNode, createTextNodeFromClipboard, getCanvasCenter, message, t]);

    useEffect(() => {
        const handleKeyDown = (event: KeyboardEvent) => {
            const target = event.target instanceof Element ? event.target : null;
            if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement || target?.closest("[contenteditable='true'],[data-canvas-no-zoom],[data-canvas-shortcuts-ignore]")) return;

            const key = event.key.toLowerCase();
            const isModifierShortcut = event.metaKey || event.ctrlKey;

            if (isModifierShortcut && key === "c" && window.getSelection()?.toString()) return;

            if (isModifierShortcut && !event.altKey && key === "z") {
                event.preventDefault();
                if (event.shiftKey) redoCanvas();
                else undoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "y") {
                event.preventDefault();
                redoCanvas();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "a") {
                event.preventDefault();
                setSelectedNodeIds(new Set(nodesRef.current.filter((node) => !isStoryboardNode(node)).map((node) => node.id)));
                setSelectedConnectionId(null);
                setContextMenu(null);
                clearMarquee();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "g") {
                event.preventDefault();
                if (event.shiftKey) ungroupSelectedNodes();
                else groupSelectedNodes();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "c") {
                event.preventDefault();
                copySelectedNodes();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "v") {
                event.preventDefault();
                if (!pasteCopiedNodes()) void pasteSystemClipboard();
                return;
            }

            if (isModifierShortcut && !event.altKey && key === "d") {
                event.preventDefault();
                duplicateSelectedNodes();
                return;
            }

            if (!isModifierShortcut && !event.altKey && ["arrowup", "arrowdown", "arrowleft", "arrowright"].includes(key)) {
                if (!selectedNodeIdsRef.current.size) return;
                event.preventDefault();
                const step = event.shiftKey ? 10 : 1;
                nudgeSelectedNodes(key === "arrowleft" ? -step : key === "arrowright" ? step : 0, key === "arrowup" ? -step : key === "arrowdown" ? step : 0);
                return;
            }

            if (!isModifierShortcut && !event.altKey && key === "f") {
                event.preventDefault();
                if (event.shiftKey) {
                    fitNodesInView(nodesRef.current.filter((node) => !isStoryboardNode(node)));
                } else {
                    const selected = nodesRef.current.filter((node) => selectedNodeIdsRef.current.has(node.id) && !isStoryboardNode(node));
                    if (selected.length === 1) focusNode(selected[0].id);
                    else fitNodesInView(selected);
                }
                return;
            }

            if (!isModifierShortcut && !event.altKey && event.key === "0") {
                event.preventDefault();
                setZoomScale(1);
                return;
            }

            if (!isModifierShortcut && !event.altKey && event.key === "Enter") {
                const selected = nodesRef.current.filter((node) => selectedNodeIdsRef.current.has(node.id));
                if (selected.length !== 1 || selected[0].type !== CanvasNodeType.Text) return;
                event.preventDefault();
                setEditingNodeId(selected[0].id);
                setEditRequestNonce((value) => value + 1);
                return;
            }

            if (!isModifierShortcut && !event.altKey && event.key === "F2") {
                const selected = nodesRef.current.filter((node) => selectedNodeIdsRef.current.has(node.id));
                if (selected.length !== 1) return;
                event.preventDefault();
                setRenamingNodeId(selected[0].id);
                setRenameRequestNonce((value) => value + 1);
                return;
            }

            if (event.key === "Delete" || event.key === "Backspace") {
                if (selectedNodeIdsRef.current.size) {
                    setDeleteConfirm({ ids: new Set(selectedNodeIdsRef.current) });
                } else if (selectedConnectionId) {
                    deleteConnection(selectedConnectionId);
                }
            }

            if (event.key === "Escape") {
                setSelectedNodeIds(new Set());
                setSelectedConnectionId(null);
                setContextMenu(null);
                setNodeCreatePosition(null);
                clearMarquee();
                setConnecting(null);
                setHoveredNodeId(null);
                setToolbarNodeId(null);
                setDialogNodeId(null);
                setEditingNodeId(null);
                setRenamingNodeId(null);
                setInfoNodeId(null);
                setCropNodeId(null);
                setMaskEditNodeId(null);
                setPendingConnectionCreate(null);
            }
        };

        window.addEventListener("keydown", handleKeyDown);
        return () => window.removeEventListener("keydown", handleKeyDown);
    }, [clearMarquee, copySelectedNodes, deleteConnection, duplicateSelectedNodes, fitNodesInView, focusNode, groupSelectedNodes, nudgeSelectedNodes, pasteCopiedNodes, pasteSystemClipboard, redoCanvas, selectedConnectionId, setConnecting, setZoomScale, undoCanvas, ungroupSelectedNodes]);

    const handleConnectStart = useCallback(
        (event: ReactMouseEvent, nodeId: string, handleType: "source" | "target") => {
            event.stopPropagation();
            setMouseWorld(screenToCanvas(event.clientX, event.clientY));
            setConnecting({ nodeId, handleType });
            connectionTargetNodeIdRef.current = null;
            setConnectionTargetNodeId(null);
            setSelectedConnectionId(null);
        },
        [screenToCanvas, setConnecting],
    );

    const handleNodeResize = useCallback((nodeId: string, width: number, height: number, position?: Position) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, width, height, position: position || node.position } : node)));
    }, []);

    const handleNodeResizeStart = useCallback(() => {
        setIsNodeResizing(true);
        setExpandedImageNodeId(null);
    }, []);
    const handleNodeResizeEnd = useCallback(() => setIsNodeResizing(false), []);

    const toggleNodeFreeResize = useCallback((nodeId: string) => {
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                const freeResize = !node.metadata?.freeResize;
                if (freeResize || node.type !== CanvasNodeType.Image) return { ...node, metadata: { ...node.metadata, freeResize } };
                const ratio = (node.metadata?.naturalWidth || node.width) / (node.metadata?.naturalHeight || node.height || 1);
                const height = node.width / ratio;
                return { ...node, height, position: { x: node.position.x, y: node.position.y + node.height / 2 - height / 2 }, metadata: { ...node.metadata, freeResize } };
            }),
        );
    }, []);

    const handleNodeContentChange = useCallback((nodeId: string, content: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, content } } : node)));
    }, []);

    const handleImageDimensions = useCallback((nodeId: string, source: string, width: number, height: number) => {
        setNodes((prev) => {
            const index = prev.findIndex((node) => node.id === nodeId);
            if (index < 0) return prev;
            const corrected = applyLoadedImageDimensions(prev[index], source, width, height);
            if (corrected === prev[index]) return prev;
            return prev.map((node, i) => i === index ? corrected : node);
        });
    }, []);

    const handleNodeTitleChange = useCallback((nodeId: string, title: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, title } : node)));
    }, []);

    const toggleBatchExpanded = useCallback((nodeId: string) => {
        const result = expandImageBatch(nodesRef.current, connectionsRef.current, nodeId, nanoid);
        if (!result) {
            message.info("图片仍在生成，请等待本组生成结束后展开");
            return;
        }
        if (historyCommitTimerRef.current) clearTimeout(historyCommitTimerRef.current);
        historyCommitTimerRef.current = null;
        const before = createHistoryEntry();
        const last = lastHistoryRef.current;
        if (last && (last.nodes !== before.nodes || last.connections !== before.connections)) historyRef.current.past.push(last);
        historyRef.current.past = [...historyRef.current.past.slice(-49), before];
        historyRef.current.future = [];
        nodesRef.current = result.nodes;
        connectionsRef.current = result.connections;
        lastHistoryRef.current = { ...before, ...result };
        setNodes(result.nodes);
        setConnections(result.connections);
        setHistoryState({ canUndo: true, canRedo: false });
        setExpandedImageNodeId(null);
        setSelectedNodeIds(new Set([nodeId]));
        setToolbarNodeId(nodeId);
        setDialogNodeId(null);
        setSelectedConnectionId(null);
        message.success("已展开为独立图片，可单独操作；撤销可恢复图片组");
    }, [createHistoryEntry, message]);

    const setBatchPrimary = useCallback((nodeId: string, imageId: string) => {
        setNodes((prev) =>
            prev.map((node) => {
                if (node.id !== nodeId) return node;
                const image = node.metadata?.images?.find((item) => item.id === imageId);
                if (!image?.content) return node;
                const edge = Math.max(node.width, node.height);
                const size = node.metadata?.freeResize ? { width: node.width, height: node.height } : fitNodeSize(image.naturalWidth, image.naturalHeight, edge, edge);
                return {
                    ...node,
                    position: { x: node.position.x + node.width / 2 - size.width / 2, y: node.position.y + node.height / 2 - size.height / 2 },
                    ...size,
                    metadata: {
                        ...node.metadata,
                        content: image.content,
                        storageKey: image.storageKey,
                        naturalWidth: image.naturalWidth,
                        naturalHeight: image.naturalHeight,
                        bytes: image.bytes,
                        mimeType: image.mimeType,
                        primaryImageId: image.id,
                    },
                };
            }),
        );
    }, []);

    const duplicateBatchImage = useCallback((node: CanvasNodeData, imageId: string) => {
        const image = node.metadata?.images?.find((item) => item.id === imageId);
        if (!image?.content) return;
        const id = nanoid();
        const edge = Math.max(node.width, node.height);
        const size = fitNodeSize(image.naturalWidth, image.naturalHeight, edge, edge);
        const copy: CanvasNodeData = {
            id,
            type: CanvasNodeType.Image,
            title: node.title,
            position: { x: node.position.x + node.width * 2 + 96, y: node.position.y + node.height / 2 - size.height / 2 },
            ...size,
            metadata: {
                content: image.content,
                storageKey: image.storageKey,
                naturalWidth: image.naturalWidth,
                naturalHeight: image.naturalHeight,
                bytes: image.bytes,
                mimeType: image.mimeType,
                status: NODE_STATUS_SUCCESS,
                prompt: node.metadata?.prompt,
                generationType: node.metadata?.generationType,
                model: node.metadata?.model,
                size: node.metadata?.size,
                quality: node.metadata?.quality,
                background: node.metadata?.background,
                references: node.metadata?.references,
                generationDurationMs: image.generationDurationMs,
            },
        };
        setNodes((prev) => [...prev, copy]);
        setSelectedNodeIds(new Set([id]));
        setSelectedConnectionId(null);
        setDialogNodeId(id);
    }, []);

    const openTextEditor = useCallback((node: CanvasNodeData) => {
        if (node.type !== CanvasNodeType.Text) return;
        setSelectedNodeIds(new Set([node.id]));
        setSelectedConnectionId(null);
        setDialogNodeId(node.id);
        setEditingNodeId(node.id);
        setEditRequestNonce((value) => value + 1);
    }, []);

    const handleNodePromptChange = useCallback((nodeId: string, prompt: string) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt } } : node)));
    }, []);

    const handleConfigNodeChange = useCallback((nodeId: string, patch: Partial<CanvasNodeData["metadata"]>) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? applyNodeConfigPatch(node, patch) : node)));
    }, []);
    const handleGroupColorChange = useCallback((nodeId: string, groupColor: string | undefined) => handleConfigNodeChange(nodeId, { groupColor }), [handleConfigNodeChange]);

    const downloadNodeImage = useCallback(async (node: CanvasNodeData) => {
        if ((node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Audio) || !node.metadata?.content) return;
        try {
            await downloadFile({
                source: node.metadata.content,
                storageKey: node.metadata.storageKey,
                filename: `${node.title || `canvas-${node.type}-${node.id}`}.${node.type === CanvasNodeType.Video ? videoFileExtension(node.metadata.mimeType) : node.type === CanvasNodeType.Audio ? audioExtension(node.metadata.mimeType) : imageExtension(node.metadata.content)}`,
            });
        } catch {
            message.error(t("common.downloadFailed"));
        }
    }, [message, t]);

    const downloadBatchImage = useCallback(async (node: CanvasNodeData, imageId: string) => {
        const image = node.metadata?.images?.find((item) => item.id === imageId);
        if (!image?.content) return;
        try {
            await downloadFile({ source: image.content, storageKey: image.storageKey, filename: `${node.title || `canvas-image-${node.id}`}-${image.id}.${imageExtension(image.content)}` });
        } catch {
            message.error(t("common.downloadFailed"));
        }
    }, [message, t]);

    const confirmTrimVideo = useCallback(async () => {
        const node = nodesRef.current.find((item) => item.id === trimNodeId);
        if (!node?.metadata?.content || trimming) return;
        if (trimStart < 0 || trimEnd <= trimStart || trimEnd > trimDuration + 0.05) {
            message.warning("请设置有效的起止时间");
            return;
        }
        setTrimming(true);
        setTrimProgress(0);
        try {
            const { blob, extension } = await trimVideo(node.metadata.content, node.metadata.storageKey, trimStart, trimEnd, setTrimProgress);
            setTrimProgress(1);
            const uploaded = await uploadMediaFile(blob, "video");
            const id = `video-${nanoid()}`;
            const size = fitNodeSize(uploaded.width || node.metadata.naturalWidth || 1280, uploaded.height || node.metadata.naturalHeight || 720, Math.max(node.width, node.height), Math.max(node.width, node.height));
            const newNode: CanvasNodeData = {
                id, type: CanvasNodeType.Video, title: `${node.title} ${trimStart.toFixed(2)}-${trimEnd.toFixed(2)}s`,
                position: { x: node.position.x + node.width + 96, y: node.position.y + node.height / 2 - size.height / 2 },
                ...size,
                metadata: { ...videoMetadata(uploaded), sourceVideoId: node.id, sourceVideoTimeMs: Math.round(trimStart * 1000) },
            };
            setNodes((current) => [...current, newNode]);
            // IndexedDB persistence above completes first; disk backup need not block the new canvas node.
            void writeGeneratedBlob(projectId, "video", blob, extension, uploaded.storageKey).catch(() => false);
            setSelectedNodeIds(new Set([id]));
            setSelectedConnectionId(null);
            setTrimNodeId(null);
            message.success("视频片段已添加到原视频右侧");
        } catch (error) {
            message.error(error instanceof Error ? error.message : "截取失败");
        } finally { setTrimming(false); }
    }, [message, projectId, trimDuration, trimEnd, trimNodeId, trimStart, trimming]);

    const captureVideoFrame = useCallback(
        async (node: CanvasNodeData) => {
            const video = document.querySelector<HTMLVideoElement>(`video[data-canvas-video-id="${CSS.escape(node.id)}"]`);
            if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA || !video.videoWidth || !video.videoHeight) {
                message.warning(t("canvas.projectPage.videoFrameUnavailable"));
                return;
            }
            try {
                const frameTime = video.currentTime;
                let sourceVideo = video;
                if (!node.metadata?.storageKey && /^https?:\/\//i.test(node.metadata?.content || "")) {
                    const stored = await uploadMediaFile(node.metadata!.content!, "video");
                    const storedBlob = await getMediaBlob(stored.storageKey);
                    if (storedBlob) await writeGeneratedBlob(projectId, "video", storedBlob, "mp4", stored.storageKey).catch(() => false);
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, ...videoMetadata(stored) } } : item)));
                    sourceVideo = document.createElement("video");
                    sourceVideo.preload = "auto";
                    sourceVideo.muted = true;
                    await new Promise<void>((resolve, reject) => {
                        sourceVideo.onerror = () => reject(new Error("video-load"));
                        sourceVideo.onloadeddata = () => {
                            const targetTime = Number.isFinite(sourceVideo.duration) ? Math.min(frameTime, Math.max(0, sourceVideo.duration - 0.001)) : frameTime;
                            if (targetTime <= 0.001) {
                                resolve();
                                return;
                            }
                            sourceVideo.onseeked = () => resolve();
                            sourceVideo.currentTime = targetTime;
                        };
                        sourceVideo.src = stored.url;
                    });
                }
                const canvas = document.createElement("canvas");
                canvas.width = sourceVideo.videoWidth;
                canvas.height = sourceVideo.videoHeight;
                const context = canvas.getContext("2d");
                if (!context) throw new Error("canvas-context");
                context.drawImage(sourceVideo, 0, 0, canvas.width, canvas.height);
                const blob = await new Promise<Blob>((resolve, reject) => {
                    canvas.toBlob((value) => (value ? resolve(value) : reject(new Error("canvas-blob"))), "image/png");
                });
                const uploaded = await uploadImage(blob);
                await writeGeneratedBlob(projectId, "image", blob, "png", uploaded.storageKey).catch(() => false);
                const size = fitNodeSize(canvas.width, canvas.height, Math.max(node.width, node.height), Math.max(node.width, node.height));
                const id = nanoid();
                const frameNode: CanvasNodeData = {
                    id,
                    type: CanvasNodeType.Image,
                    title: nextMediaNodeTitle(nodesRef.current, CanvasNodeType.Image),
                    position: { x: node.position.x + node.width + 96, y: node.position.y + node.height / 2 - size.height / 2 },
                    ...size,
                    metadata: {
                        ...imageMetadata(uploaded),
                        sourceVideoId: node.id,
                        sourceVideoTimeMs: Math.round(frameTime * 1000),
                    },
                };
                setNodes((prev) => [...prev, frameNode]);
                setSelectedNodeIds(new Set([id]));
                setSelectedConnectionId(null);
                message.success(t("canvas.projectPage.videoFrameCaptured", { width: canvas.width, height: canvas.height }));
            } catch {
                message.error(t("canvas.projectPage.videoFrameFailed"));
            }
        },
        [message, projectId, t],
    );

    const saveNodeAsset = useCallback(
        (node: CanvasNodeData) => {
            if (!node.metadata?.content || (node.type !== CanvasNodeType.Image && node.type !== CanvasNodeType.Video && node.type !== CanvasNodeType.Audio)) return message.error(t("canvas.projectPage.noImageToSave"));
            const common = { title: node.title, assetType: "character" as const, coverUrl: node.type === CanvasNodeType.Image ? node.metadata.content : "", tags: [], source: "Canvas", metadata: { source: "canvas", nodeId: node.id, prompt: node.metadata?.prompt } };
            if (node.type === CanvasNodeType.Image) setNewAssetDraft({ ...common, kind: "image", data: { dataUrl: node.metadata.content, storageKey: node.metadata.storageKey, width: node.metadata.naturalWidth || node.width, height: node.metadata.naturalHeight || node.height, bytes: node.metadata.bytes || 0, mimeType: node.metadata.mimeType || "image/png" } });
            else if (node.type === CanvasNodeType.Video) setNewAssetDraft({ ...common, kind: "video", data: { url: node.metadata.content, storageKey: node.metadata.storageKey, width: node.metadata.naturalWidth || node.width, height: node.metadata.naturalHeight || node.height, bytes: node.metadata.bytes || 0, mimeType: node.metadata.mimeType || "video/mp4" } });
            else setNewAssetDraft({ ...common, kind: "audio", data: { url: node.metadata.content, storageKey: node.metadata.storageKey, durationMs: node.metadata.durationMs, bytes: node.metadata.bytes || 0, mimeType: node.metadata.mimeType || "audio/mpeg" } });
        },
        [message, t],
    );

    const createImageReversePromptNodes = useCallback(
        (node: CanvasNodeData) => {
            if (node.type !== CanvasNodeType.Image || !node.metadata?.content) {
                message.warning(t("canvas.projectPage.emptyReverse"));
                return;
            }

            const gap = 96;
            const textSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
            const configSpec = NODE_DEFAULT_SIZE[CanvasNodeType.Config];
            const centerY = node.position.y + node.height / 2;
            const textNode = {
                ...createCanvasNode(CanvasNodeType.Text, { x: node.position.x + node.width + gap + textSpec.width / 2, y: centerY }, { content: t("canvas.projectPage.reversePreset"), prompt: t("canvas.projectPage.reversePreset"), status: NODE_STATUS_SUCCESS, fontSize: 14 }),
                title: t("canvas.projectPage.reverseTitle"),
            };
            const configNode = {
                ...createCanvasNode(
                    CanvasNodeType.Config,
                    { x: textNode.position.x + textNode.width + gap + configSpec.width / 2, y: centerY },
                    {
                        generationMode: "text",
                        model: effectiveConfig.textModel || effectiveConfig.model || defaultConfig.textModel,
                        count: 1,
                        composerContent: t("canvas.reverseComposer", { imageId: node.id, textId: textNode.id }),
                    },
                ),
                title: t("canvas.projectPage.reverseConfigTitle"),
            };

            setNodes((prev) => [...prev, textNode, configNode]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: configNode.id }, { id: nanoid(), fromNodeId: textNode.id, toNodeId: configNode.id }]);
            setSelectedNodeIds(new Set([configNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(configNode.id);
            setContextMenu(null);
        },
        [effectiveConfig.model, effectiveConfig.textModel, message, t],
    );

    const cropImageNode = useCallback(async (node: CanvasNodeData, crop: CanvasImageCropRect) => {
        if (!node.metadata?.content) return;
        const cropped = await cropDataUrl(node.metadata.content, crop);
        const image = await uploadImage(cropped);
        const width = Math.min(node.width, Math.max(220, image.width));
        const childId = nanoid();
        const child: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Image,
            title: "Cropped Image",
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width,
            height: width * (image.height / image.width),
            metadata: {
                ...imageMetadata(image),
                prompt: node.metadata?.prompt,
            },
        };
        setNodes((prev) => [...prev, child]);
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        setDialogNodeId(childId);
        setCropNodeId(null);
    }, []);

    const splitImageNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageSplitParams) => {
            if (!node.metadata?.content) return;
            setSplitNodeId(null);
            const pieces = await splitDataUrl(node.metadata.content, params);
            const gap = 16;
            const cellWidth = node.width / params.columns;
            const cellHeight = node.height / params.rows;
            const startX = node.position.x + node.width + 96;
            const startY = node.position.y;
            const childNodes = await Promise.all(
                pieces.map(async (piece) => {
                    const image = await uploadImage(piece.dataUrl);
                    const id = nanoid();
                    return {
                        id,
                        type: CanvasNodeType.Image,
                        title: t("canvas.projectPage.splitTitle", { name: node.title || t("assets.kinds.image"), row: piece.row + 1, column: piece.column + 1 }),
                        position: { x: startX + piece.column * (cellWidth + gap), y: startY + piece.row * (cellHeight + gap) },
                        width: cellWidth,
                        height: cellHeight,
                        metadata: {
                            ...imageMetadata(image),
                            prompt: node.metadata?.prompt,
                        },
                    } satisfies CanvasNodeData;
                }),
            );
            setNodes((prev) => [...prev, ...childNodes]);
            setConnections((prev) => [...prev, ...childNodes.map((child) => ({ id: nanoid(), fromNodeId: node.id, toNodeId: child.id }))]);
            setSelectedNodeIds(new Set(childNodes.map((child) => child.id)));
            setSelectedConnectionId(null);
            setDialogNodeId(null);
            message.success(t("canvas.projectPage.splitSuccess", { count: childNodes.length }));
        },
        [message, t],
    );

    const maskEditImageNode = useCallback(
        async (node: CanvasNodeData, payload: CanvasImageMaskEditPayload) => {
            if (!node.metadata?.content) return;
            const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1", size: node.metadata?.size || effectiveConfig.imageSize || "auto" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const userPrompt = payload.prompt.trim();
            const prompt = t("canvas.projectPage.maskPrompt", { prompt: userPrompt });
            const childId = nanoid();
            const source = { id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey };
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, [source]);
            setMaskEditNodeId(null);
            setRunningNodeId(childId);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title: userPrompt.slice(0, 32) || t("canvas.projectPage.maskResult"),
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: node.width,
                    height: node.height,
                    metadata: { prompt, status: NODE_STATUS_LOADING, ...generationMetadata },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setSelectedConnectionId(null);
            setDialogNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                const image = await requestEdit(generationConfig, prompt, [source], { id: `${node.id}-mask`, name: "mask.png", type: "image/png", dataUrl: payload.maskDataUrl }, { signal: controller.signal }).then((items) => items[0]);
                const uploaded = await uploadImage(image.dataUrl);
                const size = fitNodeSize(uploaded.width, uploaded.height, node.width, node.height);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...imageMetadata(uploaded), prompt, ...generationMetadata } } : item)));
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = summarizeApiError(error instanceof Error ? error.message : error, t("canvas.projectPage.maskFailed"));
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, isAiConfigReady, message, openConfigDialog, startGenerationRequest, t],
    );

    const upscaleImageNode = useCallback(async (node: CanvasNodeData, params: CanvasImageUpscaleParams) => {
        if (!node.metadata?.content) return;
        setUpscaleNodeId(null);
        const upscaled = await upscaleDataUrl(node.metadata.content, params);
        const image = await uploadImage(upscaled);
        const size = fitNodeSize(image.width, image.height);
        const childId = nanoid();
        const child: CanvasNodeData = {
            id: childId,
            type: CanvasNodeType.Image,
            title: "Upscaled Image",
            position: { x: node.position.x + node.width + 96, y: node.position.y },
            width: size.width,
            height: size.height,
            metadata: {
                ...imageMetadata(image),
                prompt: node.metadata?.prompt,
            },
        };
        setNodes((prev) => [...prev, child]);
        setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
        setSelectedNodeIds(new Set([childId]));
        setDialogNodeId(childId);
    }, []);

    const generateAngleNode = useCallback(
        async (node: CanvasNodeData, params: CanvasImageAngleParams) => {
            if (!node.metadata?.content) return;
            const generationConfig = { ...buildGenerationConfig(effectiveConfig, node, "image"), count: "1" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }
            const childId = nanoid();
            const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
            const title = buildAngleLabel(params);
            const prompt = buildAnglePrompt(params);
            const generationMetadata = buildImageGenerationMetadata("edit", generationConfig, 1, [
                { id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey },
            ]);
            setAngleNodeId(null);
            setRunningNodeId(childId);
            setNodes((prev) => [
                ...prev,
                {
                    id: childId,
                    type: CanvasNodeType.Image,
                    title,
                    position: { x: node.position.x + node.width + 96, y: node.position.y },
                    width: imageConfig.width,
                    height: imageConfig.height,
                    metadata: { prompt, status: NODE_STATUS_LOADING, ...generationMetadata },
                },
            ]);
            setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: node.id, toNodeId: childId }]);
            setSelectedNodeIds(new Set([childId]));
            setDialogNodeId(childId);
            const controller = startGenerationRequest(childId, node.id, childId);
            try {
                const image = await requestEdit(
                    generationConfig,
                    prompt,
                    [{ id: node.id, name: `${node.title || node.id}.png`, type: node.metadata.mimeType || "image/png", dataUrl: node.metadata.content, storageKey: node.metadata.storageKey }],
                    undefined,
                    { signal: controller.signal },
                ).then((items) => items[0]);
                const uploaded = await uploadImage(image.dataUrl);
                const size = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.width);
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, width: size.width, height: size.height, metadata: { ...item.metadata, ...imageMetadata(uploaded), prompt, ...generationMetadata } } : item)));
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = summarizeApiError(error instanceof Error ? error.message : error, t("canvas.projectPage.generationFailed"));
                setNodes((prev) => prev.map((item) => (item.id === childId ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_ERROR, errorDetails } } : item)));
            } finally {
                finishGenerationRequest(childId, controller);
                setRunningNodeId(null);
            }
        },
        [effectiveConfig, finishGenerationRequest, openConfigDialog, startGenerationRequest, t],
    );

    const handleFontSizeChange = useCallback((nodeId: string, fontSize: number) => {
        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, fontSize } } : node)));
    }, []);

    const handleUploadRequest = useCallback((nodeId?: string, position?: Position) => {
        uploadTargetRef.current = { nodeId, position };
        imageInputRef.current?.click();
    }, []);

    const handleImageInputChange = useCallback(
        async (event: ReactChangeEvent<HTMLInputElement>) => {
            const files = Array.from(event.target.files || []).filter(
                (f) => f.type.startsWith("image/") || f.type.startsWith("video/") || isAudioFile(f),
            );
            if (!files.length) {
                uploadTargetRef.current = null;
                event.target.value = "";
                return;
            }

            const target = uploadTargetRef.current;
            const basePosition =
                target?.position ||
                screenToCanvas(
                    (containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2,
                    (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2,
                );
            const STAGGER = 40; // Offset between multiple imported files.

            // When replacing a target node, use the first file as the replacement and create the rest nearby.
            if (target?.nodeId) {
                const [first, ...rest] = files;

                // Replace the target node with the first file.
                if (isAudioFile(first)) {
                    const audio = await uploadMediaFile(first, "audio");
                    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Audio,
                                      title: first.name,
                                      position: { x: node.position.x + node.width / 2 - spec.width / 2, y: node.position.y + node.height / 2 - spec.height / 2 },
                                      width: spec.width,
                                      height: spec.height,
                                      metadata: { ...node.metadata, ...audioMetadata(audio), errorDetails: undefined },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                } else if (first.type.startsWith("video/")) {
                    const video = await uploadMediaFile(first, "video");
                    const nextSize = fitNodeSize(video.width || 1280, video.height || 720, MEDIA_NODE_LONG_EDGE, MEDIA_NODE_LONG_EDGE);
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Video,
                                      title: first.name,
                                      position: { x: node.position.x + node.width / 2 - nextSize.width / 2, y: node.position.y + node.height / 2 - nextSize.height / 2 },
                                      width: nextSize.width,
                                      height: nextSize.height,
                                      metadata: { ...node.metadata, ...videoMetadata(video), errorDetails: undefined },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                } else {
                    const image = await uploadImage(first);
                    const s = fitNodeSize(image.width, image.height);
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === target.nodeId
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Image,
                                      title: first.name,
                                      width: s.width,
                                      height: s.height,
                                      metadata: {
                                          ...node.metadata,
                                          ...imageMetadata(image),
                                          errorDetails: undefined,
                                          freeResize: false,
                                          images: undefined,
                                          generationType: undefined,
                                          model: undefined,
                                          size: undefined,
                                          quality: undefined,
                                          count: undefined,
                                          references: undefined,
                                          primaryImageId: undefined,
                                      },
                                  }
                                : node,
                        ),
                    );
                    setSelectedNodeIds(new Set([target.nodeId]));
                    setSelectedConnectionId(null);
                }

                // Create the remaining files near the target node.
                for (let i = 0; i < rest.length; i++) {
                    const offsetPos = { x: basePosition.x + (i + 1) * STAGGER, y: basePosition.y + (i + 1) * STAGGER };
                    const f = rest[i];
                    if (isAudioFile(f)) {
                        void createAudioFileNode(f, offsetPos);
                    } else if (f.type.startsWith("video/")) {
                        void createVideoFileNode(f, offsetPos);
                    } else {
                        void createImageFileNode(f, offsetPos);
                    }
                }
            } else {
                // Without a replacement target, create all files near the canvas center.
                for (let i = 0; i < files.length; i++) {
                    const offsetPos = { x: basePosition.x + i * STAGGER, y: basePosition.y + i * STAGGER };
                    const f = files[i];
                    if (isAudioFile(f)) {
                        void createAudioFileNode(f, offsetPos);
                    } else if (f.type.startsWith("video/")) {
                        void createVideoFileNode(f, offsetPos);
                    } else {
                        void createImageFileNode(f, offsetPos);
                    }
                }
            }

            uploadTargetRef.current = null;
            event.target.value = "";
        },
        [createAudioFileNode, createImageFileNode, createVideoFileNode, screenToCanvas, size.height, size.width],
    );

    const handleDrop = useCallback(
        (event: ReactDragEvent<HTMLDivElement>) => {
            event.preventDefault();
            const files = Array.from(event.dataTransfer.files).filter(
                (item) => item.type.startsWith("image/") || item.type.startsWith("video/") || isAudioFile(item),
            );
            if (!files.length) return;

            const basePos = screenToCanvas(event.clientX, event.clientY);
            const STAGGER = 40;
            for (let i = 0; i < files.length; i++) {
                const pos = { x: basePos.x + i * STAGGER, y: basePos.y + i * STAGGER };
                const f = files[i];
                if (isAudioFile(f)) {
                    void createAudioFileNode(f, pos);
                } else if (f.type.startsWith("video/")) {
                    void createVideoFileNode(f, pos);
                } else {
                    void createImageFileNode(f, pos);
                }
            }
        },
        [createAudioFileNode, createImageFileNode, createVideoFileNode, screenToCanvas],
    );

    const startTitleEditing = useCallback(() => {
        setTitleDraft(currentProject?.title || "");
        setTitleEditing(true);
    }, [currentProject?.title, t]);

    const finishTitleEditing = useCallback(() => {
        const nextTitle = titleDraft.trim();
        if (!renameProject(projectId, nextTitle)) message.warning(t("canvas.project.nameExists"));
        setTitleEditing(false);
    }, [message, projectId, renameProject, t, titleDraft]);

    const preventCanvasContextMenu = useCallback((event: ReactMouseEvent) => {
        if ((event.target as HTMLElement).closest("[data-node-id]")) return;
        event.preventDefault();
        setContextMenu(null);
    }, []);

    const handleGenerateNode = useCallback(
        async (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => {
            const sourceNode = nodesRef.current.find((node) => node.id === nodeId);
            const requestedPrompt = sourceNode && isCinePackVideoShotNode(sourceNode) ? fitCinePackVideoPrompt(prompt || sourceNode.metadata?.prompt || "", sourceNode.title) : prompt;
            const referenceIssue = nodeGenerationReferenceIssue(nodeId, nodesRef.current, connectionsRef.current);
            if (referenceIssue) {
                message.error(referenceIssue);
                return;
            }
            const generationConfig = buildGenerationConfig(effectiveConfig, sourceNode, mode);
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }

            // useBuiltinPanel.writeBackToSelf reuses built-in generation while writing the result back to the plugin node.
            // Image mode currently supports display-only nodes such as panoramas, with a useBuiltinPanel.promptPrefix.
            const builtinPanel = sourceNode ? getNodeDefinition(sourceNode.type)?.useBuiltinPanel : undefined;
            if (sourceNode && builtinPanel?.writeBackToSelf && builtinPanel.mode === "image") {
                const scene = prompt.trim();
                if (!scene) return;
                setRunningNodeId(nodeId);
                const controller = startGenerationRequest(nodeId, nodeId, nodeId);
                setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, prompt: scene, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)));
                try {
                    const fullPrompt = (builtinPanel.promptPrefix || "") + scene;
                    // Upstream image nodes become references; without them this is text-to-image.
                    const upstreamNodes = connectionsRef.current
                        .filter((conn) => conn.toNodeId === nodeId)
                        .map((conn) => nodesRef.current.find((node) => node.id === conn.fromNodeId))
                        .filter((node): node is CanvasNodeData => Boolean(node));
                    const refs = upstreamNodes.flatMap((up) =>
                        typeof up.metadata?.content === "string" && up.metadata.content && up.type !== sourceNode.type
                            ? [{ id: up.id, name: `${up.title || up.id}.png`, type: up.metadata.mimeType || "image/png", dataUrl: up.metadata.content, storageKey: up.metadata.storageKey }]
                            : [],
                    );
                    const image = refs.length
                        ? await requestEdit({ ...generationConfig, count: "1" }, fullPrompt, refs, undefined, { signal: controller.signal }).then((items) => items[0])
                        : await requestGeneration({ ...generationConfig, count: "1" }, fullPrompt, { signal: controller.signal }).then((items) => items[0]);
                    const uploaded = await uploadImage(image.dataUrl);
                    setNodes((prev) =>
                        prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, ...imageMetadata(uploaded), prompt: scene, model: generationConfig.model, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : node)),
                    );
                    setDialogNodeId(null);
                } catch (error) {
                    if (!isGenerationCanceled(error)) {
                        const errorDetails = summarizeApiError(error instanceof Error ? error.message : error, t("canvas.projectPage.generationFailed"));
                        message.error(errorDetails);
                        setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } } : node)));
                    }
                } finally {
                    finishGenerationRequest(nodeId, controller);
                }
                return;
            }

            setRunningNodeId(nodeId);
            const runController = startGenerationRequest(nodeId, nodeId, nodeId);
            const sourceTextContent = sourceNode?.type === CanvasNodeType.Text ? sourceNode.metadata?.content?.trim() || "" : "";
            const editingTextNode = mode === "text" && Boolean(sourceTextContent);
            const generationContext = await hydrateNodeGenerationContext(
                buildNodeGenerationContext(nodeId, nodesRef.current, connectionsRef.current, editingTextNode ? t("canvas.projectPage.editTextPrompt", { source: sourceTextContent, prompt: requestedPrompt }) : requestedPrompt),
            );
            const effectivePrompt = generationContext.prompt.trim();
            if (runController.signal.aborted) {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
                return;
            }
            const markSourceStatus = sourceNode?.type !== CanvasNodeType.Image && !editingTextNode;
            if (!effectivePrompt && (mode === "text" || mode === "audio")) {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
                return;
            }
            let pendingChildIds: string[] = [];
            if (markSourceStatus)
                setNodes((prev) =>
                    prev.map((node) =>
                        node.id === nodeId
                            ? {
                                  ...node,
                                  metadata: {
                                      ...node.metadata,
                                      ...(node.type === CanvasNodeType.Config ? {} : { prompt: requestedPrompt }),
                                      ...(isCinePackVideoShotNode(node) ? { composerContent: requestedPrompt } : {}),
                                      status: NODE_STATUS_LOADING,
                                      errorDetails: undefined,
                                  },
                              }
                            : node,
                    ),
                );

            try {
                if (mode === "image") {
                    const count = getGenerationCount(generationConfig.count);
                    const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                    const isImageNode = sourceNode?.type === CanvasNodeType.Image;
                    const regenerateInPlace = isImageNode && Boolean(sourceNode?.metadata?.regenerateInPlace);
                    const isEmptyImageNode = isImageNode && (!sourceNode?.metadata?.content || regenerateInPlace);
                    const referenceImages = imageGenerationReferences(sourceNode, generationContext.referenceImages);
                    const generationType = referenceImages.length ? ("edit" as const) : ("generation" as const);
                    const generationMetadata = buildImageGenerationMetadata(generationType, generationConfig, count, referenceImages);
                    const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : isImageNode ? CanvasNodeType.Image : CanvasNodeType.Text];
                    const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                    const plannedImageSize = nodeSizeFromRatio(generationConfig.size, imageConfig.width, imageConfig.height) || imageConfig;
                    const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                    const rootId = isEmptyImageNode ? nodeId : nanoid();
                    const imageIds = Array.from({ length: count }, () => nanoid());
                    pendingChildIds = [rootId];
                    const rootNode: CanvasNodeData = {
                        id: rootId,
                        type: CanvasNodeType.Image,
                        title: sourceNode?.metadata?.cineflowAgent ? (isEmptyImageNode?sourceNode.title:`${sourceNode.title}｜候选`) : nextMediaNodeTitle(nodesRef.current, CanvasNodeType.Image, isEmptyImageNode ? nodeId : undefined),
                        position: {
                            x: isEmptyImageNode ? parentPosition.x : parentPosition.x + parentConfig.width + 96,
                            y: parentPosition.y + parentConfig.height / 2 - plannedImageSize.height / 2,
                        },
                        width: isEmptyImageNode ? sourceNode?.width || plannedImageSize.width : plannedImageSize.width,
                        height: isEmptyImageNode ? sourceNode?.height || plannedImageSize.height : plannedImageSize.height,
                        metadata: {
                            ...(sourceNode?.metadata?.cineflowAgent ? {cineflowAgent:sourceNode.metadata.cineflowAgent,cineflowOrganization:sourceNode.metadata.cineflowOrganization,groupId:sourceNode.metadata.groupId}:{}),
                            prompt: effectivePrompt,
                            status: NODE_STATUS_LOADING,
                            generationPhase: "resolving",
                            generationDetail: referenceImages.length ? `正在读取 ${referenceImages.length} 张原始参考图（不压缩）` : "正在整理生图参数",
                            generationPhaseStartedAt: Date.now(),
                            generationDurationMs: undefined,
                            images: imageIds.map((id) => ({ id, status: NODE_STATUS_LOADING, content: "", storageKey: "", naturalWidth: 0, naturalHeight: 0, bytes: 0, mimeType: "" })),
                            primaryImageId: undefined,
                            ...generationMetadata,
                            regenerateInPlace: regenerateInPlace || undefined,
                        },
                    };

                    setNodes((prev) => [
                        ...prev.map((node) =>
                            node.id === nodeId
                                ? isConfigNode
                                    ? {
                                          ...node,
                                          metadata: { ...node.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined },
                                      }
                                    : isEmptyImageNode
                                      ? {
                                            ...node,
                                            position: rootNode.position,
                                            width: rootNode.width,
                                            height: rootNode.height,
                                            title: rootNode.title,
                                            metadata: { ...node.metadata, ...rootNode.metadata, errorDetails: undefined },
                                        }
                                      : isImageNode
                                        ? {
                                              ...node,
                                              metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined },
                                          }
                                        : {
                                              ...node,
                                              type: CanvasNodeType.Text,
                                              title: prompt.slice(0, 32) || "Prompt",
                                              width: parentConfig.width,
                                              height: parentConfig.height,
                                              metadata: { ...node.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS, fontSize: 14, errorDetails: undefined },
                                          }
                                : node,
                        ),
                        ...(isEmptyImageNode ? [] : [rootNode]),
                    ]);
                    if (!isEmptyImageNode) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: rootId }]);
                    setSelectedNodeIds(new Set([nodeId]));
                    setSelectedConnectionId(null);
                    setDialogNodeId(nodeId);

                    const controller = rootId === nodeId ? runController : startGenerationRequest(rootId, nodeId, nodeId, runController);
                    let hasSuccess = false;
                    let hasFailure = false;
                    let firstError = "";
                    const nativeBatch = count > 1 && (isChatgpt2ApiUrl(resolveModelRequestConfig(generationConfig, generationConfig.model).baseUrl) || isOfficialOpenAiImageUrl(resolveModelRequestConfig(generationConfig, generationConfig.model).baseUrl));
                    const nativeBatchPrompt = `${effectivePrompt}\n\n请返回 ${count} 张独立图片文件。如果上文列出 ${count} 个角度或子任务，按列出顺序逐张完成；所有图片共享原文要求的场景、主体、参考图一致性与画幅。不要拼成一张多宫格图片。`;
                    let batchRequest: ReturnType<typeof requestGeneration> | undefined;
                    await Promise.all(
                        imageIds.map(async (imageId, imageIndex) => {
                            const imageStartedAt = Date.now();
                            const batchPrompt = nativeBatch ? nativeBatchPrompt : buildBatchImagePrompt(effectivePrompt, imageIndex, count);
                            let jobId = "";
                            try {
                                const job = await beginCanvasGenerationJob({
                                    projectId,
                                    nodeId: rootId,
                                    imageId,
                                    kind: "image",
                                    prompt: batchPrompt,
                                    model: generationConfig.model,
                                });
                                jobId = job.id;
                                setNodes((prev) => patchNodeGenerationUi(prev, rootId, { phase: "submitting", detail: "正在提交生图请求", clearProgress: true }));
                                setNodes((prev) => prev.map((node) => (node.id === rootId ? { ...node, metadata: { ...node.metadata, generationJobId: job.id } } : node)));
                                void useCanvasStore.getState().flushPersist();
                                let remoteTaskId = "";
                                let remoteProviderLabel = "APIMart";
                                const onRemoteTask = async (task: ImageGenerationTask) => {
                                    remoteTaskId = task.id;
                                    remoteProviderLabel = task.provider === "comfyui" ? "ComfyUI" : "APIMart";
                                    await attachRemoteTaskToJob(job.id, task);
                                    await commitCanvasNodes((prev) => patchNodeGenerationUi(prev, rootId, { phase: "queued", detail: `${remoteProviderLabel} 已接单 · ${task.id.slice(-8)}`, clearProgress: true }));
                                };
                                const onTaskState = ({ stage, progress, attempt }: { stage: "queued" | "generating" | "downloading"; progress?: number; attempt?: number }) => {
                                    const detail = stage === "downloading" ? "图片已生成，正在下载结果" : `${remoteProviderLabel} ${stage === "queued" ? "排队中" : "正在生成"}${remoteTaskId ? ` · ${remoteTaskId.slice(-8)}` : ""}${attempt ? ` · 第 ${attempt} 次查询` : ""}`;
                                    setNodes((prev) => patchNodeGenerationUi(prev, rootId, { phase: stage, detail, progress, clearProgress: typeof progress !== "number" }));
                                };
                                let image;
                                if (nativeBatch) {
                                    batchRequest ||= referenceImages.length
                                        ? requestEdit({ ...generationConfig, count: String(count) }, batchPrompt, referenceImages, undefined, { signal: controller.signal, onRemoteTask, onTaskState })
                                        : requestGeneration({ ...generationConfig, count: String(count) }, batchPrompt, { signal: controller.signal, onRemoteTask, onTaskState });
                                    const results = await batchRequest;
                                    image = results.some((item) => "batchIndex" in item)
                                        ? results.find((item) => "batchIndex" in item && item.batchIndex === imageIndex)
                                        : results[imageIndex];
                                    if (!image) throw new Error(`渠道本次未返回第 ${imageIndex + 1} 张图片（请求 ${count} 张）；已返回的结果会保留。`);
                                } else {
                                    image = referenceImages.length
                                        ? await requestEdit({ ...generationConfig, count: "1" }, batchPrompt, referenceImages, undefined, { signal: controller.signal, onRemoteTask, onTaskState }).then((items) => items[0])
                                        : await requestGeneration({ ...generationConfig, count: "1" }, batchPrompt, { signal: controller.signal, onRemoteTask, onTaskState }).then((items) => items[0]);
                                }
                                setNodes((prev) => patchNodeGenerationUi(prev, rootId, { phase: "saving", detail: "正在保存图片到画布与本地目录", progress: 100 }));
                                const uploaded = await uploadImage(image.dataUrl);
                                const blob = uploaded.storageKey ? await getImageBlob(uploaded.storageKey).catch(() => null) : null;
                                if (blob) await writeGeneratedBlob(projectId, "image", blob, "png", uploaded.storageKey).catch(() => false);
                                await patchGenerationJob(job.id, { status: "done", resultUrls: "sourceUrl" in image && typeof image.sourceUrl === "string" ? [image.sourceUrl] : undefined });
                                const imageSize = fitNodeSize(uploaded.width, uploaded.height, imageConfig.width, imageConfig.width);
                                const generationDurationMs = Date.now() - imageStartedAt;
                                const item: CanvasNodeImage = { id: imageId, status: NODE_STATUS_SUCCESS, content: uploaded.url, storageKey: uploaded.storageKey, naturalWidth: uploaded.width, naturalHeight: uploaded.height, bytes: uploaded.bytes, mimeType: uploaded.mimeType, generationDurationMs };
                                setNodes((prev) =>
                                    prev.map((node) => {
                                        if (node.id !== rootId) return node;
                                        const images = node.metadata?.images?.map((image) => (image.id === imageId ? item : image)) || [];
                                        if (node.metadata?.primaryImageId) return { ...node, metadata: { ...node.metadata, images } };
                                        const center = { x: node.position.x + node.width / 2, y: node.position.y + node.height / 2 };
                                        return {
                                            ...node,
                                            position: { x: center.x - imageSize.width / 2, y: center.y - imageSize.height / 2 },
                                            ...imageSize,
                                            metadata: {
                                                ...node.metadata,
                                                content: item.content,
                                                storageKey: item.storageKey,
                                                naturalWidth: item.naturalWidth,
                                                naturalHeight: item.naturalHeight,
                                                bytes: item.bytes,
                                                mimeType: item.mimeType,
                                                images,
                                                primaryImageId: imageId,
                                                generationDurationMs,
                                                regenerateInPlace: undefined,
                                            },
                                        };
                                    }),
                                );
                                hasSuccess = true;
                                notifyGenerationSuccess(rootId);
                                if (isConfigNode) setNodes((prev) => prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS, errorDetails: undefined } } : node)));
                                return true;
                            } catch (error) {
                                if (jobId) void patchGenerationJob(jobId, { status: isGenerationCanceled(error) ? "stopped" : "failed", error: error instanceof Error ? error.message : "failed" });
                                if (isGenerationCanceled(error)) return false;
                                const errorDetails = summarizeApiError(error instanceof Error ? error.message : error, t("canvas.projectPage.generationFailed"));
                                if (!firstError) firstError = errorDetails;
                                hasFailure = true;
                                setNodes((prev) => prev.map((node) => (node.id === rootId ? { ...node, metadata: { ...node.metadata, images: node.metadata?.images?.map((image) => (image.id === imageId ? { ...image, status: NODE_STATUS_ERROR, errorDetails } : image)) } } : node)));
                            }
                            return false;
                        }),
                    );
                    if (rootId !== nodeId) finishGenerationRequest(rootId, controller);
                    if (controller.signal.aborted) {
                        setNodes((prev) => prev.map((node) => (node.id === nodeId && isConfigNode && node.metadata?.status === NODE_STATUS_LOADING ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_IDLE, errorDetails: undefined } } : node)));
                        return;
                    }
                    if (hasFailure) {
                        message.error(hasSuccess ? t("canvas.projectPage.partialFailed") : firstError || t("canvas.projectPage.generationFailed"));
                    }
                    setNodes((prev) =>
                        prev.map((node) =>
                            node.id === nodeId && isConfigNode
                                ? { ...node, metadata: { ...node.metadata, status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: hasSuccess ? undefined : t("canvas.projectPage.generationFailed") } }
                                : node.id === rootId
                                  ? { ...node, metadata: { ...node.metadata, status: hasSuccess ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: hasSuccess ? undefined : firstError || t("canvas.projectPage.allFailed"), generationJobId: undefined, generationFailedPhase: hasSuccess ? undefined : node.metadata?.generationPhase, generationPhase: undefined, generationDetail: hasSuccess ? undefined : node.metadata?.generationDetail, generationPhaseStartedAt: undefined, generationProgress: undefined } }
                                    : node,
                        ),
                    );
                    return;
                }

                if (mode === "video") {
                    const spec = nodeSizeFromRatio(generationConfig.size, NODE_DEFAULT_SIZE[CanvasNodeType.Video].width, NODE_DEFAULT_SIZE[CanvasNodeType.Video].height) || NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                    const isEmptyVideoNode = sourceNode?.type === CanvasNodeType.Video && !sourceNode.metadata?.content;
                    const videoId = isEmptyVideoNode ? nodeId : nanoid();
                    const parent = sourceNode?.position || { x: 0, y: 0 };
                    const videoNode: CanvasNodeData = {
                        id: videoId,
                        type: CanvasNodeType.Video,
                        title: sourceNode?.metadata?.cineflowAgent ? (isEmptyVideoNode?sourceNode.title:`${sourceNode.title}｜候选`) : isEmptyVideoNode && sourceNode && (isCinePackVideoShotNode(sourceNode) || sourceNode.metadata?.cineflowHandoff) ? sourceNode.title : nextMediaNodeTitle(nodesRef.current, CanvasNodeType.Video, isEmptyVideoNode ? nodeId : undefined),
                        position: isEmptyVideoNode ? sourceNode.position : { x: parent.x + (sourceNode?.width || spec.width) + 96, y: parent.y },
                        width: isEmptyVideoNode ? sourceNode.width : spec.width,
                        height: isEmptyVideoNode ? sourceNode.height : spec.height,
                        metadata: {
                            ...(isEmptyVideoNode ? sourceNode.metadata : {}),
                            ...(sourceNode?.metadata?.cineflowAgent ? {cineflowAgent:sourceNode.metadata.cineflowAgent,cineflowOrganization:sourceNode.metadata.cineflowOrganization,groupId:sourceNode.metadata.groupId}:{}),
                            ...(sourceNode?.type === CanvasNodeType.Video && !isEmptyVideoNode ? { videoOrganization: inheritVideoOrganization(sourceNode, nodesRef.current), groupId: sourceNode.metadata?.groupId } : {}),
                            prompt: effectivePrompt,
                            ...(sourceNode && isCinePackVideoShotNode(sourceNode) ? { composerContent: effectivePrompt } : {}),
                            status: NODE_STATUS_LOADING,
                            generationPhase: "packing",
                            model: generationConfig.model,
                            size: generationConfig.size,
                            seconds: generationConfig.videoSeconds,
                            vquality: generationConfig.vquality,
                            generateAudio: generationConfig.videoGenerateAudio,
                            watermark: generationConfig.videoWatermark,
                            references: generationReferenceUrls(generationContext),
                        },
                    };
                    pendingChildIds = [videoId];
                    setNodes((prev) =>
                        isEmptyVideoNode
                            ? prev.map((node) => (node.id === nodeId ? { ...node, ...videoNode } : node))
                            : [...prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), videoNode],
                    );
                    if (!isEmptyVideoNode) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: videoId }]);
                    const controller = startGenerationRequest(videoId, nodeId, nodeId, runController);
                    try {
                        const job = await beginCanvasGenerationJob({
                            projectId,
                            nodeId: videoId,
                            kind: "video",
                            prompt: effectivePrompt,
                            model: generationConfig.model,
                        });
                        setNodes((prev) => prev.map((node) => (node.id === videoId ? { ...node, metadata: { ...node.metadata, generationJobId: job.id, generationPhase: "packing" } } : node)));
                        void useCanvasStore.getState().flushPersist();
                        const task = await createVideoGenerationTask(generationConfig, effectivePrompt, generationContext.referenceImages, generationContext.referenceVideos, generationContext.referenceAudios, {
                            signal: controller.signal,
                            strictReferenceCount: Boolean(sourceNode && (isCinePackVideoShotNode(sourceNode) || sourceNode.metadata?.cineflowHandoff || sourceNode.metadata?.cineflowAgent)),
                            onRemoteTask: async (remoteTask) => {
                                await attachRemoteTaskToJob(job.id, remoteTask);
                                setNodes((prev) => patchNodeGenerationUi(prev, videoId, { phase: "generating" }));
                                void useCanvasStore.getState().flushPersist();
                            },
                        });
                        setNodes((prev) => prev.map((node) => (node.id === videoId ? { ...node, metadata: { ...node.metadata, generationJobId: job.id, generationPhase: "generating" } } : node)));
                        void useCanvasStore.getState().flushPersist();
                        let video: Awaited<ReturnType<typeof storeGeneratedVideo>> | undefined;
                        for (;;) {
                            if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
                            const state = await pollVideoGenerationTask(generationConfig, task, { signal: controller.signal });
                            if (state.status === "completed") {
                                const stored = await storeGeneratedVideo(state.result);
                                if (stored.storageKey) {
                                    video = stored;
                                    break;
                                }
                            }
                            if (state.status === "failed") {
                                await patchGenerationJob(job.id, { status: "failed", error: state.error });
                                throw new Error(state.error);
                            }
                            if (state.status === "pending" && typeof state.progress === "number") setNodes((prev) => patchNodeGenerationUi(prev, videoId, { phase: "generating", progress: state.progress }));
                            await new Promise<void>((resolve, reject) => {
                                const timer = window.setTimeout(resolve, task.provider === "seedance" || task.provider === "feimiao" ? 5000 : 2500);
                                controller.signal.addEventListener(
                                    "abort",
                                    () => {
                                        window.clearTimeout(timer);
                                        reject(new DOMException("Aborted", "AbortError"));
                                    },
                                    { once: true },
                                );
                            });
                        }
                        if (!video) throw new Error(t("canvas.projectPage.generationFailed"));
                        const blob = video.storageKey ? await getMediaBlob(video.storageKey).catch(() => null) : null;
                        if (!blob) throw new Error(t("canvas.projectPage.generationFailed"));
                        await writeGeneratedBlob(projectId, "video", blob, "mp4", video.storageKey).catch(() => false);
                        const videoSize = fitNodeSize(video.width || spec.width, video.height || spec.height, MEDIA_NODE_LONG_EDGE, MEDIA_NODE_LONG_EDGE);
                        await commitCanvasNodes((prev) =>
                            prev.map((node) =>
                                node.id === videoId
                                    ? {
                                          ...node,
                                          width: videoSize.width,
                                          height: videoSize.height,
                                          position: { x: node.position.x + node.width / 2 - videoSize.width / 2, y: node.position.y + node.height / 2 - videoSize.height / 2 },
                                          metadata: {
                                              ...node.metadata,
                                              ...videoMetadata(video),
                                              prompt: effectivePrompt,
                                              model: generationConfig.model,
                                              size: generationConfig.size,
                                              seconds: generationConfig.videoSeconds,
                                              vquality: generationConfig.vquality,
                                              generateAudio: generationConfig.videoGenerateAudio,
                                              watermark: generationConfig.videoWatermark,
                                              references: generationReferenceUrls(generationContext),
                                              generationJobId: undefined,
                                              generationPhase: undefined,
                                              generationProgress: undefined,
                                              generationDurationMs: Date.now() - job.createdAt,
                                          },
                                      }
                                    : node,
                            ),
                        );
                        await patchGenerationJob(job.id, { status: "done" });
                        notifyGenerationSuccess(videoId);
                    } finally {
                        finishGenerationRequest(videoId, controller);
                    }
                    return;
                }

                if (mode === "audio") {
                    const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Audio];
                    const isEmptyAudioNode = sourceNode?.type === CanvasNodeType.Audio && !sourceNode.metadata?.content;
                    const audioId = isEmptyAudioNode ? nodeId : nanoid();
                    const parent = sourceNode?.position || { x: 0, y: 0 };
                    const audioNode: CanvasNodeData = {
                        id: audioId,
                        type: CanvasNodeType.Audio,
                        title: effectivePrompt.slice(0, 32) || "Generated Audio",
                        position: isEmptyAudioNode ? sourceNode.position : { x: parent.x + (sourceNode?.width || spec.width) + 96, y: parent.y + ((sourceNode?.height || spec.height) - spec.height) / 2 },
                        width: isEmptyAudioNode ? sourceNode.width : spec.width,
                        height: isEmptyAudioNode ? sourceNode.height : spec.height,
                        metadata: { prompt: effectivePrompt, status: NODE_STATUS_LOADING, ...buildAudioGenerationMetadata(generationConfig) },
                    };
                    pendingChildIds = [audioId];
                    setNodes((prev) =>
                        isEmptyAudioNode
                            ? prev.map((node) => (node.id === nodeId ? { ...node, ...audioNode } : node))
                            : [...prev.map((node) => (node.id === nodeId ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } } : node)), audioNode],
                    );
                    if (!isEmptyAudioNode) setConnections((prev) => [...prev, { id: nanoid(), fromNodeId: nodeId, toNodeId: audioId }]);
                    const controller = startGenerationRequest(audioId, nodeId, nodeId, runController);
                    try {
                        const audioStartedAt = Date.now();
                        const audio = await storeGeneratedAudio(await requestAudioGeneration(generationConfig, effectivePrompt, { signal: controller.signal }), generationConfig.audioFormat);
                        const audioBlob = audio.storageKey ? await getMediaBlob(audio.storageKey).catch(() => null) : null;
                        if (audioBlob) await writeGeneratedBlob(projectId, "audio", audioBlob, audioExtension(audio.mimeType), audio.storageKey).catch(() => false);
                        setNodes((prev) => prev.map((node) => (node.id === audioId ? { ...node, metadata: { ...node.metadata, ...audioMetadata(audio), prompt: effectivePrompt, ...buildAudioGenerationMetadata(generationConfig), generationDurationMs: Date.now() - audioStartedAt } } : node)));
                    } finally {
                        finishGenerationRequest(audioId, controller);
                    }
                    return;
                }

                let streamed = "";
                const isConfigNode = sourceNode?.type === CanvasNodeType.Config;
                const textCount = isConfigNode ? getGenerationCount(generationConfig.count) : 1;
                const parentConfig = NODE_DEFAULT_SIZE[isConfigNode ? CanvasNodeType.Config : CanvasNodeType.Text];
                const textConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Text];
                const parentPosition = sourceNode?.position || { x: 0, y: 0 };
                const childIds = isConfigNode || editingTextNode ? Array.from({ length: textCount }, () => nanoid()) : [];
                pendingChildIds = childIds;
                if (isConfigNode || editingTextNode) {
                    const childNodes: CanvasNodeData[] = childIds.map((id, index) => ({
                        id,
                        type: CanvasNodeType.Text,
                        title: effectivePrompt.slice(0, 32) || "Generated Text",
                        position: {
                            x: parentPosition.x + parentConfig.width + 96,
                            y: parentPosition.y + parentConfig.height / 2 - textConfig.height / 2 + (index - (textCount - 1) / 2) * (textConfig.height + 36),
                        },
                        width: textConfig.width,
                        height: textConfig.height,
                        metadata: { prompt: effectivePrompt, status: NODE_STATUS_LOADING, fontSize: 14, model: generationConfig.model, reasoningEffort: generationConfig.reasoningEffort },
                    }));
                    setNodes((prev) => [...prev.map((node) => (node.id === nodeId && isConfigNode ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined } } : node)), ...childNodes]);
                    setConnections((prev) => [...prev, ...childIds.map((childId) => ({ id: nanoid(), fromNodeId: nodeId, toNodeId: childId }))]);
                }

                const controller = runController;
                const textTargetIds = childIds.length ? childIds : [nodeId];
                textTargetIds.forEach((targetNodeId) => startGenerationRequest(targetNodeId, nodeId, nodeId, controller));
                const answers = await Promise.all(
                    textTargetIds.map((targetNodeId) => {
                        let localStreamed = "";
                        return requestImageQuestion(
                            generationConfig,
                            buildNodeResponseMessages({ ...generationContext, prompt: effectivePrompt }),
                            (text) => {
                                localStreamed = text;
                                streamed = text;
                                if (isConfigNode) return;
                                setNodes((prev) => prev.map((node) => (node.id === targetNodeId ? { ...node, type: CanvasNodeType.Text, metadata: { ...node.metadata, content: text, status: NODE_STATUS_LOADING } } : node)));
                            },
                            { signal: controller.signal },
                        )
                            .then((answer) => ({ nodeId: targetNodeId, content: answer || localStreamed }))
                            .finally(() => finishGenerationRequest(targetNodeId, controller));
                    }),
                );
                if (controller.signal.aborted) return;
                const answerByNodeId = new Map(answers.map((item) => [item.nodeId, item.content]));
                setNodes((prev) =>
                    prev.map((node) =>
                        childIds.includes(node.id)
                            ? { ...node, metadata: { ...node.metadata, content: answerByNodeId.get(node.id) || streamed, status: NODE_STATUS_SUCCESS } }
                            : node.id === nodeId && isConfigNode
                              ? { ...node, metadata: { ...node.metadata, status: NODE_STATUS_SUCCESS } }
                              : node.id === nodeId && !editingTextNode
                                ? {
                                      ...node,
                                      type: CanvasNodeType.Text,
                                      title: prompt.slice(0, 32) || "Generated Text",
                                      metadata: { ...node.metadata, content: answerByNodeId.get(node.id) || streamed, model: generationConfig.model, reasoningEffort: generationConfig.reasoningEffort, status: NODE_STATUS_SUCCESS },
                                  }
                                : node,
                    ),
                );
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = summarizeApiError(error instanceof Error ? error.message : error, t("canvas.projectPage.generationFailed"));
                message.error(errorDetails);
                setNodes((prev) =>
                    prev.map((node) => (node.id === nodeId || pendingChildIds.includes(node.id) ? (node.id === nodeId && !markSourceStatus ? node : { ...node, metadata: { ...node.metadata, status: NODE_STATUS_ERROR, errorDetails } }) : node)),
                );
            } finally {
                finishGenerationRequest(nodeId, runController);
                setRunningNodeId(null);
            }
        },
        [projectId, commitCanvasNodes, effectiveConfig, finishGenerationRequest, isAiConfigReady, message, notifyGenerationSuccess, openConfigDialog, startGenerationRequest, t],
    );
    useEffect(() => {
        generateNodeRef.current = handleGenerateNode;
    }, [handleGenerateNode]);

    const handleGenerateCopyNode = useCallback(
        (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => {
            const source = nodesRef.current.find((node) => node.id === nodeId);
            if (!source) return;

            // 1. 复制节点（保留提示词和引用，清空资产和生成状态）
            const newId = `${source.type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const newMetadata = stripMetadataForNodeCopy(source.metadata);
            const newNode: CanvasNodeData = {
                ...source,
                id: newId,
                title: source.title,
                position: { x: source.position.x + 36, y: source.position.y + 36 },
                metadata: newMetadata,
            };

            // 2. 复制原节点的连线关系（引用其他节点的关系）
            const newConnections = connectionsRef.current
                .filter((conn) => conn.fromNodeId === nodeId || conn.toNodeId === nodeId)
                .map((conn) => ({
                    ...conn,
                    id: `conn-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
                    fromNodeId: conn.fromNodeId === nodeId ? newId : conn.fromNodeId,
                    toNodeId: conn.toNodeId === nodeId ? newId : conn.toNodeId,
                }));

            // 3. 直接更新 refs 和 state，确保后续生成逻辑能获取到新节点
            nodesRef.current = [...nodesRef.current, newNode];
            connectionsRef.current = [...connectionsRef.current, ...newConnections];
            setNodes(nodesRef.current);
            setConnections(connectionsRef.current);
            setSelectedNodeIds(new Set([newId]));
            setSelectedConnectionId(null);

            // 4. 在新节点上触发生成（不建立老节点到新节点的连线）
            setTimeout(() => {
                handleGenerateNode(newId, mode, prompt);
            }, 100);
        },
        [handleGenerateNode],
    );

    const handleRetryNode = useCallback(
        async (node: CanvasNodeData, imageId?: string) => {
            const sourceNode = findRetrySourceNode(node.id, nodesRef.current, connectionsRef.current) || node;
            const referenceIssue = nodeGenerationReferenceIssue(sourceNode.id, nodesRef.current, connectionsRef.current);
            if (referenceIssue) {
                message.error(referenceIssue);
                return;
            }
            const savedImageMetadata = node.type === CanvasNodeType.Image ? node.metadata : undefined;
            const hasSavedImageMetadata = Boolean(savedImageMetadata?.generationType);
            const generationConfig =
                hasSavedImageMetadata && savedImageMetadata
                    ? {
                          ...effectiveConfig,
                          model: savedImageMetadata.model || effectiveConfig.imageModel || effectiveConfig.model,
                          quality: savedImageMetadata.quality || effectiveConfig.quality,
                          size: savedImageMetadata.size || effectiveConfig.imageSize,
                          background: savedImageMetadata.background ?? effectiveConfig.background,
                          count: "1",
                      }
                    : { ...buildGenerationConfig(effectiveConfig, sourceNode, node.type === CanvasNodeType.Text ? "text" : node.type === CanvasNodeType.Video ? "video" : node.type === CanvasNodeType.Audio ? "audio" : "image"), count: "1" };
            if (!isAiConfigReady(generationConfig, generationConfig.model)) {
                openConfigDialog(true);
                return;
            }

            const context = hasSavedImageMetadata ? null : await hydrateNodeGenerationContext(buildNodeGenerationContext(sourceNode.id, nodesRef.current, connectionsRef.current, sourceNode.metadata?.prompt || node.metadata?.prompt || ""));
            const prompt = (savedImageMetadata?.prompt || context?.prompt || "").trim();
            if (!prompt) {
                message.warning(t("canvas.projectPage.retryPromptMissing"));
                return;
            }
            const generationType = savedImageMetadata?.generationType;
            const useReferenceImages = generationType ? generationType === "edit" : Boolean(context?.referenceImages.length);
            const retryReferenceImages =
                hasSavedImageMetadata && savedImageMetadata ? await resolveMetadataReferences(savedImageMetadata) : useReferenceImages ? (context?.referenceImages.length ? context.referenceImages : sourceNodeReferenceImages(sourceNode)) : [];
            if (useReferenceImages && !retryReferenceImages) {
                message.error(t("canvas.projectPage.referenceMissing"));
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: item.metadata?.content ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: item.metadata?.content ? undefined : t("canvas.projectPage.referenceMissing"), images: item.metadata?.images?.map((image) => (image.id === imageId ? { ...image, status: NODE_STATUS_ERROR, errorDetails: t("canvas.projectPage.referenceMissing") } : image)) } } : item)));
                return;
            }
            const retryImages = retryReferenceImages || [];

            const generationStartedAt = Date.now();
            setRunningNodeId(node.id);
            if (node.type === CanvasNodeType.Video && node.metadata?.storageKey) {
                const previousOrganization = currentVideoOrganization(node, nodesRef.current);
                setNodes(prev => prev.map(item => item.id === node.id ? { ...item, metadata: { ...item.metadata, videoOrganization: previousOrganization } } : item));
            }
            setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: NODE_STATUS_LOADING, errorDetails: undefined, generationPhase: node.type === CanvasNodeType.Image ? "resolving" : "packing", generationDetail: node.type === CanvasNodeType.Image ? (retryImages.length ? `正在读取 ${retryImages.length} 张原始参考图（不压缩）` : "正在整理生图参数") : undefined, generationPhaseStartedAt: Date.now(), generationProgress: undefined, generationDurationMs: undefined, images: item.metadata?.images?.map((image) => (image.id === imageId ? { ...image, status: NODE_STATUS_LOADING, errorDetails: undefined } : image)) } } : item)));
            const controller = startGenerationRequest(node.id, sourceNode.id, node.id);

            try {
                if (node.type === CanvasNodeType.Text) {
                    if (!context) return;
                    let streamed = "";
                    const answer = await requestImageQuestion(
                        generationConfig,
                        buildNodeResponseMessages({ ...context, prompt }),
                        (text) => {
                            streamed = text;
                            setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: text, status: NODE_STATUS_LOADING } } : item)));
                        },
                        { signal: controller.signal },
                    );
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, type: CanvasNodeType.Text, metadata: { ...item.metadata, content: answer || streamed, prompt, status: NODE_STATUS_SUCCESS } } : item)));
                    return;
                }
                if (node.type === CanvasNodeType.Video) {
                    const job = await beginCanvasGenerationJob({ projectId, nodeId: node.id, kind: "video", prompt, model: generationConfig.model });
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, generationJobId: job.id, generationPhase: "packing" } } : item)));
                    void useCanvasStore.getState().flushPersist();
                    const task = await createVideoGenerationTask(generationConfig, prompt, retryImages, context?.referenceVideos || [], context?.referenceAudios || [], {
                        signal: controller.signal,
                        strictReferenceCount: Boolean(isCinePackVideoShotNode(sourceNode) || sourceNode.metadata?.cineflowAgent || sourceNode.metadata?.cineflowHandoff),
                        onRemoteTask: async (remoteTask) => {
                            await attachRemoteTaskToJob(job.id, remoteTask);
                            setNodes((prev) => patchNodeGenerationUi(prev, node.id, { phase: "generating" }));
                            void useCanvasStore.getState().flushPersist();
                        },
                    });
                    setNodes((prev) => patchNodeGenerationUi(prev, node.id, { phase: "generating" }));
                    void useCanvasStore.getState().flushPersist();
                    let video: Awaited<ReturnType<typeof storeGeneratedVideo>> | undefined;
                    for (;;) {
                        if (controller.signal.aborted) throw new DOMException("Aborted", "AbortError");
                        const state = await pollVideoGenerationTask(generationConfig, task, { signal: controller.signal });
                        if (state.status === "completed") {
                            const stored = await storeGeneratedVideo(state.result);
                            if (stored.storageKey) {
                                video = stored;
                                break;
                            }
                        }
                        if (state.status === "failed") {
                            await patchGenerationJob(job.id, { status: "failed", error: state.error });
                            throw new Error(state.error);
                        }
                        if (state.status === "pending" && typeof state.progress === "number") setNodes((prev) => patchNodeGenerationUi(prev, node.id, { phase: "generating", progress: state.progress }));
                        await new Promise<void>((resolve) => window.setTimeout(resolve, task.provider === "seedance" || task.provider === "feimiao" ? 5000 : 2500));
                    }
                    if (!video) throw new Error(t("canvas.projectPage.generationFailed"));
                    const blob = video.storageKey ? await getMediaBlob(video.storageKey).catch(() => null) : null;
                    if (!blob) throw new Error(t("canvas.projectPage.generationFailed"));
                    await writeGeneratedBlob(projectId, "video", blob, "mp4", video.storageKey).catch(() => false);
                    const videoSize = fitNodeSize(video.width || node.width, video.height || node.height, MEDIA_NODE_LONG_EDGE, MEDIA_NODE_LONG_EDGE);
                    await commitCanvasNodes((prev) =>
                        preservePreviousVideo(prev, node, video.storageKey).map((item) =>
                            item.id === node.id
                                ? {
                                      ...item,
                                      width: videoSize.width,
                                      height: videoSize.height,
                                      position: { x: item.position.x + item.width / 2 - videoSize.width / 2, y: item.position.y + item.height / 2 - videoSize.height / 2 },
                                      metadata: {
                                          ...item.metadata,
                                          ...videoMetadata(video),
                                          videoOrganization: inheritVideoOrganization(node, prev, generationStartedAt),
                                          prompt,
                                          model: generationConfig.model,
                                          size: generationConfig.size,
                                          seconds: generationConfig.videoSeconds,
                                          vquality: generationConfig.vquality,
                                          generateAudio: generationConfig.videoGenerateAudio,
                                          watermark: generationConfig.videoWatermark,
                                          generationJobId: undefined,
                                          generationPhase: undefined,
                                          generationProgress: undefined,
                                          generationDurationMs: Date.now() - generationStartedAt,
                                      },
                                  }
                                : item,
                        ),
                    );
                    await patchGenerationJob(job.id, { status: "done" });
                    notifyGenerationSuccess(node.id);
                    return;
                }
                if (node.type === CanvasNodeType.Audio) {
                    const audio = await storeGeneratedAudio(await requestAudioGeneration(generationConfig, prompt, { signal: controller.signal }), generationConfig.audioFormat);
                    const audioBlob = audio.storageKey ? await getMediaBlob(audio.storageKey).catch(() => null) : null;
                    if (audioBlob) await writeGeneratedBlob(projectId, "audio", audioBlob, audioExtension(audio.mimeType), audio.storageKey).catch(() => false);
                    setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, ...audioMetadata(audio), prompt, ...buildAudioGenerationMetadata(generationConfig), generationDurationMs: Date.now() - generationStartedAt } } : item)));
                    return;
                }

                const retryImageId = imageId || node.metadata?.primaryImageId || nanoid();
                const job = await beginCanvasGenerationJob({ projectId, nodeId: node.id, imageId: retryImageId, kind: "image", prompt, model: generationConfig.model });
                setNodes((prev) => patchNodeGenerationUi(prev, node.id, { phase: "submitting", detail: "正在提交生图请求", clearProgress: true }));
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, generationJobId: job.id } } : item)));
                void useCanvasStore.getState().flushPersist();
                let remoteTaskId = "";
                let remoteProviderLabel = "APIMart";
                const onRemoteTask = async (task: ImageGenerationTask) => {
                    remoteTaskId = task.id;
                    remoteProviderLabel = task.provider === "comfyui" ? "ComfyUI" : "APIMart";
                    await attachRemoteTaskToJob(job.id, task);
                    await commitCanvasNodes((prev) => patchNodeGenerationUi(prev, node.id, { phase: "queued", detail: `${remoteProviderLabel} 已接单 · ${task.id.slice(-8)}`, clearProgress: true }));
                };
                const onTaskState = ({ stage, progress, attempt }: { stage: "queued" | "generating" | "downloading"; progress?: number; attempt?: number }) => {
                    const detail = stage === "downloading" ? "图片已生成，正在下载结果" : `${remoteProviderLabel} ${stage === "queued" ? "排队中" : "正在生成"}${remoteTaskId ? ` · ${remoteTaskId.slice(-8)}` : ""}${attempt ? ` · 第 ${attempt} 次查询` : ""}`;
                    setNodes((prev) => patchNodeGenerationUi(prev, node.id, { phase: stage, detail, progress, clearProgress: typeof progress !== "number" }));
                };
                const image = useReferenceImages
                    ? await requestEdit(generationConfig, prompt, retryImages, undefined, { signal: controller.signal, onRemoteTask, onTaskState }).then((items) => items[0])
                    : await requestGeneration(generationConfig, prompt, { signal: controller.signal, onRemoteTask, onTaskState }).then((items) => items[0]);
                setNodes((prev) => patchNodeGenerationUi(prev, node.id, { phase: "saving", detail: "正在保存图片到画布与本地目录", progress: 100 }));
                const uploadedImage = await uploadImage(image.dataUrl);
                const imageBlob = uploadedImage.storageKey ? await getImageBlob(uploadedImage.storageKey).catch(() => null) : null;
                if (imageBlob) await writeGeneratedBlob(projectId, "image", imageBlob, "png", uploadedImage.storageKey).catch(() => false);
                await patchGenerationJob(job.id, { status: "done", resultUrls: "sourceUrl" in image && typeof image.sourceUrl === "string" ? [image.sourceUrl] : undefined });
                const imageConfig = NODE_DEFAULT_SIZE[CanvasNodeType.Image];
                const retryImage: CanvasNodeImage = {
                    id: retryImageId,
                    status: NODE_STATUS_SUCCESS,
                    content: uploadedImage.url,
                    storageKey: uploadedImage.storageKey,
                    naturalWidth: uploadedImage.width,
                    naturalHeight: uploadedImage.height,
                    bytes: uploadedImage.bytes,
                    mimeType: uploadedImage.mimeType,
                    generationDurationMs: Date.now() - generationStartedAt,
                };
                const generationMetadata = savedImageMetadata?.generationType
                    ? {
                          generationType: savedImageMetadata.generationType,
                          model: generationConfig.model,
                          size: generationConfig.size,
                          quality: generationConfig.quality,
                          ...(generationConfig.background ? { background: generationConfig.background } : {}),
                          count: savedImageMetadata.count || 1,
                          references: savedImageMetadata.references,
                      }
                    : buildImageGenerationMetadata(useReferenceImages ? "edit" : "generation", generationConfig, 1, retryImages);
                setNodes((prev) =>
                    prev.map((item) => {
                        if (item.id !== node.id) return item;
                        const makePrimary = !imageId || !item.metadata?.content;
                        const edge = imageId ? Math.max(item.width, item.height) : 0;
                        const imageSize = imageId && item.metadata?.freeResize ? { width: item.width, height: item.height } : imageId ? fitNodeSize(uploadedImage.width, uploadedImage.height, edge, edge) : fitNodeSize(uploadedImage.width, uploadedImage.height, imageConfig.width, imageConfig.width);
                        return {
                            ...item,
                            type: CanvasNodeType.Image,
                            ...(makePrimary ? { width: imageSize.width, height: imageSize.height, ...(imageId ? { position: { x: item.position.x + item.width / 2 - imageSize.width / 2, y: item.position.y + item.height / 2 - imageSize.height / 2 } } : {}) } : {}),
                            metadata: {
                                ...item.metadata,
                                ...(makePrimary ? imageMetadata(uploadedImage) : { status: NODE_STATUS_SUCCESS }),
                                images: item.metadata?.images?.map((current) => (current.id === retryImage.id ? retryImage : current)),
                                primaryImageId: makePrimary ? retryImage.id : item.metadata?.primaryImageId,
                                prompt,
                                ...generationMetadata,
                                generationJobId: undefined,
                                generationPhase: undefined,
                                generationDetail: undefined,
                                generationPhaseStartedAt: undefined,
                                generationFailedPhase: undefined,
                                generationProgress: undefined,
                                generationDurationMs: makePrimary ? retryImage.generationDurationMs : item.metadata?.generationDurationMs,
                            },
                        };
                    }),
                );
                notifyGenerationSuccess(node.id);
            } catch (error) {
                if (isGenerationCanceled(error)) return;
                const errorDetails = summarizeApiError(error instanceof Error ? error.message : error, t("canvas.projectPage.generationFailed"));
                message.error(errorDetails);
                setNodes((prev) => prev.map((item) => (item.id === node.id ? { ...item, metadata: { ...item.metadata, status: item.metadata?.content ? NODE_STATUS_SUCCESS : NODE_STATUS_ERROR, errorDetails: item.metadata?.content ? undefined : errorDetails, generationJobId: undefined, generationFailedPhase: item.metadata?.generationPhase, generationPhase: undefined, generationProgress: undefined, images: item.metadata?.images?.map((image) => (image.id === imageId ? { ...image, status: NODE_STATUS_ERROR, errorDetails } : image)) } } : item)));
            } finally {
                finishGenerationRequest(node.id, controller);
                setRunningNodeId(null);
            }
        },
        [commitCanvasNodes, effectiveConfig, finishGenerationRequest, isAiConfigReady, message, notifyGenerationSuccess, openConfigDialog, startGenerationRequest, t],
    );

    const deleteBatchImage = useCallback((nodeId: string, imageId: string) => {
        const node = nodesRef.current.find((item) => item.id === nodeId);
        if ((node?.metadata?.images?.length || 0) <= 2) setExpandedImageNodeId(null);
        setNodes((prev) =>
            prev.map((item) => {
                if (item.id !== nodeId) return item;
                const images = item.metadata?.images?.filter((image) => image.id !== imageId) || [];
                return { ...item, metadata: { ...item.metadata, images, count: images.length, primaryImageId: item.metadata?.primaryImageId === imageId ? images[0]?.id : item.metadata?.primaryImageId } };
            }),
        );
    }, []);

    const retryBatchImage = useCallback((node: CanvasNodeData, imageId: string) => void handleRetryNode(node, imageId), [handleRetryNode]);

    const generateImageFromTextNode = useCallback(
        (node: CanvasNodeData) => {
            const prompt = (node.metadata?.content || node.metadata?.prompt || "").trim();
            if (!prompt) {
                message.warning(t("canvas.projectPage.emptyTextImage"));
                return;
            }
            const sourceNode = nodesRef.current.find((item) => item.id === node.id);
            if (!sourceNode) return;
            const nodeSize = getNodeSpec(CanvasNodeType.Config);
            const configNode = createCanvasNode(
                CanvasNodeType.Config,
                {
                    x: sourceNode.position.x + sourceNode.width + 96 + nodeSize.width / 2,
                    y: sourceNode.position.y + sourceNode.height / 2,
                },
                {
                    prompt: "",
                    model: effectiveConfig.imageModel || effectiveConfig.model,
                    size: effectiveConfig.imageSize,
                    count: 1,
                },
            );
            const connection = { id: nanoid(), fromNodeId: sourceNode.id, toNodeId: configNode.id };
            const nextNodes = nodesRef.current.map((item) => (item.id === sourceNode.id ? { ...item, metadata: { ...item.metadata, content: prompt, prompt, status: NODE_STATUS_SUCCESS } } : item)).concat(configNode);
            const nextConnections = [...connectionsRef.current, connection];
            nodesRef.current = nextNodes;
            connectionsRef.current = nextConnections;
            setNodes(nextNodes);
            setConnections(nextConnections);
            setSelectedNodeIds(new Set([configNode.id]));
            setSelectedConnectionId(null);
            setDialogNodeId(configNode.id);
        },
        [effectiveConfig.imageModel, effectiveConfig.imageSize, effectiveConfig.model, message, t],
    );

    const insertAssistantImage = useCallback(
        async (image: CanvasAssistantImage) => {
            // 进入画布时复制为独立媒体，之后删除或修改资产库记录不会影响画布节点。
            const storedImage = await uploadImage(image.dataUrl);
            const meta = storedImage;
            const config = fitNodeSize(meta.width, meta.height);
            const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const id = `image-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
            const node: CanvasNodeData = {
                id,
                type: CanvasNodeType.Image,
                title: image.prompt || nextMediaNodeTitle(nodesRef.current, CanvasNodeType.Image),
                position: { x: center.x - config.width / 2, y: center.y - config.height / 2 },
                width: config.width,
                height: config.height,
                metadata: { ...imageMetadata({ ...storedImage, width: meta.width, height: meta.height }), prompt: image.prompt },
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([id]));
            setSelectedConnectionId(null);
            setDialogNodeId(id);
        },
        [screenToCanvas, size.height, size.width],
    );

    const insertAssistantText = useCallback(
        (text: string, title?: string) => {
            const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
            const node = {
                ...createCanvasNode(CanvasNodeType.Text, center, { content: text, status: NODE_STATUS_SUCCESS }),
                title: title || text.slice(0, 32) || "Assistant Text",
            };

            setNodes((prev) => [...prev, node]);
            setSelectedNodeIds(new Set([node.id]));
            setSelectedConnectionId(null);
        },
        [screenToCanvas, size.height, size.width],
    );

    const handleAssetInsert = useCallback(
        (payload: InsertAssetPayload) => {
            if (payload.kind === "text") {
                insertAssistantText(payload.content, payload.title);
            } else if (payload.kind === "video") {
                const spec = NODE_DEFAULT_SIZE[CanvasNodeType.Video];
                const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
                const id = `video-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
                const nextSize = fitNodeSize(payload.width || spec.width, payload.height || spec.height, MEDIA_NODE_LONG_EDGE, MEDIA_NODE_LONG_EDGE);
                setNodes((prev) => [
                    ...prev,
                    {
                        id,
                        type: CanvasNodeType.Video,
                        title: payload.title,
                        position: { x: center.x - nextSize.width / 2, y: center.y - nextSize.height / 2 },
                        width: nextSize.width,
                        height: nextSize.height,
                        metadata: { content: payload.url, storageKey: payload.storageKey, status: NODE_STATUS_SUCCESS, naturalWidth: payload.width, naturalHeight: payload.height },
                    },
                ]);
                setSelectedNodeIds(new Set([id]));
            } else if (payload.kind === "audio") {
                const center = screenToCanvas((containerRef.current?.getBoundingClientRect().left || 0) + size.width / 2, (containerRef.current?.getBoundingClientRect().top || 0) + size.height / 2);
                const node = createCanvasNode(CanvasNodeType.Audio, center, { content: payload.url, storageKey: payload.storageKey, durationMs: payload.durationMs, status: NODE_STATUS_SUCCESS, mimeType: "audio/mpeg" });
                node.title = payload.title;
                setNodes((prev) => [...prev, node]);
                setSelectedNodeIds(new Set([node.id]));
            } else {
                insertAssistantImage({ id: `asset-${Date.now()}`, prompt: payload.title, dataUrl: payload.dataUrl, storageKey: payload.storageKey });
            }
        },
        [insertAssistantImage, insertAssistantText, screenToCanvas, size.height, size.width],
    );

    // Memoize every callback and render function passed to CanvasNode.
    // CanvasNode uses React.memo, but new prop references would invalidate it on every render and rerender every node
    // during click, hover, or viewport changes, which is especially expensive for Markdown. These useCallback values
    // and their memoized map/handler dependencies remain stable during interaction, so unchanged nodes do not rerender.
    const handleNodeHoverStart = useCallback((nodeId: string) => {
        if (nodeDraggingRef.current) return;
        setHoveredNodeId(nodeId);
    }, []);
    const handleNodeHoverEnd = useCallback((nodeId: string) => {
        setHoveredNodeId((current) => (current === nodeId ? null : current));
    }, []);
    const handleNodeViewImage = useCallback((node: CanvasNodeData) => {
        setPreviewImageId(null);
        setPreviewNodeId(node.id);
    }, []);
    const handleBatchImageView = useCallback((node: CanvasNodeData, imageId: string) => {
        setPreviewImageId(imageId);
        setPreviewNodeId(node.id);
    }, []);
    const handleNodeRetry = useCallback((node: CanvasNodeData) => void handleRetryNode(node), [handleRetryNode]);
    const handleSelectCinePackCharacterReference = useCallback(
        (shotId: string, characterNodeId: string, referenceId: string) => {
            void commitCanvasNodes((current) => {
                const shotNode = current.find((node) => node.id === shotId);
                const characterNode = current.find((node) => node.id === characterNodeId);
                if (!shotNode || !characterNode) return current;
                return current.map((node) => (node.id === shotId ? selectCinePackCharacterReference(shotNode, characterNode, referenceId) : node));
            }).catch((error) => message.error(error instanceof Error ? error.message : "角色造型选择保存失败"));
        },
        [commitCanvasNodes, message],
    );
    const handleNodeContextMenu = useCallback((event: ReactMouseEvent, nodeId: string) => {
        event.preventDefault();
        event.stopPropagation();
        setContextMenu({ type: "node", x: event.clientX, y: event.clientY, nodeId });
    }, []);

    const renderNodePanel = useCallback(
        (panelNode: CanvasNodeData) =>
            getNodeDefinition(panelNode.type)?.Panel ? (
                renderPluginPanel(panelNode)
            ) : panelNode.type === CanvasNodeType.Config ? (
                <CanvasConfigComposer
                    value={panelNode.metadata?.composerContent ?? panelNode.metadata?.prompt ?? ""}
                    inputs={configInputsById.get(panelNode.id) || []}
                    onChange={(composerContent) => handleConfigNodeChange(panelNode.id, { composerContent })}
                    onClose={() => setDialogNodeId(null)}
                />
            ) : (
                <CanvasNodePromptPanel
                    node={panelNode}
                    isRunning={runningNodeId === panelNode.id || (panelNode.metadata?.status === NODE_STATUS_LOADING && Boolean(panelNode.metadata?.generationJobId))}
                    mentionReferences={mentionReferencesByNodeId.get(panelNode.id) || EMPTY_REFERENCES}
                    storyboards={panelNode.type === CanvasNodeType.Video ? storyboardNodesFor(panelNode.id, nodes) : EMPTY_NODES}
                    onPromptChange={handleNodePromptChange}
                    onConfigChange={handleConfigNodeChange}
                    onGenerate={handleGenerateNode}
                    onGenerateCopy={handleGenerateCopyNode}
                    onStop={confirmStopGeneration}
                    onGenerateStoryboard={(nodeId, prompt) => void generateStoryboard(nodeId, prompt)}
                    onPreviewStoryboard={setPreviewNodeId}
                    onDeleteStoryboard={deleteStoryboard}
                    onDisconnectReference={disconnectPromptReference}
                    onFocusReference={focusReferenceNode}
                    onReorderReferences={reorderNodeReferences}
                    modeOverride={getNodeDefinition(panelNode.type)?.useBuiltinPanel?.mode}
                    onImageSettingsOpenChange={(open) => {
                        setNodeImageSettingsOpen(open);
                        if (open) setToolbarNodeId(null);
                    }}
                />
            ),
        [configInputsById, confirmStopGeneration, deleteStoryboard, disconnectPromptReference, focusReferenceNode, reorderNodeReferences, generateStoryboard, handleConfigNodeChange, handleGenerateCopyNode, handleGenerateNode, handleNodePromptChange, mentionReferencesByNodeId, nodes, renderPluginPanel, runningNodeId],
    );

    const renderNodeContentPanel = useCallback(
        (contentNode: CanvasNodeData) => (
            <CanvasConfigNodePanel
                node={contentNode}
                isRunning={runningNodeId === contentNode.id || (contentNode.metadata?.status === NODE_STATUS_LOADING && Boolean(contentNode.metadata?.generationJobId))}
                inputSummary={getInputSummary(configInputsById.get(contentNode.id) || [])}
                onConfigChange={handleConfigNodeChange}
                onComposerToggle={() => setDialogNodeId((current) => (current === contentNode.id ? null : contentNode.id))}
                onStop={confirmStopGeneration}
                onGenerate={(nodeId) => {
                    const target = nodesRef.current.find((item) => item.id === nodeId);
                    void handleGenerateNode(nodeId, target?.metadata?.generationMode || "image", target?.metadata?.composerContent ?? target?.metadata?.prompt ?? "");
                }}
            />
        ),
        [configInputsById, confirmStopGeneration, handleConfigNodeChange, handleGenerateNode, runningNodeId],
    );

    const selectConnection = useCallback((connectionId: string) => {
        setSelectedConnectionId(connectionId);
        setSelectedNodeIds(new Set());
        setDialogNodeId(null);
        setContextMenu(null);
    }, []);
    const openConnectionMenu = useCallback((event: ReactMouseEvent<SVGPathElement>, connectionId: string) => {
        setSelectedConnectionId(connectionId);
        setSelectedNodeIds(new Set());
        setContextMenu({ type: "connection", x: event.clientX, y: event.clientY, connectionId });
    }, []);

    const requestCanvasUpload = useCallback(() => handleUploadRequest(), [handleUploadRequest]);
    const toggleMiniMap = useCallback(() => setIsMiniMapOpen(value => !value), []);
    const cancelTitleEditing = useCallback(() => setTitleEditing(false), []);
    const goHome = useCallback(() => navigate("/"), [navigate]);
    const openLocalFolders = useCallback(() => setLocalFoldersOpen(true), []);
    const openJianyingExport = useCallback(() => {
        if (!projectId) return;
        setJianyingSelection({ projectId, sections: buildVideoLibrary(nodesRef.current, connectionsRef.current), selectedIds: new Set(selectedNodeIdsRef.current) });
    }, [projectId]);

    if (!projectLoaded) return <CanvasRefreshShell backgroundMode={currentProject?.backgroundMode} viewport={currentProject?.viewport} />;

    return (
        <main data-canvas-state="ready" data-canvas-project={projectId} data-canvas-restore-timing={JSON.stringify(restoreMetrics)} className="flex h-full min-h-0 overflow-hidden" style={{ background: theme.canvas.background, color: theme.node.text }}>
            <LocalAgentPanel headless autoConnect />
            <CanvasSidePanel onInsertAsset={handleAssetInsert} />
            <section className="relative min-w-0 flex-1 overflow-hidden" data-canvas-node-interacting={isNodeDragging || isNodeResizing ? "true" : undefined} data-connection-flow-paused={isNodeDragging || isNodeResizing ? "true" : undefined}>
                <CanvasTopBar
                    title={currentProject?.title || t("canvas.projectPage.untitledCanvas")}
                    titleDraft={titleDraft}
                    isTitleEditing={titleEditing}
                    onTitleDraftChange={setTitleDraft}
                    onStartTitleEditing={startTitleEditing}
                    onFinishTitleEditing={finishTitleEditing}
                    onCancelTitleEditing={cancelTitleEditing}
                    onHome={goHome}
                    onResourceList={currentProject?.cineflowProjectId ? () => navigate(`/cineflow?project=${encodeURIComponent(currentProject.cineflowProjectId!)}&view=assets`) : undefined}
                    onOpenLocalFolders={openLocalFolders}
                    onExportJianying={openJianyingExport}
                />

                <InfiniteCanvas
                    containerRef={containerRef}
                    viewport={viewport}
                    backgroundMode={backgroundMode}
                    onViewportChange={changeViewport}
                    onCanvasMouseDown={handleCanvasMouseDown}
                    onCanvasDeselect={deselectCanvas}
                    onCanvasDoubleClick={(event) => {
                        setContextMenu(null);
                        setNodeCreatePosition(screenToCanvas(event.clientX, event.clientY));
                    }}
                    onContextMenu={preventCanvasContextMenu}
                    onDrop={handleDrop}
                >
                    <svg width="1" height="1" className="absolute left-0 top-0 overflow-visible" style={{ pointerEvents: "none", zIndex: 0 }}>
                        {visibleConnections
                            .map((connection) => {
                                const from = nodeById.get(connection.fromNodeId);
                                const to = nodeById.get(connection.toNodeId);
                                if (!from || !to) return null;

                                return (
                                    <ConnectionPath
                                        key={connection.id}
                                        connection={connection}
                                        from={from}
                                        to={to}
                                        active={selectedConnectionId === connection.id || relatedHighlight.connectionIds.has(connection.id)}
                                        flowing={!isNodeDragging && !isNodeResizing && (selectedConnectionId === connection.id || selectedNodeIds.has(connection.fromNodeId) || selectedNodeIds.has(connection.toNodeId))}
                                        onSelect={selectConnection}
                                        onContextMenu={openConnectionMenu}
                                    />
                                );
                            })}
                        {connectingParams ? <ActiveConnectionPath node={nodeById.get(connectingParams.nodeId)} handle={connectingParams} mouseWorld={mouseWorld} target={connectionTargetNodeId ? nodeById.get(connectionTargetNodeId) : undefined} /> : null}
                    </svg>

                    {visibleNodes.map((node) => (
                        <CanvasNode
                            key={node.id}
                            data={node}
                            scale={viewport.k}
                            isSelected={selectedNodeIds.has(node.id)}
                            isRelated={relatedHighlight.nodeIds.has(node.id)}
                            isFocusRelated={activeNodeId === node.id}
                            isConnectionTarget={connectionTargetNodeId === node.id}
                            isConnecting={Boolean(connectingParams)}
                            editRequestNonce={editingNodeId === node.id ? editRequestNonce : 0}
                            renameRequestNonce={renamingNodeId === node.id ? renameRequestNonce : 0}
                            showPanel={dialogNodeId === node.id && !selectionBox && !showBatchReferenceToolbar && !getNodeDefinition(node.type)?.hidePanel}
                            hasRunningStoryboard={runningStoryboardSourceIds.has(node.id)}
                            groupChildCount={groupChildCountById.get(node.id) || 0}
                            isGroupDropTarget={dropTargetGroupId === node.id}
                            batchExpanded={expandedImageNodeId === node.id}
                            showImageInfo={showImageInfo}
                            mentionReferences={mentionReferencesByNodeId.get(node.id) || EMPTY_REFERENCES}
                            activeCinePackShot={activeCinePackShot}
                            pluginHost={pluginHost}
                            registryVersion={nodeRegistryVersion}
                            renderPanel={dialogNodeId === node.id ? renderNodePanel : undefined}
                            renderNodeContent={node.type === CanvasNodeType.Config ? renderNodeContentPanel : undefined}
                            onMouseDown={handleNodeMouseDown}
                            onSelectCapture={handleNodeSelectCapture}
                            onHoverStart={handleNodeHoverStart}
                            onHoverEnd={handleNodeHoverEnd}
                            onConnectStart={handleConnectStart}
                            onResizeStart={handleNodeResizeStart}
                            onResize={handleNodeResize}
                            onResizeEnd={handleNodeResizeEnd}
                            onContentChange={handleNodeContentChange}
                            onImageDimensions={handleImageDimensions}
                            onTitleChange={handleNodeTitleChange}
                            onGroupColorChange={handleGroupColorChange}
                            onToggleBatch={toggleBatchExpanded}
                            onSetBatchPrimary={setBatchPrimary}
                            onDuplicateBatchImage={duplicateBatchImage}
                            onDownloadBatchImage={downloadBatchImage}
                            onRetryBatchImage={retryBatchImage}
                            onDeleteBatchImage={deleteBatchImage}
                            onRetry={handleNodeRetry}
                            onGenerateImage={generateImageFromTextNode}
                            onSelectCinePackCharacterReference={handleSelectCinePackCharacterReference}
                            onViewImage={handleNodeViewImage}
                            onViewBatchImage={handleBatchImageView}
                            onContextMenu={handleNodeContextMenu}
                        />
                    ))}

                    {selectionBox ? (
                        <svg
                            ref={selectionSvgRef}
                            className="pointer-events-none absolute z-[100] overflow-visible"
                            style={{
                                left: Math.min(selectionBox.startWorldX, selectionBox.currentWorldX),
                                top: Math.min(selectionBox.startWorldY, selectionBox.currentWorldY),
                                width: Math.abs(selectionBox.currentWorldX - selectionBox.startWorldX),
                                height: Math.abs(selectionBox.currentWorldY - selectionBox.startWorldY),
                            }}
                        >
                            <rect width="100%" height="100%" fill={theme.canvas.selectionFill} stroke={theme.canvas.selectionStroke} strokeOpacity={0.55} strokeWidth={1 / viewport.k} strokeDasharray={`${6 / viewport.k} ${4 / viewport.k}`} />
                        </svg>
                    ) : null}
                    {pendingConnectionCreate ? <ConnectionCreateMenu pending={pendingConnectionCreate} onCreate={(type) => createConnectedNode(type, pendingConnectionCreate)} onClose={cancelPendingConnectionCreate} /> : null}
                    {nodeCreatePosition ? (
                        <NodeCreateMenu
                            position={nodeCreatePosition}
                            onCreate={(type) => {
                                createNode(type, nodeCreatePosition);
                                setNodeCreatePosition(null);
                            }}
                            onClose={() => setNodeCreatePosition(null)}
                        />
                    ) : null}
                </InfiniteCanvas>

                <CanvasNodeHoverToolbar
                    node={isNodeDragging || isNodeResizing || nodeImageSettingsOpen || expandedImageNodeId ? null : toolbarNode}
                    viewport={viewport}
                    extraTools={toolbarNode ? buildNodeToolbarItems(toolbarNode) : undefined}
                    onKeep={keepNodeToolbar}
                    onLeave={hideNodeToolbar}
                    onInfo={(node) => setInfoNodeId(node.id)}
                    onEditText={openTextEditor}
                    onDecreaseFont={(node) => handleFontSizeChange(node.id, Math.max(10, (node.metadata?.fontSize || 14) - 2))}
                    onIncreaseFont={(node) => handleFontSizeChange(node.id, Math.min(32, (node.metadata?.fontSize || 14) + 2))}
                    onToggleDialog={(node) => setDialogNodeId((current) => (current === node.id ? null : node.id))}
                    onGenerateImage={generateImageFromTextNode}
                    onUpload={(node) => handleUploadRequest(node.id)}
                    onDownload={downloadNodeImage}
                    onCaptureFrame={(node) => void captureVideoFrame(node)}
                    onTrimVideo={(node) => {
                        const duration = (node.metadata?.durationMs || 0) / 1000;
                        setTrimDuration(duration);
                        setTrimStart(0);
                        setTrimEnd(Math.min(4, duration));
                        setTrimNodeId(node.id);
                    }}
                    onSaveAsset={(node) => void saveNodeAsset(node)}
                    onMaskEdit={(node) => setMaskEditNodeId(node.id)}
                    onCrop={(node) => setCropNodeId(node.id)}
                    onSplit={(node) => setSplitNodeId(node.id)}
                    onUpscale={(node) => setUpscaleNodeId(node.id)}
                    onSuperResolve={(node) => setSuperResolveNodeId(node.id)}
                    onAngle={(node) => setAngleNodeId(node.id)}
                    onViewImage={(node) => setPreviewNodeId(node.id)}
                    onReversePrompt={createImageReversePromptNodes}
                    onRetry={(node) => void handleRetryNode(node)}
                    onToggleFreeResize={(node) => toggleNodeFreeResize(node.id)}
                    onDelete={(node) => deleteNodes(new Set([node.id]))}
                />

                {!selectionBox && !isNodeDragging && !isNodeResizing && !connectingParams ? <CanvasSelectionConnector resources={selectedResourcesForGeneration} viewport={viewport} onConnect={connectSelectedResources} /> : null}
                <CanvasToolbar alignmentCount={alignmentSelection.count} alignmentInGroup={Boolean(alignmentSelection.groupId)} onAlign={alignSelectedNodes} canUndo={historyState.canUndo} canRedo={historyState.canRedo} onUndo={undoCanvas} onRedo={redoCanvas} onUpload={requestCanvasUpload} />

                {referenceReturn?.projectId === projectId ? (
                    <div className="pointer-events-none absolute bottom-[5.5rem] z-50 flex justify-center" style={{ left: 300, right: 16 }}>
                        <div data-canvas-no-zoom className="pointer-events-auto flex items-center gap-3 rounded-xl border px-3 py-2 text-sm shadow-lg" style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.toolbar.item }}>
                            <span role="status">已聚焦到所选节点</span>
                            <Button size="small" onClick={returnToReferenceSource}>返回节点</Button>
                            <Button type="text" size="small" aria-label="关闭聚焦提示" icon={<X className="size-4" />} onClick={() => setReferenceReturn(null)} />
                        </div>
                    </div>
                ) : null}

                {isMiniMapOpen ? <Minimap nodes={canvasNodes} viewport={viewport} viewportSize={size} onViewportChange={changeViewport} /> : null}

                <CanvasZoomControls scale={viewport.k} onScaleChange={setZoomScale} onReset={resetViewport} isMiniMapOpen={isMiniMapOpen} onToggleMiniMap={toggleMiniMap} />

                {contextMenu ? (
                    <CanvasNodeContextMenu
                        menu={contextMenu}
                        onClose={() => setContextMenu(null)}
                        onDuplicate={() => {
                            if (contextMenu.type !== "node") return;
                            duplicateNode(contextMenu.nodeId);
                            setContextMenu(null);
                        }}
                        onCopyNode={() => {
                            if (contextMenu.type !== "node") return;
                            copyNodeWithPrompt(contextMenu.nodeId);
                            setContextMenu(null);
                        }}
                        onDeleteConnection={() => {
                            if (contextMenu.type === "connection") {
                                deleteConnection(contextMenu.connectionId);
                            }
                            setContextMenu(null);
                        }}
                    />
                ) : null}

                <input ref={imageInputRef} type="file" multiple accept="image/*,video/*,audio/mpeg,audio/wav,audio/x-wav,.mp3,.wav" className="hidden" onChange={handleImageInputChange} />

                {infoNode ? <CanvasNodeInfoModal node={infoNode} open onClose={() => setInfoNodeId(null)} /> : null}
                {jianyingSelection && jianyingSelection.projectId === projectId && <CanvasJianyingExport sections={jianyingSelection.sections} selectedIds={jianyingSelection.selectedIds} title={currentProject?.title || "画布"} onClose={() => setJianyingSelection(null)} />}
                {pluginManagerOpen ? <CanvasPluginManagerModal open onClose={() => setPluginManagerOpen(false)} /> : null}
                {localFoldersOpen && currentProject ? <CanvasDiskMediaModal key={projectId} projectId={projectId} onClose={() => setLocalFoldersOpen(false)} onLegacyFolders={() => {
                    setLocalFoldersOpen(false);
                    setLegacyFoldersOpen(true);
                }} /> : null}
                {legacyFoldersOpen ? <CanvasLocalFoldersModal
                    open={legacyFoldersOpen}
                    project={currentProject ? { id: currentProject.id, localFolderLabels: currentProject.localFolderLabels, nodes } : null}
                    onClose={() => setLegacyFoldersOpen(false)}
                    onLabelsChange={(labels: CanvasFolderLabels) => updateProject(projectId, { localFolderLabels: labels })}
                /> : null}

                {cropNode?.metadata?.content ? <CanvasNodeCropDialog dataUrl={cropNode.metadata.content} open={Boolean(cropNode)} onClose={() => setCropNodeId(null)} onConfirm={(crop) => void cropImageNode(cropNode!, crop)} /> : null}

                {maskEditNode?.metadata?.content ? (
                    <CanvasNodeMaskEditDialog dataUrl={maskEditNode.metadata.content} open={Boolean(maskEditNode)} onClose={() => setMaskEditNodeId(null)} onConfirm={(payload) => void maskEditImageNode(maskEditNode!, payload)} />
                ) : null}

                {splitNode?.metadata?.content ? <CanvasNodeSplitDialog dataUrl={splitNode.metadata.content} open={Boolean(splitNode)} onClose={() => setSplitNodeId(null)} onConfirm={(params) => void splitImageNode(splitNode!, params)} /> : null}

                {trimNode ? <CanvasVideoTrimDialog node={trimNode} start={trimStart} end={trimEnd} busy={trimming} progress={trimProgress} onStartChange={setTrimStart} onEndChange={setTrimEnd} onDuration={(duration) => { setTrimDuration(duration); if (trimEnd === 0 || trimEnd > duration) setTrimEnd(Math.min(4, duration)); }} onCancel={() => !trimming && setTrimNodeId(null)} onConfirm={() => void confirmTrimVideo()} /> : null}

                {upscaleNode?.metadata?.content ? (
                    <CanvasNodeUpscaleDialog dataUrl={upscaleNode.metadata.content} open={Boolean(upscaleNode)} onClose={() => setUpscaleNodeId(null)} onConfirm={(params) => void upscaleImageNode(upscaleNode!, params)} />
                ) : null}

                {Boolean(superResolveNode?.metadata?.content) ? <Modal title={t("canvas.projectPage.superResolve")} open={Boolean(superResolveNode?.metadata?.content)} centered footer={null} onCancel={() => setSuperResolveNodeId(null)}>
                    <div className="py-8 text-center text-base font-medium">{t("canvas.projectPage.notImplemented")}</div>
                </Modal> : null}

                {angleNode?.metadata?.content ? <CanvasNodeAngleDialog dataUrl={angleNode.metadata.content} open={Boolean(angleNode)} onClose={() => setAngleNodeId(null)} onConfirm={(params) => void generateAngleNode(angleNode!, params)} /> : null}

                {previewContent ? <Modal
                    closable={false}
                    open={Boolean(previewContent)}
                    centered
                    onCancel={() => {
                        setPreviewNodeId(null);
                        setPreviewImageId(null);
                    }}
                    footer={null}
                    width="fit-content"
                    styles={{ container: { padding: 2, borderRadius: 6 }, body: { padding: 0 } }}
                >
                    {previewContent ? (
                        <CanvasImagePreview key={`${previewNodeId}:${previewImageId}:${previewContent}`} src={previewContent} title={previewNode?.title || t("assets.kinds.image")} details={[previewPixelSize, previewBatchImages.length > 1 ? `${previewIndex + 1}/${previewBatchImages.length}` : ""].filter(Boolean).join(" · ")} onClose={() => { setPreviewNodeId(null); setPreviewImageId(null); }}>
                            {previewBatchImages.length > 1 ? (
                                <>
                                    <button type="button" aria-label="上一张" title="上一张（←）" className="absolute left-3 top-1/2 -translate-y-1/2 grid size-11 place-items-center rounded-full bg-black/55 text-white shadow-lg backdrop-blur-sm transition hover:bg-black/75" onClick={() => showAdjacentPreview(-1)}>
                                        <ChevronLeft className="size-6" />
                                    </button>
                                    <button type="button" aria-label="下一张" title="下一张（→）" className="absolute right-3 top-1/2 -translate-y-1/2 grid size-11 place-items-center rounded-full bg-black/55 text-white shadow-lg backdrop-blur-sm transition hover:bg-black/75" onClick={() => showAdjacentPreview(1)}>
                                        <ChevronRight className="size-6" />
                                    </button>
                                </>
                            ) : null}
                        </CanvasImagePreview>
                    ) : null}
                </Modal> : null}

                {clearConfirmOpen ? <Modal
                    title={t("canvas.projectPage.clearTitle")}
                    open={clearConfirmOpen}
                    centered
                    onCancel={() => setClearConfirmOpen(false)}
                    footer={
                        <>
                            <Button onClick={() => setClearConfirmOpen(false)}>{t("common.cancel")}</Button>
                            <Button danger type="primary" onClick={clearCanvas}>
                                {t("canvas.projectPage.clear")}
                            </Button>
                        </>
                    }
                >
                    <p className="text-sm opacity-60">{t("canvas.projectPage.clearDescription")}</p>
                </Modal> : null}

                {Boolean(deleteConfirm) ? <Modal
                    title={t("canvas.controls.deleteNodeTitle")}
                    open={Boolean(deleteConfirm)}
                    centered
                    onCancel={() => setDeleteConfirm(null)}
                    footer={
                        <>
                            <Button onClick={() => setDeleteConfirm(null)}>{t("common.cancel")}</Button>
                            <Button
                                danger
                                type="primary"
                                onClick={() => {
                                    if (!deleteConfirm) return;
                                    deleteNodes(deleteConfirm.ids);
                                    setDeleteConfirm(null);
                                }}
                            >
                                {t("canvas.controls.delete")}
                            </Button>
                        </>
                    }
                >
                    <p className="text-sm opacity-60">
                        {t("canvas.controls.deleteNodeDescription", { count: deleteConfirm?.ids.size ?? 0 })}
                    </p>
                </Modal> : null}

                {newAssetDraft ? <AssetDetailModal open draft={newAssetDraft} onClose={() => setNewAssetDraft(null)} /> : null}
            </section>
        </main>
    );
}

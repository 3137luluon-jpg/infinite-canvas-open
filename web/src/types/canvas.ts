export type Position = {
    x: number;
    y: number;
};

export type ViewportTransform = {
    x: number;
    y: number;
    k: number;
};

export enum CanvasNodeType {
    Image = "image",
    Text = "text",
    Config = "config",
    Video = "video",
    Audio = "audio",
    Group = "group",
}

// Node types are open strings: built-ins use CanvasNodeType and plugins use "<pluginId>:<name>".
export type CanvasNodeTypeId = CanvasNodeType | (string & {});

export type CanvasNodeStatus = "idle" | "success" | "loading" | "error";
export type CanvasGenerationMode = "text" | "image" | "video" | "audio";
export type CanvasImageGenerationType = "generation" | "edit";
export type CanvasGenerationPhase = "packing" | "resolving" | "compressing" | "planning" | "submitting" | "queued" | "generating" | "downloading" | "saving";

export type CanvasNodeImage = {
    id: string;
    status: CanvasNodeStatus;
    errorDetails?: string;
    content: string;
    storageKey: string;
    naturalWidth: number;
    naturalHeight: number;
    bytes: number;
    mimeType: string;
    /** End-to-end time spent generating and saving this image. */
    generationDurationMs?: number;
};

export type CanvasNodeMetadata = {
    cineflowAgent?: { projectId: string; taskId: string; targetId: string; basis: string };
    cineflowGroup?: { projectId: string; key: string };
    cineflowOrganization?: { groupKey: string; groupTitle: string; code: string; label: string; kind: string; version?: number };
    cineflowHandoff?: { projectId: string; unitId: string; jobId: string; prompt: string; model: string; seconds: number; referenceKeys: string[] };
    /** 剪辑整理只保存分组、镜头顺序和版本；原始媒体键保持不变。 */
    videoOrganization?: import("../lib/canvas/video-library").VideoOrganization;
    productionDirection?: string;
    productionCompilation?: import("./cinepack-compilation").ShotCompilation;
    content?: string;
    composerContent?: string;
    prompt?: string;
    status?: CanvasNodeStatus;
    errorDetails?: string;
    fontSize?: number;
    generationMode?: CanvasGenerationMode;
    generationType?: CanvasImageGenerationType;
    model?: string;
    reasoningEffort?: "auto" | "low" | "medium" | "high" | "xhigh";
    size?: string;
    quality?: string;
    background?: string;
    count?: number;
    seconds?: string;
    vquality?: string;
    generateAudio?: string;
    watermark?: string;
    audioVoice?: string;
    audioFormat?: string;
    audioSpeed?: string;
    audioInstructions?: string;
    references?: string[];
    naturalWidth?: number;
    naturalHeight?: number;
    freeResize?: boolean;
    images?: CanvasNodeImage[];
    primaryImageId?: string;
    storageKey?: string;
    mimeType?: string;
    bytes?: number;
    durationMs?: number;
    /** End-to-end generation time; distinct from video/audio playback durationMs. */
    generationDurationMs?: number;
    groupId?: string;
    /** 分组色卡原值；底色与标题色由色卡分别派生。 */
    groupColor?: string;
    interactive?: boolean; // Plugin node interaction/move state; see CanvasNodeDefinition.interactionToggle.
    /** Alt+拖动创建的创作副本可直接在本节点内按新提示词重新生成一次。 */
    regenerateInPlace?: boolean;
    /** 本地生成订单 id，用于刷新后续轮询 */
    generationJobId?: string;
    /** 生成流程当前阶段；图片与故事板使用细分阶段，视频保持独立流程。 */
    generationPhase?: CanvasGenerationPhase;
    /** 当前阶段的简短诊断信息。 */
    generationDetail?: string;
    /** 阶段开始时间，用于判断卡住时长。 */
    generationPhaseStartedAt?: number;
    /** 失败时保留发生阶段，避免只剩模糊错误。 */
    generationFailedPhase?: CanvasGenerationPhase;
    /** 远程轮询进度 0–100（渠道有返回时才有） */
    generationProgress?: number;
    /** 视频截帧来源与时间点 */
    sourceVideoId?: string;
    sourceVideoTimeMs?: number;
    /** 不参与画布渲染的内部节点。 */
    hidden?: boolean;
    /** 故事板所属的视频节点。 */
    storyboardSourceNodeId?: string;
    /** 该视频节点下的故事板生成序号。 */
    storyboardIndex?: number;
    /** 片场流 V1 只读来源信息；不改变原生画布项目存储结构。 */
    cinepack?: {
        schemaVersion: "cinepack.v1";
        projectId: string;
        revisionId: string;
        kind: "project" | "content" | "visual-style" | "asset-group" | "asset" | "shot-group" | "shot" | "storyboard" | "prompt" | "image-generation";
        stableId: string;
        shotId?: string;
        shotGroupId?: string;
        sceneId?: string;
        assetId?: string;
        assetType?: "character" | "scene" | "prop";
        assetRefIds?: string[];
        variantBindings?: Record<string, string>;
        sourcePath?: string;
        identityReference?: { versionId: string; sourcePath: string; storageKey?: string };
        characterLooks?: Array<{
            variantId: string;
            name: string;
            promptZh: string;
            explicitFacts: Record<string, unknown>;
            inferredFacts: Record<string, unknown>;
            sourceRefs: Array<Record<string, unknown>>;
            selectedReference?: { versionId: string; sourcePath: string; storageKey?: string };
        }>;
        locked?: boolean;
        lockedFacts?: string[];
        continuityRules?: string[];
        explicitFacts?: Record<string, unknown>;
        inferredFacts?: Record<string, unknown>;
    };
};

export type CanvasNodeData = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    position: Position;
    width: number;
    height: number;
    metadata?: CanvasNodeMetadata;
};

export type CanvasConnection = {
    id: string;
    fromNodeId: string;
    toNodeId: string;
};

export type CanvasAssistantReference = {
    id: string;
    type: CanvasNodeTypeId;
    title: string;
    dataUrl?: string;
    storageKey?: string;
    text?: string;
};

export type CanvasAssistantImage = {
    id: string;
    dataUrl: string;
    storageKey?: string;
    prompt: string;
};

export type CanvasAssistantMessage = {
    id: string;
    role: "user" | "assistant" | "system" | "tool" | "error";
    title?: string;
    text: string;
    meta?: string;
    detail?: unknown;
    references?: CanvasAssistantReference[];
};

export type CanvasAssistantSession = {
    id: string;
    title: string;
    messages: CanvasAssistantMessage[];
    createdAt: string;
    updatedAt: string;
};

export type ConnectionHandle = {
    nodeId: string;
    handleType: "source" | "target";
};

export type SelectionBox = {
    startWorldX: number;
    startWorldY: number;
    currentWorldX: number;
    currentWorldY: number;
    additive: boolean;
    initialSelectedNodeIds: string[];
};

export type ContextMenuState =
    | {
          type: "node";
          x: number;
          y: number;
          nodeId: string;
      }
    | {
          type: "connection";
          x: number;
          y: number;
          connectionId: string;
      };

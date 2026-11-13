import type { VideoGenerationTask } from "@/services/api/video";
import type { ImageGenerationTask } from "@/services/api/image";
import type { CanvasGenerationPhase } from "@/types/canvas";
import type { CanvasFolderLabels } from "@/lib/canvas/canvas-local-folders";

export type BoardReferenceKind = "image" | "video" | "audio";

export type BoardReference = {
    id: string;
    assetId?: string;
    kind: BoardReferenceKind;
    label: string;
    title: string;
    url: string;
    storageKey?: string;
    mimeType: string;
    width?: number;
    height?: number;
    bytes?: number;
    durationMs?: number;
};

export type BoardStoryboard = {
    id: string;
    index: number;
    status: "loading" | "success" | "error";
    content?: string;
    storageKey?: string;
    mimeType?: string;
    width?: number;
    height?: number;
    phase?: CanvasGenerationPhase;
    phaseDetail?: string;
    error?: string;
    task?: ImageGenerationTask;
};

export type BoardVideo = {
    id: string;
    prompt: string;
    model?: string;
    size?: string;
    vquality?: string;
    seconds?: number;
    generateAudio?: boolean;
    watermark?: boolean;
    status: "idle" | "loading" | "success" | "error";
    content?: string;
    storageKey?: string;
    mimeType?: string;
    bytes?: number;
    width?: number;
    height?: number;
    durationMs?: number;
    task?: VideoGenerationTask;
    progress?: number;
    error?: string;
    references: BoardReference[];
    storyboards: BoardStoryboard[];
    createdAt: string;
    updatedAt: string;
};

export type BoardShot = {
    id: string;
    title: string;
    videos: BoardVideo[];
    selectedVideoId: string;
    defaultVideoId: string;
    lastViewedAt: string;
    createdAt: string;
    updatedAt: string;
};

export type BoardProject = {
    id: string;
    title: string;
    shots: BoardShot[];
    activeShotId: string;
    localFolderLabels?: CanvasFolderLabels;
    createdAt: string;
    updatedAt: string;
};

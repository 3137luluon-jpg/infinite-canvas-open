import { createGenerationJob, getGenerationJob, isImageRemoteTask, listResumableJobs, patchGenerationJob, type CanvasGenerationJob } from "@/lib/canvas/generation-job-store";
import { writeGeneratedBlob } from "@/lib/canvas/canvas-local-folders";
import { pollApimartImageTaskOnce } from "@/services/api/image";
import { pollComfyUiImageTaskOnce } from "@/services/api/comfyui";
import { pollVideoGenerationTask, storeGeneratedVideo, type VideoGenerationTask } from "@/services/api/video";
import { getImageBlob, uploadImage } from "@/services/image-storage";
import { getMediaBlob } from "@/services/file-storage";
import { buildGenerationConfig, patchNodeGenerationUi } from "@/lib/canvas/canvas-generation-helpers";
import { videoMetadata } from "@/lib/canvas/canvas-node-factory";
import { inheritVideoOrganization, preservePreviousVideo } from "@/lib/canvas/video-library";
import { fitNodeSize, MEDIA_NODE_LONG_EDGE } from "@/lib/canvas/canvas-node-size";
import { resolveModelRequestConfig, type AiConfig } from "@/stores/use-config-store";
import type { CanvasNodeData } from "@/types/canvas";
import { CanvasNodeType } from "@/types/canvas";

const delay = (ms: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(new DOMException("Aborted", "AbortError"));
            return;
        }
        const timer = window.setTimeout(() => resolve(), ms);
        signal?.addEventListener(
            "abort",
            () => {
                window.clearTimeout(timer);
                reject(new DOMException("Aborted", "AbortError"));
            },
            { once: true },
        );
    });

export async function attachRemoteTaskToJob(jobId: string, remoteTask: NonNullable<CanvasGenerationJob["remoteTask"]>) {
    const imageTask = isImageRemoteTask(remoteTask) ? remoteTask : undefined;
    const workflowTask = remoteTask as { submittedAt?: number; workflowId?: string; inputSnapshot?: Record<string, unknown> };
    return patchGenerationJob(jobId, {
        remoteTask,
        status: "pending",
        submittedAt: imageTask?.submittedAt || workflowTask.submittedAt || Date.now(),
        workflowId: imageTask?.workflowId || workflowTask.workflowId,
        inputSnapshot: imageTask?.inputSnapshot || workflowTask.inputSnapshot,
    });
}

export async function beginCanvasGenerationJob(input: { projectId: string; nodeId: string; imageId?: string; kind: "image" | "video"; prompt?: string; model?: string }) {
    return createGenerationJob({ ...input, status: "pending" });
}

type ApplyNodes = (updater: (prev: CanvasNodeData[]) => CanvasNodeData[]) => void;
type CommitNodes = (updater: (prev: CanvasNodeData[]) => CanvasNodeData[]) => Promise<void>;
class TerminalGenerationError extends Error {}

/** 打开画布后续跑有 remoteTask 的订单 */
export async function resumeCanvasGenerationJobs(options: {
    projectId: string;
    config: AiConfig;
    nodes: CanvasNodeData[];
    setNodes: ApplyNodes;
    commitNodes: CommitNodes;
    signal?: AbortSignal;
    activeJobIds: Set<string>;
    onGenerationSuccess?: (info: { nodeId: string; kind: "image" | "video" }) => void;
    onGenerationFailure?: (info: { nodeId: string; kind: "image" | "video"; error: string }) => void;
}) {
    const jobs = await listResumableJobs(options.projectId);
    for (const job of jobs) {
        if (options.activeJobIds.has(job.id)) continue;
        if (!options.nodes.some((node) => node.id === job.nodeId)) {
            await patchGenerationJob(job.id, { status: "failed", error: "node-missing" });
            continue;
        }
        options.activeJobIds.add(job.id);
        await patchGenerationJob(job.id, { status: "pending", error: undefined });
        const storyboardJob = options.nodes.some((node) => node.id === job.nodeId && node.metadata?.hidden === true && Boolean(node.metadata.storyboardSourceNodeId));
        const imageProvider = job.remoteTask?.provider === "comfyui" ? "ComfyUI" : "APIMart";
        options.setNodes((prev) =>
            patchNodeGenerationUi(prev, job.nodeId, job.kind === "image" ? { phase: "queued", detail: `正在恢复 ${imageProvider} 任务轮询${job.remoteTask?.id ? ` · ${job.remoteTask.id.slice(-8)}` : ""}`, clearProgress: true } : { phase: "generating" }),
        );
        void runJobPollLoop({ ...options, job }).finally(() => options.activeJobIds.delete(job.id));
    }
    return new Set(jobs.map((job) => job.id));
}

async function runJobPollLoop(options: {
    projectId: string;
    config: AiConfig;
    job: CanvasGenerationJob;
    nodes: CanvasNodeData[];
    setNodes: ApplyNodes;
    commitNodes: CommitNodes;
    signal?: AbortSignal;
    onGenerationSuccess?: (info: { nodeId: string; kind: "image" | "video" }) => void;
    onGenerationFailure?: (info: { nodeId: string; kind: "image" | "video"; error: string }) => void;
}) {
    const { job, setNodes, projectId, signal } = options;
    const task = job.remoteTask;
    const storyboardJob = options.nodes.some((node) => node.id === job.nodeId && node.metadata?.hidden === true && Boolean(node.metadata.storyboardSourceNodeId));
    if (!task) {
        await patchGenerationJob(job.id, { status: "failed", error: "no-remote-task" });
        return;
    }

    try {
        if (job.kind === "video" && !isImageRemoteTask(task)) {
            const generationConfig = buildGenerationConfig(options.config, undefined, "video");
            generationConfig.model = task.model || job.model || generationConfig.model;
            for (;;) {
                if ((await getGenerationJob(job.id))?.status === "stopped") return;
                if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
                let state;
                try {
                    state = await pollVideoGenerationTask(generationConfig, task as VideoGenerationTask, { signal });
                } catch (error) {
                    if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) throw error;
                    await patchGenerationJob(job.id, { status: "pending", error: error instanceof Error ? error.message : "poll-failed" });
                    await delay(5000, signal);
                    continue;
                }
                if ((await getGenerationJob(job.id))?.status === "stopped") return;
                if (state.status === "completed") {
                    const video = await storeGeneratedVideo(state.result).catch(() => null);
                    if (!video) {
                        await delay(5000, signal);
                        continue;
                    }
                    const blob = video.storageKey ? await getMediaBlob(video.storageKey).catch(() => null) : null;
                    if (!video.storageKey || !blob) {
                        await delay(5000, signal);
                        continue;
                    }
                    if (blob) await writeGeneratedBlob(projectId, "video", blob, "mp4", video.storageKey).catch(() => false);
                    await options.commitNodes((prev) => {
                        const previous = prev.find(item => item.id === job.nodeId);
                        const replaced = Boolean(previous?.metadata?.storageKey && previous.metadata.storageKey !== video.storageKey);
                        const retained = previous ? preservePreviousVideo(prev, previous, video.storageKey) : prev;
                        return retained.map((item) =>
                            item.id === job.nodeId
                                ? (() => {
                                      const size = fitNodeSize(video.width || item.width, video.height || item.height, MEDIA_NODE_LONG_EDGE, MEDIA_NODE_LONG_EDGE);
                                      return {
                                          ...item,
                                          position: {
                                              x: item.position.x + item.width / 2 - size.width / 2,
                                              y: item.position.y + item.height / 2 - size.height / 2,
                                          },
                                          ...size,
                                          metadata: {
                                              ...item.metadata,
                                              ...videoMetadata(video),
                                              ...(previous && replaced ? { videoOrganization: inheritVideoOrganization(previous, prev, job.createdAt) } : {}),
                                              status: "success" as const,
                                              errorDetails: undefined,
                                              generationJobId: undefined,
                                              generationPhase: undefined,
                                              generationProgress: undefined,
                                              generationDurationMs: Date.now() - job.createdAt,
                                          },
                                      };
                                  })()
                                : item,
                        );
                    });
                    await patchGenerationJob(job.id, { status: "done" });
                    options.onGenerationSuccess?.({ nodeId: job.nodeId, kind: "video" });
                    return;
                }
                if (state.status === "failed") throw new TerminalGenerationError(state.error);
                if (typeof state.progress === "number") setNodes((prev) => patchNodeGenerationUi(prev, job.nodeId, { phase: "generating", progress: state.progress }));
                await delay(task.provider === "seedance" || task.provider === "feimiao" || task.provider === "runninghub" ? 5000 : 2500, signal);
            }
        }

        if (job.kind === "image" && isImageRemoteTask(task)) {
            const generationConfig = buildGenerationConfig(options.config, undefined, "image");
            const requestConfig = resolveModelRequestConfig(generationConfig, job.model || task.model || generationConfig.model);
            for (let attempt = 0; attempt < 240; attempt += 1) {
                if ((await getGenerationJob(job.id))?.status === "stopped") return;
                if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
                const state = await (task.provider === "comfyui" ? pollComfyUiImageTaskOnce : pollApimartImageTaskOnce)(requestConfig, task.id, {
                    signal,
                    ...(task.provider === "comfyui" ? { inputSnapshot: task.inputSnapshot } : {}),
                    onTaskState: ({ stage, progress }) => {
                        if (stage === "downloading") setNodes((prev) => patchNodeGenerationUi(prev, job.nodeId, { phase: "downloading", detail: `${storyboardJob ? "故事板" : "图片"}已生成，正在下载结果`, progress: 100 }));
                    },
                });
                if ((await getGenerationJob(job.id))?.status === "stopped") return;
                if (state.status === "completed") {
                    setNodes((prev) => patchNodeGenerationUi(prev, job.nodeId, { phase: "saving", detail: `正在保存${storyboardJob ? "故事板" : "图片"}到画布与本地目录`, progress: 100 }));
                    const first = state.images[0];
                    if (!first) throw new Error("no-image");
                    const uploaded = await uploadImage(first.dataUrl);
                    const blob = uploaded.storageKey ? await getImageBlob(uploaded.storageKey).catch(() => null) : null;
                    if (blob) await writeGeneratedBlob(projectId, "image", blob, "png", uploaded.storageKey).catch(() => false);
                    await options.commitNodes((prev) =>
                        prev.map((item) => {
                            if (item.id !== job.nodeId) return item;
                            if (item.type === CanvasNodeType.Image && job.imageId && item.metadata?.images?.length) {
                                const images = item.metadata.images.map((image) =>
                                    image.id === job.imageId
                                        ? {
                                              ...image,
                                              status: "success" as const,
                                              content: uploaded.url,
                                              storageKey: uploaded.storageKey,
                                              naturalWidth: uploaded.width,
                                              naturalHeight: uploaded.height,
                                              bytes: uploaded.bytes,
                                              mimeType: uploaded.mimeType,
                                              generationDurationMs: Date.now() - job.createdAt,
                                              errorDetails: undefined,
                                          }
                                        : image,
                                );
                                const allDone = images.every((image) => image.status === "success" || image.status === "error");
                                const primary = images.find((image) => image.status === "success") || images[0];
                                return {
                                    ...item,
                                    metadata: {
                                        ...item.metadata,
                                        images,
                                        status: allDone ? (images.some((image) => image.status === "success") ? "success" : "error") : "loading",
                                        content: primary?.content || item.metadata?.content,
                                        storageKey: primary?.storageKey || item.metadata?.storageKey,
                                        naturalWidth: primary?.naturalWidth || item.metadata?.naturalWidth,
                                        naturalHeight: primary?.naturalHeight || item.metadata?.naturalHeight,
                                        bytes: primary?.bytes || item.metadata?.bytes,
                                        mimeType: primary?.mimeType || item.metadata?.mimeType,
                                        primaryImageId: primary?.id,
                                        generationDurationMs: primary?.generationDurationMs || item.metadata?.generationDurationMs,
                                        generationJobId: allDone ? undefined : item.metadata?.generationJobId,
                                        generationPhase: allDone ? undefined : item.metadata?.generationPhase,
                                        generationDetail: allDone ? undefined : item.metadata?.generationDetail,
                                        generationPhaseStartedAt: allDone ? undefined : item.metadata?.generationPhaseStartedAt,
                                        generationFailedPhase: allDone ? undefined : item.metadata?.generationFailedPhase,
                                        generationProgress: allDone ? undefined : item.metadata?.generationProgress,
                                        errorDetails: undefined,
                                    },
                                };
                            }
                            const size = item.metadata?.freeResize ? { width: item.width, height: item.height } : fitNodeSize(uploaded.width, uploaded.height, MEDIA_NODE_LONG_EDGE, MEDIA_NODE_LONG_EDGE);
                            return {
                                ...item,
                                position: {
                                    x: item.position.x + item.width / 2 - size.width / 2,
                                    y: item.position.y + item.height / 2 - size.height / 2,
                                },
                                ...size,
                                metadata: {
                                    ...item.metadata,
                                    content: uploaded.url,
                                    storageKey: uploaded.storageKey,
                                    status: "success",
                                    errorDetails: undefined,
                                    generationJobId: undefined,
                                    generationPhase: undefined,
                                    generationDetail: undefined,
                                    generationPhaseStartedAt: undefined,
                                    generationFailedPhase: undefined,
                                    generationProgress: undefined,
                                    naturalWidth: uploaded.width,
                                    naturalHeight: uploaded.height,
                                    bytes: uploaded.bytes,
                                    mimeType: uploaded.mimeType,
                                    generationDurationMs: Date.now() - job.createdAt,
                                },
                            };
                        }),
                    );
                    await patchGenerationJob(job.id, {
                        status: "done",
                        resultUrls: "sourceUrl" in first && typeof first.sourceUrl === "string" ? [first.sourceUrl] : undefined,
                    });
                    options.onGenerationSuccess?.({ nodeId: job.nodeId, kind: "image" });
                    return;
                }
                const queued = !state.providerStatus || state.providerStatus === "submitted" || state.providerStatus === "pending" || state.providerStatus === "queued";
                const provider = task.provider === "comfyui" ? "ComfyUI" : "APIMart";
                setNodes((prev) =>
                    patchNodeGenerationUi(prev, job.nodeId, {
                        phase: queued ? "queued" : "generating",
                        detail: `${provider} ${queued ? "排队中" : "正在生成"} · ${task.id.slice(-8)} · 第 ${attempt + 1} 次查询`,
                        progress: state.progress,
                        clearProgress: typeof state.progress !== "number",
                    }),
                );
                await delay(2500, signal);
            }
            await patchGenerationJob(job.id, { status: "pending", error: "poll-timeout" });
            return;
        }

        await patchGenerationJob(job.id, { status: "failed", error: "unsupported-task" });
    } catch (error) {
        if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
            // 页面关闭/切换只终止本页轮询，订单继续保持 pending，供下次打开恢复。
            return;
        }
        const message = error instanceof Error ? error.message : "failed";
        if (job.kind === "video" && !(error instanceof TerminalGenerationError)) {
            await patchGenerationJob(job.id, { status: "pending", error: message });
            return;
        }
        await patchGenerationJob(job.id, { status: "failed", error: message });
        setNodes((prev) =>
            prev.map((item) =>
                item.id === job.nodeId
                    ? {
                          ...item,
                          metadata: {
                              ...item.metadata,
                              status: "error",
                              errorDetails: message,
                              generationJobId: undefined,
                              generationFailedPhase: item.metadata?.generationPhase,
                              generationPhase: undefined,
                              generationProgress: undefined,
                              images: item.metadata?.images?.map((image) => (job.imageId && image.id === job.imageId ? { ...image, status: "error" as const, errorDetails: message } : image)),
                          },
                      }
                    : item,
            ),
        );
        options.onGenerationFailure?.({ nodeId: job.nodeId, kind: job.kind, error: message });
    }
}

/**
 * 画布生成订单：本地清单 + 远程 taskId。
 * 有远程 ID 才可 resume；无 ID 标失败且不重提（防双计费）。
 */
import localforage from "localforage";
import { nanoid } from "nanoid";

import type { VideoGenerationTask } from "@/services/api/video";
import type { ImageGenerationTask } from "@/services/api/image";
export type { ImageGenerationTask } from "@/services/api/image";

export type CanvasGenerationRemoteTask = VideoGenerationTask | ImageGenerationTask;

export type CanvasGenerationJob = {
    id: string;
    projectId: string;
    nodeId: string;
    /** 多图时对应 images[] 项 */
    imageId?: string;
    kind: "image" | "video";
    status: "pending" | "done" | "failed" | "stopped";
    createdAt: number;
    updatedAt: number;
    prompt?: string;
    model?: string;
    submittedAt?: number;
    workflowId?: string;
    inputSnapshot?: Record<string, unknown>;
    resultUrls?: string[];
    remoteTask?: CanvasGenerationRemoteTask;
    error?: string;
};

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "generation_jobs" });
const INDEX_KEY = "__index__";

async function readIndex(): Promise<string[]> {
    const ids = await store.getItem<string[]>(INDEX_KEY);
    return Array.isArray(ids) ? ids : [];
}

async function writeIndex(ids: string[]) {
    await store.setItem(INDEX_KEY, ids);
}

export async function listGenerationJobs(): Promise<CanvasGenerationJob[]> {
    const ids = await readIndex();
    const jobs = await Promise.all(ids.map((id) => store.getItem<CanvasGenerationJob>(id)));
    return jobs.filter((job): job is CanvasGenerationJob => Boolean(job));
}

export async function getGenerationJob(id: string) {
    return store.getItem<CanvasGenerationJob>(id);
}

export async function upsertGenerationJob(job: CanvasGenerationJob) {
    const ids = await readIndex();
    if (!ids.includes(job.id)) await writeIndex([job.id, ...ids].slice(0, 200));
    await store.setItem(job.id, { ...job, updatedAt: Date.now() });
    return job;
}

export async function createGenerationJob(input: Omit<CanvasGenerationJob, "id" | "createdAt" | "updatedAt" | "status"> & { status?: CanvasGenerationJob["status"] }) {
    const now = Date.now();
    const job: CanvasGenerationJob = {
        ...input,
        id: nanoid(),
        status: input.status || "pending",
        createdAt: now,
        updatedAt: now,
    };
    await upsertGenerationJob(job);
    return job;
}

export async function patchGenerationJob(id: string, patch: Partial<CanvasGenerationJob>) {
    const current = await getGenerationJob(id);
    if (!current) return null;
    const next = { ...current, ...patch, id: current.id, updatedAt: Date.now() };
    await upsertGenerationJob(next);
    return next;
}

export async function listResumableJobs(projectId?: string) {
    const jobs = await listGenerationJobs();
    return jobs.filter((job) => Boolean(job.remoteTask) && (job.status === "pending" || (job.status === "failed" && ["Request failed with status code 400", "Failed to fetch"].includes(job.error || ""))) && (!projectId || job.projectId === projectId));
}

export async function markJobsStoppedForNodes(nodeIds: Iterable<string>) {
    const idSet = new Set(nodeIds);
    const jobs = await listGenerationJobs();
    await Promise.all(jobs.filter((job) => (job.status === "pending" || job.status === "failed") && idSet.has(job.nodeId)).map((job) => upsertGenerationJob({ ...job, status: "stopped", updatedAt: Date.now(), error: "stopped" })));
}

export function isImageRemoteTask(task: CanvasGenerationRemoteTask): task is ImageGenerationTask {
    return task.provider === "apimart" || task.provider === "comfyui" || task.provider === "feimiao";
}

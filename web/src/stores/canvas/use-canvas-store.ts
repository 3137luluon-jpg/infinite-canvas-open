import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { importedCanvasTitle } from "@/lib/canvas/canvas-import-title";
import i18n from "@/i18n";
import { createCanvasWorkerPersist } from "@/lib/canvas/canvas-worker-persist";
import { canvasPersistWeight, createSafeJsonPersistStorage } from "@/lib/safe-json-persist";
import { repairCinePackVideoPrompts } from "@/lib/canvas/cinepack-video-prompt";
import type { CanvasBackgroundMode } from "@/lib/canvas-theme";
import type { CanvasFolderLabels } from "@/lib/canvas/canvas-local-folders";
import type { CanvasAssistantSession, CanvasConnection, CanvasNodeData, ViewportTransform } from "@/types/canvas";

export type CanvasProject = {
    id: string;
    cineflowProjectId?: string;
    title: string;
    createdAt: string;
    updatedAt: string;
    nodes: CanvasNodeData[];
    connections: CanvasConnection[];
    chatSessions: CanvasAssistantSession[];
    activeChatId: string | null;
    backgroundMode: CanvasBackgroundMode;
    showImageInfo: boolean;
    viewport: ViewportTransform;
    /** 本地目录显示名（句柄存在 IndexedDB，见 canvas-local-folders） */
    localFolderLabels?: CanvasFolderLabels;
};

type CanvasStore = {
    hydrated: boolean;
    recoveredFromBackup: boolean;
    projects: CanvasProject[];
    createProject: (title?: string, cineflowProjectId?: string) => string;
    importProject: (project: Partial<CanvasProject>) => string;
    openProject: (id: string) => CanvasProject | null;
    renameProject: (id: string, title: string) => boolean;
    deleteProjects: (ids: string[]) => void;
    replaceProjects: (projects: CanvasProject[]) => void;
    updateProject: (id: string, patch: Partial<Pick<CanvasProject, "nodes" | "connections" | "chatSessions" | "activeChatId" | "backgroundMode" | "showImageInfo" | "viewport" | "localFolderLabels">>) => void;
    flushPersist: () => Promise<void>;
    flushPersistSnapshot: () => Promise<void>;
    getPersistDiagnostics: () => unknown;
};

const initialViewport: ViewportTransform = { x: 0, y: 0, k: 1 };
export const CANVAS_STORE_KEY = "infinite-canvas:canvas_store";

const legacyPersist = createSafeJsonPersistStorage({ key: CANVAS_STORE_KEY, weightOf: canvasPersistWeight, debounceMs: 250 });
const safePersist = (() => {
    if (typeof Worker === "undefined") return legacyPersist;
    try {
        return createCanvasWorkerPersist({
            key: CANVAS_STORE_KEY,
            worker: new Worker(new URL("../../lib/canvas/canvas-persist.worker.ts", import.meta.url), { type: "module" }),
            fallback: legacyPersist,
            debounceMs: 250,
        });
    } catch { return legacyPersist; }
})();

let lastQueuedProjects: CanvasProject[] | undefined;
const canvasStorage: PersistStorage<CanvasStore> = {
    getItem: async (name) => {
        const value = await safePersist.storage.getItem(name);
        if (!value) return null;
        const parsed = JSON.parse(value) as StorageValue<CanvasStore>;
        if (Array.isArray(parsed.state?.projects)) parsed.state.projects = repairCinePackVideoPrompts(parsed.state.projects);
        return parsed;
    },
    setItem: async (name, value) => {
        const nextState = value.state as Pick<CanvasStore, "projects">;
        if (!Array.isArray(nextState.projects)) return;
        if (nextState.projects === lastQueuedProjects) return;
        lastQueuedProjects = nextState.projects;
        if ("enqueueState" in safePersist) safePersist.enqueueState(value);
        else safePersist.enqueueSnapshot(() => JSON.stringify(value));
    },
    removeItem: (name) => {
        lastQueuedProjects = undefined;
        return safePersist.storage.removeItem(name);
    },
};

function scheduleFlush() {
    queueMicrotask(() => {
        void safePersist.flush().catch(() => undefined);
    });
}

function projectTitleExists(projects: CanvasProject[], title: string, excludeId?: string) {
    const normalized = title.trim().toLocaleLowerCase();
    return projects.some((project) => project.id !== excludeId && project.title.trim().toLocaleLowerCase() === normalized);
}

function nextDefaultProjectTitle(projects: CanvasProject[]) {
    let count = projects.length + 1;
    let title = i18n.t("canvas.defaultTitle", { count });
    while (projectTitleExists(projects, title)) title = i18n.t("canvas.defaultTitle", { count: ++count });
    return title;
}

export const useCanvasStore = create<CanvasStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            recoveredFromBackup: false,
            projects: [],
            createProject: (title, cineflowProjectId) => {
                const now = new Date().toISOString();
                const id = nanoid();
                const requestedTitle = title?.trim();
                const project: CanvasProject = {
                    id,
                    ...(cineflowProjectId ? { cineflowProjectId } : {}),
                    title: requestedTitle || "",
                    createdAt: now,
                    updatedAt: now,
                    nodes: [],
                    connections: [],
                    chatSessions: [],
                    activeChatId: null,
                    backgroundMode: "lines",
                    showImageInfo: false,
                    viewport: initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                scheduleFlush();
                return id;
            },
            importProject: (source) => {
                const now = new Date().toISOString();
                const requestedTitle = source.title?.trim();
                const project: CanvasProject = {
                    id: nanoid(),
                    title: importedCanvasTitle(requestedTitle, get().projects.map(project => project.title), nextDefaultProjectTitle(get().projects)),
                    createdAt: source.createdAt || now,
                    updatedAt: now,
                    nodes: source.nodes || [],
                    connections: source.connections || [],
                    chatSessions: source.chatSessions || [],
                    activeChatId: source.activeChatId || null,
                    backgroundMode: source.backgroundMode || "lines",
                    showImageInfo: source.showImageInfo || false,
                    viewport: source.viewport || initialViewport,
                };
                set((state) => ({ projects: [project, ...state.projects] }));
                scheduleFlush();
                return project.id;
            },
            openProject: (id) => {
                return get().projects.find((item) => item.id === id) || null;
            },
            renameProject: (id, title) => {
                const nextTitle = title.trim();
                if (!get().projects.some((project) => project.id === id) || (nextTitle && projectTitleExists(get().projects, nextTitle, id))) return false;
                set((state) => ({
                    projects: state.projects.map((project) => (project.id === id ? { ...project, title: nextTitle, updatedAt: new Date().toISOString() } : project)),
                }));
                scheduleFlush();
                return true;
            },
            deleteProjects: (ids) => {
                const next = get().projects.filter((project) => !ids.includes(project.id));
                if (next.length === 0 && get().projects.length > 0) {
                    safePersist.allowNextEmptyWrite();
                }
                set({ projects: next });
                scheduleFlush();
            },
            replaceProjects: (projects) => {
                if (projects.length === 0 && get().projects.length > 0) {
                    safePersist.allowNextEmptyWrite();
                }
                set({ projects });
                scheduleFlush();
            },
            updateProject: (id, patch) =>
                set((state) => {
                    const project = state.projects.find(item => item.id === id);
                    if (!project || Object.entries(patch).every(([key, value]) => {
                        if (key === "viewport" && value && project.viewport) {
                            const next = value as ViewportTransform;
                            return next.x === project.viewport.x && next.y === project.viewport.y && next.k === project.viewport.k;
                        }
                        return Object.is(project[key as keyof CanvasProject], value);
                    })) return state;
                    return { projects: state.projects.map(item => item.id === id ? { ...item, ...patch, updatedAt: new Date().toISOString() } : item) };
                }),
            flushPersist: () => safePersist.flush(),
            flushPersistSnapshot: () => safePersist.flushSnapshot(),
            getPersistDiagnostics: () => "getDiagnostics" in safePersist ? safePersist.getDiagnostics() : {transport:"legacy"},
        }),
        {
            name: CANVAS_STORE_KEY,
            storage: canvasStorage,
            partialize: (state) =>
                ({
                    projects: state.projects,
                }) as StorageValue<CanvasStore>["state"],
            onRehydrateStorage: () => (_state, _error) => {
                safePersist.markReady();
                const recovery = safePersist.getLastRecovery();
                useCanvasStore.setState({
                    hydrated: true,
                    recoveredFromBackup: Boolean(recovery?.recovered),
                });
                // 水合完成后立刻再刷一次，确保内存态与双备份一致
                void safePersist.flush().catch(() => undefined);
            },
        },
    ),
);

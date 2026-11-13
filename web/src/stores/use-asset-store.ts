import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { nanoid } from "nanoid";
import { assetPersistWeight, createSafeJsonPersistStorage } from "@/lib/safe-json-persist";
import { cleanupUnusedImages, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { cleanupUnusedMedia, resolveMediaUrl } from "@/services/file-storage";

export type AssetKind = "text" | "image" | "video" | "audio";
export type AssetType = "character" | "scene" | "prop" | "other";
export type TextAsset = AssetBase<"text"> & { data: { content: string } };
export type ImageAsset = AssetBase<"image"> & { data: { dataUrl: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type VideoAsset = AssetBase<"video"> & { data: { url: string; storageKey?: string; width: number; height: number; bytes: number; mimeType: string } };
export type AudioAsset = AssetBase<"audio"> & { data: { url: string; storageKey?: string; durationMs?: number; bytes: number; mimeType: string } };
export type Asset = TextAsset | ImageAsset | VideoAsset | AudioAsset;

type AssetBase<T extends AssetKind> = {
    id: string;
    kind: T;
    title: string;
    /** 视觉资产分类，与底层媒体 kind 无关。 */
    assetType?: AssetType;
    /** 用户自定义的项目归类字符串，与画布 projectId 无关。 */
    projectId?: string;
    coverUrl: string;
    tags: string[];
    source?: string;
    note?: string;
    createdAt: string;
    updatedAt: string;
    metadata?: Record<string, unknown>;
};

type AssetStore = {
    hydrated: boolean;
    assets: Asset[];
    projects: string[];
    lastProjectId: string;
    addAsset: (asset: Omit<Asset, "id" | "createdAt" | "updatedAt">) => string;
    updateAsset: (id: string, patch: Partial<Omit<Asset, "id" | "createdAt">>) => void;
    removeAsset: (id: string) => void;
    replaceAssets: (assets: Asset[]) => void;
    addProject: (name: string) => void;
    setLastProjectId: (name: string) => void;
    removeProject: (name: string) => void;
    cleanupImages: (extra?: unknown) => void;
    flushPersist: () => Promise<void>;
};

export const ASSET_STORE_KEY = "infinite-canvas:asset_store";

const safePersist = createSafeJsonPersistStorage({
    key: ASSET_STORE_KEY,
    weightOf: assetPersistWeight,
    debounceMs: 250,
});

function scheduleFlush() {
    queueMicrotask(() => {
        void safePersist.flush();
    });
}

function normalizeProjectName(name?: string) {
    const next = name?.trim() || "";
    return next === "无" || next === "未归类" ? "" : next;
}

function uniqueProjects(values: Array<string | undefined>) {
    return Array.from(new Set(values.map(normalizeProjectName).filter(Boolean)));
}

function normalizeAsset(asset: Asset): Asset {
    return { ...asset, assetType: asset.assetType || "other", projectId: normalizeProjectName(asset.projectId) } as Asset;
}

const assetStorage: PersistStorage<AssetStore> = {
    getItem: async (name) => {
        const value = await safePersist.storage.getItem(name);
        if (!value) return null;
        const parsed = JSON.parse(value) as StorageValue<AssetStore>;
        parsed.state.assets = await Promise.all(
            (parsed.state.assets || []).map(async (asset): Promise<Asset> => {
                asset = normalizeAsset(asset);
                if (asset.kind === "video") {
                    if (!asset.data.storageKey) return asset;
                    return { ...asset, data: { ...asset.data, url: await resolveMediaUrl(asset.data.storageKey, asset.data.url) } };
                }
                if (asset.kind === "audio") {
                    if (!asset.data.storageKey) return asset;
                    return { ...asset, data: { ...asset.data, url: await resolveMediaUrl(asset.data.storageKey, asset.data.url) } };
                }
                if (asset.kind !== "image") return asset;
                if (asset.data.storageKey)
                    return {
                        ...asset,
                        coverUrl: asset.coverUrl.startsWith("blob:") ? await resolveImageUrl(asset.data.storageKey, asset.coverUrl) : asset.coverUrl,
                        data: { ...asset.data, dataUrl: await resolveImageUrl(asset.data.storageKey, asset.data.dataUrl) },
                    };
                if (!asset.data.dataUrl.startsWith("data:image/")) return asset;
                const image = await uploadImage(asset.data.dataUrl);
                return { ...asset, coverUrl: asset.coverUrl.startsWith("data:image/") ? image.url : asset.coverUrl, data: { ...asset.data, dataUrl: image.url, storageKey: image.storageKey, bytes: image.bytes, mimeType: image.mimeType } };
            }),
        );
        parsed.state.projects = uniqueProjects([...(parsed.state.projects || []), ...parsed.state.assets.map((asset) => asset.projectId)]);
        parsed.state.lastProjectId = normalizeProjectName(parsed.state.lastProjectId);
        return parsed;
    },
    setItem: async (name, value) => {
        if (!Array.isArray(value.state.assets)) return;
        await safePersist.storage.setItem(name, JSON.stringify(value));
    },
    removeItem: (name) => safePersist.storage.removeItem(name),
};

export const useAssetStore = create<AssetStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            assets: [],
            projects: [],
            lastProjectId: "",
            addAsset: (asset) => {
                const now = new Date().toISOString();
                const id = nanoid();
                const next = normalizeAsset({ ...asset, projectId: normalizeProjectName(asset.projectId) || get().lastProjectId, id, createdAt: now, updatedAt: now } as Asset);
                set((state) => ({ assets: [next, ...state.assets], projects: uniqueProjects([...state.projects, next.projectId]), lastProjectId: next.projectId || state.lastProjectId }));
                scheduleFlush();
                return id;
            },
            updateAsset: (id, patch) => {
                set((state) => ({
                    assets: state.assets.map((asset) => (asset.id === id ? normalizeAsset({ ...asset, ...patch, updatedAt: new Date().toISOString() } as Asset) : asset)),
                    projects: uniqueProjects([...state.projects, typeof patch.projectId === "string" ? patch.projectId : undefined]),
                    lastProjectId: typeof patch.projectId === "string" && normalizeProjectName(patch.projectId) ? normalizeProjectName(patch.projectId) : state.lastProjectId,
                }));
                scheduleFlush();
            },
            removeAsset: (id) => {
                const next = get().assets.filter((asset) => asset.id !== id);
                if (next.length === 0 && get().assets.length > 0) safePersist.allowNextEmptyWrite();
                get().cleanupImages({ assets: next });
                set({ assets: next });
                scheduleFlush();
            },
            replaceAssets: (assets) => {
                if (assets.length === 0 && get().assets.length > 0) safePersist.allowNextEmptyWrite();
                const next = assets.map(normalizeAsset);
                set((state) => ({ assets: next, projects: uniqueProjects([...state.projects, ...next.map((asset) => asset.projectId)]) }));
                scheduleFlush();
            },
            addProject: (name) => {
                const next = normalizeProjectName(name);
                if (!next) return;
                set((state) => ({ projects: uniqueProjects([...state.projects, next]) }));
                scheduleFlush();
            },
            setLastProjectId: (name) => {
                const next = normalizeProjectName(name);
                set({ lastProjectId: next });
                scheduleFlush();
            },
            removeProject: (name) => {
                const target = normalizeProjectName(name);
                if (!target) return;
                set((state) => ({
                    projects: state.projects.filter((project) => project !== target),
                    assets: state.assets.map((asset) => (asset.projectId === target ? { ...asset, projectId: "", updatedAt: new Date().toISOString() } : asset)),
                    lastProjectId: state.lastProjectId === target ? "" : state.lastProjectId,
                }));
                scheduleFlush();
            },
            cleanupImages: (extra) => {
                window.setTimeout(async () => {
                    const { useCanvasStore } = await import("@/stores/canvas/use-canvas-store");
                    const { useBoardStore } = await import("@/stores/board/use-board-store");
                    const used = { assets: get().assets, projects: useCanvasStore.getState().projects, boards: useBoardStore.getState().boards, extra };
                    await cleanupUnusedImages(used);
                    await cleanupUnusedMedia(used);
                }, 0);
            },
            flushPersist: () => safePersist.flush(),
        }),
        {
            name: ASSET_STORE_KEY,
            storage: assetStorage,
            partialize: (state) => ({ assets: state.assets, projects: state.projects, lastProjectId: state.lastProjectId }) as StorageValue<AssetStore>["state"],
            onRehydrateStorage: () => () => {
                safePersist.markReady();
                useAssetStore.setState({ hydrated: true });
                void safePersist.flush();
            },
        },
    ),
);

import { nanoid } from "nanoid";
import { create } from "zustand";
import { persist, type PersistStorage, type StorageValue } from "zustand/middleware";

import { createSafeJsonPersistStorage } from "@/lib/safe-json-persist";
import type { BoardProject, BoardShot, BoardVideo } from "@/types/board";

type BoardStore = {
    hydrated: boolean;
    boards: BoardProject[];
    createBoard: (title?: string) => string;
    renameBoard: (id: string, title: string) => boolean;
    deleteBoards: (ids: string[]) => void;
    updateBoard: (id: string, updater: (board: BoardProject) => BoardProject) => void;
    flushPersist: () => Promise<void>;
};

export const BOARD_STORE_KEY = "infinite-canvas:board_store";

function weightOf(raw: string | null) {
    if (!raw) return 0;
    try {
        const boards = (JSON.parse(raw) as { state?: { boards?: BoardProject[] } }).state?.boards;
        return Array.isArray(boards) ? boards.length * 1000 + boards.reduce((sum, board) => sum + board.shots.length, 0) : 0;
    } catch {
        return 0;
    }
}

const safePersist = createSafeJsonPersistStorage({ key: BOARD_STORE_KEY, weightOf, debounceMs: 250 });
const storage: PersistStorage<BoardStore> = {
    getItem: async (name) => {
        const value = await safePersist.storage.getItem(name);
        return value ? (JSON.parse(value) as StorageValue<BoardStore>) : null;
    },
    setItem: async (name, value) => {
        if (Array.isArray(value.state.boards)) await safePersist.storage.setItem(name, JSON.stringify(value));
    },
    removeItem: (name) => safePersist.storage.removeItem(name),
};

function now() {
    return new Date().toISOString();
}

export function createBoardVideo(source?: Partial<BoardVideo>): BoardVideo {
    const timestamp = now();
    return {
        id: nanoid(),
        prompt: "",
        status: "idle",
        references: [],
        storyboards: [],
        createdAt: timestamp,
        updatedAt: timestamp,
        ...source,
    };
}

export function createBoardShot(index: number): BoardShot {
    const timestamp = now();
    const video = createBoardVideo();
    return { id: nanoid(), title: `分镜${index}`, videos: [video], selectedVideoId: video.id, defaultVideoId: video.id, lastViewedAt: timestamp, createdAt: timestamp, updatedAt: timestamp };
}

function uniqueTitle(boards: BoardProject[], requested?: string, excludeId?: string) {
    const taken = (title: string) => boards.some((board) => board.id !== excludeId && board.title.trim().toLocaleLowerCase() === title.trim().toLocaleLowerCase());
    const preferred = requested?.trim();
    if (preferred && !taken(preferred)) return preferred;
    let index = boards.length + 1;
    while (taken(`Kin's Board ${index}`)) index += 1;
    return `Kin's Board ${index}`;
}

function flushSoon() {
    queueMicrotask(() => void safePersist.flush());
}

export const useBoardStore = create<BoardStore>()(
    persist(
        (set, get) => ({
            hydrated: false,
            boards: [],
            createBoard: (title) => {
                const timestamp = now();
                const id = nanoid();
                const shot = createBoardShot(1);
                const board: BoardProject = { id, title: uniqueTitle(get().boards, title), shots: [shot], activeShotId: shot.id, createdAt: timestamp, updatedAt: timestamp };
                set((state) => ({ boards: [board, ...state.boards] }));
                flushSoon();
                return id;
            },
            renameBoard: (id, title) => {
                const nextTitle = title.trim();
                if (!nextTitle || uniqueTitle(get().boards, nextTitle, id) !== nextTitle) return false;
                set((state) => ({ boards: state.boards.map((board) => (board.id === id ? { ...board, title: nextTitle, updatedAt: now() } : board)) }));
                flushSoon();
                return true;
            },
            deleteBoards: (ids) => {
                const next = get().boards.filter((board) => !ids.includes(board.id));
                if (!next.length && get().boards.length) safePersist.allowNextEmptyWrite();
                set({ boards: next });
                flushSoon();
            },
            updateBoard: (id, updater) => {
                set((state) => ({ boards: state.boards.map((board) => (board.id === id ? { ...updater(board), updatedAt: now() } : board)) }));
                flushSoon();
            },
            flushPersist: () => safePersist.flush(),
        }),
        {
            name: BOARD_STORE_KEY,
            storage,
            partialize: (state) => ({ boards: state.boards }) as StorageValue<BoardStore>["state"],
            onRehydrateStorage: () => () => {
                safePersist.markReady();
                useBoardStore.setState({ hydrated: true });
                void safePersist.flush();
            },
        },
    ),
);

import localforage from "localforage";
import type { StateStorage } from "zustand/middleware";
import { clearPersistError, reportPersistError } from "./persist-health.ts";

localforage.config({
    name: "infinite-canvas",
    storeName: "app_state",
});

export const localForageStorage: StateStorage = {
    getItem: async (name) => {
        if (typeof window === "undefined") return null;
        try {
            return (await localforage.getItem<string>(name)) || null;
        } catch (error) {
            reportPersistError(`${name}:database`, new Error("浏览器数据库读取失败，请备份后检查存储"));
            const fallback = window.localStorage.getItem(name);
            if (fallback) return fallback;
            throw error;
        }
    },
    setItem: async (name, value) => {
        if (typeof window === "undefined") return;
        try {
            await localforage.setItem(name, value);
            clearPersistError(`${name}:database`);
        } catch {
            reportPersistError(`${name}:database`, new Error("数据库写入失败，当前仅尝试浏览器备用存储，请立即导出硬盘备份"));
            window.localStorage.setItem(name, value);
        }
    },
    removeItem: async (name) => {
        if (typeof window === "undefined") return;
        try {
            await localforage.removeItem(name);
        } catch {
            window.localStorage.removeItem(name);
        }
    },
};

import localforage from "localforage";

import { nanoid } from "nanoid";
import i18n from "@/i18n";
import { readImageMeta } from "@/lib/image-utils";
import { withMediaBackupMutation } from "./media-backup-revision";

export type UploadedImage = {
    url: string;
    storageKey: string;
    width: number;
    height: number;
    bytes: number;
    mimeType: string;
};

const store = localforage.createInstance({ name: "infinite-canvas", storeName: "image_files" });
const imageLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "image_generation_logs" });
const videoLogStore = localforage.createInstance({ name: "infinite-canvas", storeName: "video_generation_logs" });
const objectUrls = new Map<string, string>();

export async function uploadImage(input: string | Blob): Promise<UploadedImage> {
    if (typeof input === "string" && /^https?:\/\//i.test(input)) {
        try {
            const blob = await fetchRemoteImageBlob(input);
            return persistImageBlob(blob);
        } catch {
            // 远程图可先展示；失效前用户仍能看到成功结果，避免任务已成功却显示整单失败
            const meta = await readImageMeta(input);
            const storageKey = `image:${nanoid()}`;
            await withMediaBackupMutation(storageKey, () => store.setItem(storageKey, input), false);
            objectUrls.set(storageKey, input);
            return { url: input, storageKey, width: meta.width, height: meta.height, bytes: 0, mimeType: meta.mimeType };
        }
    }
    const blob = typeof input === "string" ? await (await fetch(input)).blob() : input;
    return persistImageBlob(blob);
}

async function persistImageBlob(blob: Blob): Promise<UploadedImage> {
    const url = URL.createObjectURL(blob);
    try {
        const meta = await readImageMeta(url);
        const storageKey = `image:${nanoid()}`;
        await withMediaBackupMutation(storageKey, () => store.setItem(storageKey, blob));
        objectUrls.set(storageKey, url);
        return { url, storageKey, width: meta.width, height: meta.height, bytes: blob.size, mimeType: blob.type || meta.mimeType };
    } catch (error) {
        URL.revokeObjectURL(url);
        throw error;
    }
}

export async function resolveImageUrl(storageKey?: string, fallback = "") {
    if (!storageKey) return fallback;
    const cached = objectUrls.get(storageKey);
    if (cached) return cached;
    const stored = await store.getItem<Blob | string>(storageKey);
    if (!stored) return fallback;
    if (typeof stored === "string") {
        objectUrls.set(storageKey, stored);
        return stored;
    }
    const url = URL.createObjectURL(stored);
    objectUrls.set(storageKey, url);
    return url;
}

export async function getImageBlob(storageKey: string) {
    const stored = await store.getItem<Blob | string>(storageKey);
    if (!stored) return null;
    if (typeof stored === "string") {
        if (stored.startsWith("data:")) return (await fetch(stored)).blob();
        if (/^https?:\/\//i.test(stored)) return fetchRemoteImageBlob(stored);
        return null;
    }
    return stored;
}

export async function setImageBlob(storageKey: string, blob: Blob) {
    await withMediaBackupMutation(storageKey, () => store.setItem(storageKey, blob));
    const url = URL.createObjectURL(blob);
    objectUrls.set(storageKey, url);
    return url;
}

export async function imageToDataUrl(image: { url?: string; dataUrl?: string; storageKey?: string }) {
    const url = image.dataUrl || (await resolveImageUrl(image.storageKey, image.url || ""));
    if (!url || url.startsWith("data:")) return url;
    return blobToDataUrl(await (await fetch(url)).blob());
}

export async function deleteStoredImages(keys: Iterable<string>) {
    await Promise.all(
        Array.from(new Set(keys)).map(async (key) => {
            const url = objectUrls.get(key);
            if (url) URL.revokeObjectURL(url);
            objectUrls.delete(key);
            await withMediaBackupMutation(key, () => store.removeItem(key), false);
        }),
    );
}

export async function cleanupUnusedImages(usedData: unknown) {
    const usedKeys = collectImageStorageKeys(usedData);
    await Promise.all([
        imageLogStore.iterate((value) => {
            collectImageStorageKeys(value, usedKeys);
        }),
        videoLogStore.iterate((value) => {
            collectImageStorageKeys(value, usedKeys);
        }),
    ]);
    const unused: string[] = [];
    await store.iterate((_value, key) => {
        if (!usedKeys.has(key)) unused.push(key);
    });
    await deleteStoredImages(unused);
}

export function collectImageStorageKeys(value: unknown, keys = new Set<string>()) {
    if (!value || typeof value !== "object") return keys;
    if ("storageKey" in value && typeof value.storageKey === "string" && value.storageKey.startsWith("image:")) keys.add(value.storageKey);
    Object.values(value).forEach((item) => (Array.isArray(item) ? item.forEach((child) => collectImageStorageKeys(child, keys)) : collectImageStorageKeys(item, keys)));
    return keys;
}

function blobToDataUrl(blob: Blob) {
    return new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ""));
        reader.onerror = () => reject(new Error(i18n.t("common.imageReadFailed")));
        reader.readAsDataURL(blob);
    });
}

async function fetchRemoteImageBlob(url: string) {
    try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(String(response.status));
        return response.blob();
    } catch {
        const response = await fetch(`/__media-proxy?url=${encodeURIComponent(url)}`);
        if (!response.ok) throw new Error(String(response.status));
        return response.blob();
    }
}

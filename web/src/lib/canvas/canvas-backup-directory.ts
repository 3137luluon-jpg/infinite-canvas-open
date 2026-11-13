import type { CanvasProject } from "../../stores/canvas/use-canvas-store";
import type { BackupIO } from "./canvas-disk-backup-core";

export async function directoryIO(base: FileSystemDirectoryHandle): Promise<BackupIO> {
    async function entry(path: string, create = false) {
        const parts = path.split("/");
        if (parts.some((p) => !p || p === "." || p === ".." || /[\\:]/.test(p))) throw Error("备份路径无效");
        let dir = base;
        for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create });
        return dir.getFileHandle(parts.at(-1)!, { create });
    }
    const read = async (path: string) => {
        try {
            return await (await entry(path)).getFile();
        } catch (e) {
            if ((e as DOMException).name === "NotFoundError") return null;
            throw e;
        }
    };
    return {
        read,
        stat: async (path) => {
            const file = await read(path);
            return file ? { size: file.size, lastModified: file.lastModified } : null;
        },
        write: async (path, blob) => {
            const writer = await (await entry(path, true)).createWritable();
            try {
                await writer.write(blob);
                await writer.close();
            } catch (error) {
                await writer.abort().catch(() => undefined);
                throw error;
            }
        },
    };
}

type ProjectEntry = { id: string; directory: string; ready?: boolean; namingVersion?: 2; sequence?: number; date?: string; renameFrom?: string };
export type DirectoryLock = <T>(name: string, task: () => Promise<T>) => Promise<T>;
const datedDirectory = /^(?:(\d+)_(\d{4}-\d{2}-\d{2})|(\d{4}-\d{2}-\d{2})_(\d+))(?:_[^\\/:]+)?$/;
const directorySequence = (name: string) => {
    const match = datedDirectory.exec(name);
    return Number(match?.[1] ?? match?.[4] ?? /^([0-9]+)_/.exec(name)?.[1] ?? 0);
};
export function projectDirectoryName(sequence: number, date: string, title: string, dateFirst = false) {
    const suffix = title
        .replace(/^(?:\d+_\d{4}-\d{2}-\d{2}|\d{4}-\d{2}-\d{2}_\d+)(?:_|$)/, "")
        .trim()
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")
        .replace(/[. ]+$/g, "")
        .slice(0, 80);
    const number = String(sequence).padStart(3, "0");
    return `${dateFirst ? `${date}_${number}` : `${number}_${date}`}${suffix ? `_${suffix}` : ""}`;
}
function matchesPrefix(name: string, sequence: number, date: string) {
    const prefix = projectDirectoryName(sequence, date, "", name.startsWith(date));
    return name === prefix || name.startsWith(`${prefix}_`);
}
/** Stable ID mapping. Only version-2 managed project folders may be renamed. */
export async function ensureProjectBackupDirectory(root: FileSystemDirectoryHandle, project: Pick<CanvasProject, "id" | "title" | "createdAt">, lock?: DirectoryLock, options?: { dateFirstForNew: boolean; syncTitle: boolean }) {
    const request = lock || (typeof navigator !== "undefined" && navigator.locks ? (((name, task) => navigator.locks.request(name, task)) as DirectoryLock) : undefined);
    if (!request) throw Error("缺少安全目录锁");
    return request("canvas-backup-project-directories", async () => {
        const metadata = await root.getDirectoryHandle("无限画布备份", { create: true });
        const io = await directoryIO(metadata);
        const raw = await io.read("project-directories.json");
        let entries: ProjectEntry[] = [];
        const rawText = raw ? await raw.text() : "";
        if (rawText) {
            const parsed = JSON.parse(rawText);
            if (parsed.version !== 1 || !Array.isArray(parsed.entries)) throw Error("项目目录索引损坏，保留原目录并停止创建");
            entries = parsed.entries;
            const ids = new Set<string>(),
                names = new Set<string>();
            for (const entry of entries) {
                if (!entry || typeof entry.id !== "string" || !entry.id || typeof entry.directory !== "string" || !datedDirectory.test(entry.directory) || ids.has(entry.id) || names.has(entry.directory))
                    throw Error("项目目录索引损坏，停止写入");
                if (entry.namingVersion === 2 && (!Number.isSafeInteger(entry.sequence) || entry.sequence! < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date || "") || !matchesPrefix(entry.directory, entry.sequence!, entry.date!)))
                    throw Error("项目命名记录损坏，停止写入");
                if (entry.renameFrom && (!datedDirectory.test(entry.renameFrom) || entry.namingVersion !== 2)) throw Error("项目改名记录损坏，停止写入");
                ids.add(entry.id);
                names.add(entry.directory);
            }
        }
        const saveIndex = () => io.write("project-directories.json", new Blob([JSON.stringify({ version: 1, entries })]));
        const finishReservation = async (entry: ProjectEntry) => {
            const directory = await root.getDirectoryHandle(entry.directory, { create: entry.ready === false });
            const folderIO = await directoryIO(directory);
            const marker = await folderIO.read("canvas-project.json");
            const text = marker ? await marker.text() : "";
            if (text) {
                if (JSON.parse(text).id !== project.id) throw Error("项目目录归属不符，停止写入");
            } else {
                if (entry.ready !== false) throw Error("项目归属记录缺失，停止写入");
                await folderIO.write("canvas-project.json", new Blob([JSON.stringify({ version: 1, id: project.id, title: project.title, namingVersion: entry.namingVersion, sequence: entry.sequence, date: entry.date })]));
            }
            if (entry.ready === false) {
                entry.ready = true;
                await saveIndex();
            }
            return { directory, name: entry.directory, managed: entry.namingVersion === 2 };
        };
        const found = entries.find((e) => e.id === project.id);
        if (found) {
            // An interrupted initial mkdir/marker write must finish its reserved path
            // before a newer user title can enter the rename journal.
            if (found.ready === false && !found.renameFrom) await finishReservation(found);
            const movable = root as FileSystemDirectoryHandle & { renameDirectory?: (from: string, to: string) => Promise<void> };
            const resumeRename = async () => {
                if (!found.renameFrom || !movable.renameDirectory) throw Error("目录改名尚未完成，保留原目录");
                const exists = async (name: string) => {
                    try {
                        await root.getDirectoryHandle(name);
                        return true;
                    } catch (e) {
                        if ((e as DOMException).name === "NotFoundError") return false;
                        throw e;
                    }
                };
                const oldExists = await exists(found.renameFrom),
                    newExists = await exists(found.directory);
                if (oldExists && newExists) throw Error("改名目标已存在，停止覆盖");
                if (oldExists) {
                    const original = await root.getDirectoryHandle(found.renameFrom);
                    if (JSON.parse(await (await (await original.getFileHandle("canvas-project.json")).getFile()).text()).id !== project.id) throw Error("改名前目录归属错误");
                }
                if (oldExists) await movable.renameDirectory(found.renameFrom, found.directory);
                else if (!newExists) throw Error("改名涉及的目录缺失");
                const folder = await root.getDirectoryHandle(found.directory);
                const marker = await (await folder.getFileHandle("canvas-project.json")).getFile();
                if (JSON.parse(await marker.text()).id !== project.id) throw Error("改名目录归属错误");
                delete found.renameFrom;
                found.ready = true;
                await saveIndex();
            };
            if (found.renameFrom) await resumeRename();
            if (options?.syncTitle !== false && found.namingVersion === 2 && found.sequence && found.date && movable.renameDirectory) {
                const name = projectDirectoryName(found.sequence, found.date, project.title, found.directory.startsWith(found.date));
                if (name !== found.directory) {
                    // Validate availability before committing a recoverable rename intent.
                    try {
                        await root.getDirectoryHandle(name);
                        throw Error("改名目标目录已存在");
                    } catch (e) {
                        if ((e as DOMException).name !== "NotFoundError") throw e;
                    }
                    found.renameFrom = found.directory;
                    found.directory = name;
                    await saveIndex();
                    await resumeRename();
                }
            }
            return finishReservation(found);
        }
        let sequence = Math.max(0, ...entries.map((e) => directorySequence(e.directory)));
        // Only directory names / ownership markers are inspected, never media trees.
        for await (const [name, handle] of (root as unknown as { entries(): AsyncIterableIterator<[string, FileSystemHandle]> }).entries()) {
            sequence = Math.max(sequence, directorySequence(name));
            if (handle.kind !== "directory" || !datedDirectory.test(name)) continue;
            try {
                const folder = handle as FileSystemDirectoryHandle;
                const marker = await (await folder.getFileHandle("canvas-project.json")).getFile();
                const ownership = JSON.parse(await marker.text());
                if (ownership.id === project.id) {
                    if (entries.some((e) => e.directory === name && e.id !== project.id)) throw Error("项目目录已映射给其他画布，停止写入");
                    const managed =
                        ownership.namingVersion === 2 &&
                        Number.isSafeInteger(ownership.sequence) &&
                        ownership.sequence > 0 &&
                        /^\d{4}-\d{2}-\d{2}$/.test(ownership.date || "") &&
                        matchesPrefix(name, ownership.sequence, ownership.date);
                    entries.push({ id: project.id, directory: name, ...(managed ? { namingVersion: 2 as const, sequence: ownership.sequence, date: ownership.date } : {}) });
                    await io.write("project-directories.json", new Blob([JSON.stringify({ version: 1, entries })]));
                    return { directory: folder, name, managed };
                }
            } catch (e) {
                if (!(e instanceof SyntaxError) && (e as DOMException).name !== "NotFoundError") throw e;
            }
        }
        const date = new Date(project.createdAt);
        if (!Number.isSafeInteger(sequence + 1)) throw Error("项目编号超出安全范围");
        if (Number.isNaN(date.valueOf())) throw Error("画布创建日期无效");
        const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
        const stamp = ["year", "month", "day"].map((type) => parts.find((part) => part.type === type)!.value).join("-");
        const name = projectDirectoryName(sequence + 1, stamp, project.title, options?.dateFirstForNew);
        // Reserve ownership atomically before mkdir: interrupted creation retries the same path.
        const reservation: ProjectEntry = { id: project.id, directory: name, ready: false, namingVersion: 2, sequence: sequence + 1, date: stamp };
        entries.push(reservation);
        await saveIndex();
        return finishReservation(reservation);
    });
}

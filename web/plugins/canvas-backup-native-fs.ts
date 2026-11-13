import { lstat, mkdir, open, readdir, realpath, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Transform, type Readable, type Writable } from "node:stream";
import { randomUUID } from "node:crypto";

export const MAX_BACKUP_FILE_BYTES = 8 * 1024 ** 3;

const missing = (e: unknown) => (e as NodeJS.ErrnoException).code === "ENOENT";
const absent = () => new DOMException("文件或目录不存在", "NotFoundError");
function component(value: string) {
    if (!value || value === "." || value === ".." || /[<>:"/\\|?*\x00-\x1f]/.test(value) || /[. ]$/.test(value)) throw Error("备份路径无效");
    return value;
}
function below(root: string, target: string) {
    const rel = relative(root, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw Error("备份路径越界");
}
export class NativeBackupRoot {
    readonly root: string;
    constructor(root: string) {
        this.root = resolve(root);
    }
    async check(path = this.root) {
        below(this.root, path);
        // Check the root and all ancestors too: an E: root junction must not redirect to C:.
        let cursor = resolve(path);
        const chain: string[] = [];
        while (true) {
            chain.unshift(cursor);
            const parent = dirname(cursor);
            if (parent === cursor) break;
            cursor = parent;
        }
        for (const entry of chain) {
            const info = await lstat(entry);
            if (info.isSymbolicLink()) throw Error("备份目录不允许重解析点或符号链接");
            if (resolve(await realpath(entry)).toLowerCase() !== entry.toLowerCase()) throw Error("备份实际路径与配置不符");
        }
        return path;
    }
    async directory() {
        await this.check();
        if (!(await stat(this.root)).isDirectory()) throw Error("备份根不是目录");
        return new NativeDirectory(this, this.root);
    }
    async filePath(base: string, relativePath: string, createParents = false) {
        const parts = relativePath.split("/").map(component);
        let cursor = base;
        await this.check(cursor);
        for (const part of parts.slice(0, -1)) {
            cursor = join(cursor, part);
            if (createParents)
                await mkdir(cursor).catch((e) => {
                    if (e.code !== "EEXIST") throw e;
                });
            await this.check(cursor);
            if (!(await stat(cursor)).isDirectory()) throw Error("备份父路径不是目录");
        }
        const path = join(cursor, parts.at(-1)!);
        below(this.root, path);
        try {
            await this.check(path);
            if (!(await stat(path)).isFile()) throw Error("备份路径不是文件");
        } catch (e) {
            if (!missing(e)) throw e;
        }
        return path;
    }
    async writeStream(path: string, input: Readable, maximum = MAX_BACKUP_FILE_BYTES) {
        await this.check(dirname(path));
        const temporary = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
        let bytes = 0;
        const limit = new Transform({
            transform(chunk, _encoding, callback) {
                bytes += chunk.length;
                callback(bytes > maximum ? Error("备份文件超过8GiB限制") : null, chunk);
            },
        });
        try {
            await pipeline(input, limit, createWriteStream(temporary, { flags: "wx" }));
            const file = await open(temporary, "r+");
            try {
                await file.sync();
            } finally {
                await file.close();
            }
            await this.filePath(dirname(path), basename(path));
            // Same-directory rename publishes only the complete file; old valid bytes survive errors.
            await rename(temporary, path);
        } catch (e) {
            await unlink(temporary).catch(() => undefined);
            throw e;
        }
        return bytes;
    }
    async readStream(path: string, output: Writable) {
        await this.check(path);
        await pipeline(createReadStream(path), output);
    }
}
export class NativeDirectory {
    readonly kind = "directory";
    readonly name: string;
    readonly filesystem: NativeBackupRoot;
    readonly path: string;
    constructor(filesystem: NativeBackupRoot, path: string) {
        this.filesystem = filesystem;
        this.path = path;
        this.name = basename(path);
    }
    async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        const next = join(this.path, component(name));
        await this.filesystem.check(this.path);
        if (options?.create)
            await mkdir(next).catch((e) => {
                if (e.code !== "EEXIST") throw e;
            });
        try {
            await this.filesystem.check(next);
            if (!(await stat(next)).isDirectory()) throw Error("备份目录类型不符");
        } catch (e) {
            if (missing(e)) throw absent();
            throw e;
        }
        return new NativeDirectory(this.filesystem, next);
    }
    async getFileHandle(name: string, options?: { create?: boolean }) {
        const path = await this.filesystem.filePath(this.path, component(name));
        if (options?.create) {
            const handle = await open(path, "a");
            await handle.close();
        }
        try {
            await this.filesystem.check(path);
        } catch (e) {
            if (missing(e)) throw absent();
            throw e;
        }
        return new NativeFile(this.filesystem, path);
    }
    async *entries(): AsyncIterableIterator<[string, NativeDirectory | NativeFile]> {
        await this.filesystem.check(this.path);
        for (const entry of await readdir(this.path, { withFileTypes: true })) {
            if (entry.isSymbolicLink()) throw Error("备份目录含重解析点，停止扫描");
            yield [entry.name, entry.isDirectory() ? new NativeDirectory(this.filesystem, join(this.path, entry.name)) : new NativeFile(this.filesystem, join(this.path, entry.name))];
        }
    }
    async renameDirectory(from: string, to: string) {
        const source = join(this.path, component(from)),
            destination = join(this.path, component(to));
        await this.filesystem.check(source);
        await this.filesystem.check(this.path);
        if (!(await stat(source)).isDirectory()) throw Error("重命名来源不是目录");
        try {
            await lstat(destination);
            throw Error("目标目录已存在，禁止覆盖");
        } catch (e) {
            if (!missing(e)) throw e;
        }
        await rename(source, destination);
    }
}
class NativeFile {
    readonly kind = "file";
    readonly name: string;
    readonly filesystem: NativeBackupRoot;
    readonly path: string;
    constructor(filesystem: NativeBackupRoot, path: string) {
        this.filesystem = filesystem;
        this.path = path;
        this.name = basename(path);
    }
    async getFile() {
        await this.filesystem.check(this.path);
        const info = await stat(this.path),
            file = await open(this.path, "r");
        try {
            return new File([await file.readFile()], this.name, { lastModified: Math.trunc(info.mtimeMs) });
        } finally {
            await file.close();
        }
    }
    async createWritable() {
        const chunks: BlobPart[] = [];
        let finished = false;
        return {
            write: async (blob: Blob) => {
                if (finished) throw Error("写入流已关闭");
                chunks.push(blob);
            },
            close: async () => {
                if (finished) return;
                finished = true;
                const { Readable } = await import("node:stream");
                await this.filesystem.writeStream(this.path, Readable.fromWeb(new Blob(chunks).stream() as import("node:stream/web").ReadableStream));
            },
            abort: async () => {
                finished = true;
                chunks.length = 0;
            },
        };
    }
}

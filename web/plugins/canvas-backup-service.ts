import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin, ResolvedConfig } from "vite";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { open, readFile, readdir, stat, unlink } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { MAX_BACKUP_FILE_BYTES, NativeBackupRoot, type NativeDirectory } from "./canvas-backup-native-fs.ts";
import { backupServiceConfig, CANVAS_BACKUP_HEADER, CANVAS_BACKUP_PREFIX, type BackupServiceConfig } from "./canvas-backup-config.ts";
import { ensureProjectBackupDirectory } from "../src/lib/canvas/canvas-backup-directory.ts";

const LEASE_MS = 15 * 60_000;
const QUEUE_MS = 10 * 60_000;
const FILE_PATTERN = /^(?:index\.json|assets\/[a-f0-9]{64}\.bin|snapshots\/(?:snapshot|structure)-[\w.-]+\.json)$/;
const MEDIA_PATTERN = /^(?:pic|video|audio)\/[a-f0-9]{64}\.[a-z0-9]{1,8}$/;
type Project = { id: string; title: string; createdAt: string };
type Session = { id: string; base: string; directoryName: string; mediaOnly: boolean; expiresAt: number; active: number; closing?: boolean; drain?: Promise<void>; resolveDrain?: () => void; release: () => Promise<void> };
type RequestTask = { id: string; projectId: string; clientId?: string; state: "queued" | "running" | "succeeded" | "failed"; createdAt: string; expiresAt: number; result?: unknown; error?: string };
type Source = { id: string; label: string; base: string; files: string[] };
const code = (error: unknown) => (error as NodeJS.ErrnoException).code;
function errorStatus(error: unknown) {
    return (error as { status?: number }).status || (code(error) === "ENOENT" ? 503 : 400);
}
function fail(message: string, status = 400): never {
    throw Object.assign(Error(message), { status });
}
function projectInput(value: unknown): Project | null {
    if (value == null) return null;
    const p = value as Project;
    if (!p || typeof p.id !== "string" || !p.id || p.id.length > 512 || typeof p.title !== "string" || p.title.length > 500 || typeof p.createdAt !== "string" || !Number.isFinite(Date.parse(p.createdAt))) fail("画布参数无效");
    return { id: p.id, title: p.title, createdAt: p.createdAt };
}
async function jsonBody(req: IncomingMessage) {
    if (!String(req.headers["content-type"] || "").startsWith("application/json")) fail("需要JSON请求");
    const parts: Buffer[] = [];
    let bytes = 0;
    for await (const part of req) {
        const b = Buffer.from(part);
        bytes += b.length;
        if (bytes > 256 * 1024) fail("请求过大", 413);
        parts.push(b);
    }
    try {
        return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
    } catch {
        fail("JSON格式无效");
    }
}
function answer(res: ServerResponse, value: unknown, status = 200) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.end(JSON.stringify(value));
}
function fixedRelative(value: string) {
    if (!value || value.split("/").some((p) => !p || p === "." || p === ".." || /[\\:]/.test(p))) fail("历史归属目录无效");
    return value;
}

async function openInExplorer(path: string) {
    if (process.platform !== "win32") fail("仅支持在 Windows 中打开资源管理器");
    const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = fileURLToPath(new URL("./open-canvas-folder.ps1", import.meta.url));
    try {
        await promisify(execFile)(powershell, ["-NoProfile", "-NonInteractive", "-STA", "-File", script, "-Folder", path], { windowsHide: true, timeout: 12000 });
    } catch (error) {
        if ((error as { code?: number }).code === 2) fail("文件夹已打开，请点击任务栏的资源管理器切换窗口");
        fail("无法打开资源管理器，请复制路径后在资源管理器中打开");
    }
}

/** Backend is a narrow disk adapter. Worker / snapshot / index / restore algorithms remain unchanged. */
export function createCanvasBackupMiddleware(config: BackupServiceConfig, openFolder = openInExplorer) {
    const filesystem = new NativeBackupRoot(config.root);
    let session: Session | undefined;
    let beginning = false;
    const requests = new Map<string, RequestTask>();
    const sources = new Map<string, Source>();
    let closing = false,
        activeRequests = 0;
    let disposed: Promise<void> | undefined;
    let disposeResolve: (() => void) | undefined, disposeReject: ((error: unknown) => void) | undefined;
    let releasingForDispose = false;
    async function releaseWhenDrained() {
        if (!closing || activeRequests || releasingForDispose) return;
        releasingForDispose = true;
        const current = session;
        try {
            if (current) current.closing = true;
            await current?.release();
            if (session === current) session = undefined;
            disposeResolve?.();
        } catch (error) {
            disposeReject?.(error);
        }
    }
    let directoryQueue: Promise<unknown> = Promise.resolve();
    const directoryLock = <T>(_name: string, task: () => Promise<T>): Promise<T> => {
        const pending = directoryQueue.then(task, task);
        directoryQueue = pending.catch(() => undefined);
        return pending;
    };
    const lockPath = join(filesystem.root, ".canvas-backup-writer.lock");
    async function acquireWriter() {
        await filesystem.directory();
        const owner = { pid: process.pid, id: randomUUID() };
        const create = async () => {
            const file = await open(lockPath, "wx");
            try {
                await file.writeFile(JSON.stringify(owner));
                await file.sync();
            } finally {
                await file.close();
            }
        };
        try {
            await create();
        } catch (e) {
            if (code(e) !== "EEXIST") throw e;
            // Serialize stale-lock recovery. Without this second wx lock, two readers
            // can both observe the dead owner and one can unlink the other's new lock.
            const recoveryPath = join(filesystem.root, ".canvas-backup-writer.recovery.lock");
            let recovery;
            try {
                recovery = await open(recoveryPath, "wx");
            } catch (guardError) {
                if (code(guardError) === "EEXIST") fail("备份写锁正在回收；若重试后仍失败，请管理员核验遗留回收锁，服务不会自动删除", 409);
                throw guardError;
            }
            try {
                await recovery.writeFile(JSON.stringify(owner));
                await recovery.sync();
                let old: { pid: number; id: string } | undefined;
                try {
                    await filesystem.check(lockPath);
                    old = JSON.parse(await readFile(lockPath, "utf8"));
                } catch (readError) {
                    if (code(readError) !== "ENOENT") fail("备份写锁损坏，停止写入", 409);
                    // Its live owner may have finished after our initial EEXIST.
                }
                if (old) {
                    if (!Number.isSafeInteger(old.pid) || old.pid <= 0 || typeof old.id !== "string") fail("备份写锁无效", 409);
                    try {
                        process.kill(old.pid, 0);
                        fail("另一个备份服务仍持有写锁", 409);
                    } catch (probe) {
                        if (code(probe) !== "ESRCH") throw probe;
                    }
                    const again = JSON.parse(await readFile(lockPath, "utf8"));
                    if (again.id !== old.id) fail("备份写锁已变化", 409);
                    await unlink(lockPath);
                }
                // A normal acquirer may win this gap; never remove its new lock.
                try {
                    await create();
                } catch (createError) {
                    if (code(createError) === "EEXIST") fail("另一个备份服务已取得写锁", 409);
                    throw createError;
                }
            } finally {
                await recovery.close();
                if (JSON.parse(await readFile(recoveryPath, "utf8")).id === owner.id) await unlink(recoveryPath);
            }
        }
        // All callers share one release operation: a delayed duplicate must never
        // unlink the lock belonging to a newer session after the first release.
        let releasePromise: Promise<void> | undefined;
        return () =>
            (releasePromise ??= (async () => {
                try {
                    if (JSON.parse(await readFile(lockPath, "utf8")).id === owner.id) await unlink(lockPath);
                } catch (e) {
                    if (code(e) !== "ENOENT") throw e;
                }
            })());
    }
    async function expireSession() {
        if (session && session.expiresAt < Date.now() && !session.active) {
            const expired = session;
            expired.closing = true;
            await expired.release();
            if (session === expired) session = undefined;
        }
    }
    async function activeSession(id: string | null) {
        await expireSession();
        if (!session || session.id !== id || session.closing) fail("备份会话已失效，禁止继续写入", 409);
        session.expiresAt = Date.now() + LEASE_MS;
        return session;
    }
    async function legacyBase(root: NativeDirectory, projectId: string): Promise<NativeDirectory | null> {
        let file;
        try {
            file = await root.getFileHandle(".canvas-history-projects.json");
        } catch (e) {
            if ((e as DOMException).name === "NotFoundError") return null;
            throw e;
        }
        const data = JSON.parse(await (await file.getFile()).text());
        if (data.version !== 1 || !Array.isArray(data.entries)) fail("历史项目归属索引损坏");
        const ids = new Set<string>();
        for (const entry of data.entries) {
            if (!entry || typeof entry.id !== "string" || !entry.id || typeof entry.backupBase !== "string" || ids.has(entry.id)) fail("历史项目归属索引无效或重复");
            ids.add(entry.id);
            fixedRelative(entry.backupBase);
        }
        const match = data.entries.find((entry: { id: string }) => entry.id === projectId);
        if (!match) return null;
        let base = root;
        for (const part of fixedRelative(match.backupBase).split("/")) base = await base.getDirectoryHandle(part);
        // Explicit registry missing destinations must never fall through into a duplicate new project.
        await base.getDirectoryHandle("snapshots");
        return base;
    }
    async function openProjectFolder(projectId: unknown) {
        if (typeof projectId !== "string" || !projectId || projectId.length > 512) fail("需要稳定画布 ID");
        const root = await filesystem.directory();
        const metadata = await root.getDirectoryHandle("无限画布备份");
        const index = await metadata.getFileHandle("project-directories.json");
        const data = JSON.parse(await (await index.getFile()).text()) as { version?: number; entries?: Array<{ id: string; ready?: boolean; directory: string }> } | null;
        if (data?.version !== 1 || !Array.isArray(data.entries)) fail("画布目录索引损坏");
        const entries = data.entries.filter((entry) => entry?.id === projectId);
        if (!entries.length || entries[0].ready === false) fail("画布目录正在准备，请稍后重试", 404);
        if (entries.length !== 1 || typeof entries[0].directory !== "string") fail("画布目录索引损坏");
        const directory = await root.getDirectoryHandle(entries[0].directory);
        const marker = await directory.getFileHandle("canvas-project.json");
        if (JSON.parse(await (await marker.getFile()).text()).id !== projectId) fail("画布目录归属不符");
        await openFolder(directory.path);
    }
    async function begin(project: Project | null, mediaOnly: boolean) {
        if (mediaOnly && !project) fail("资产目录需要画布 ID");
        await expireSession();
        if (session || beginning) fail("已有备份任务进行中", 409);
        beginning = true;
        let release: (() => Promise<void>) | undefined;
        try {
            release = await acquireWriter();
            const root = await filesystem.directory();
            let base: NativeDirectory,
                directoryName = root.name,
                projectTitle: string | undefined;
            if (project) {
                const historical = mediaOnly ? null : await legacyBase(root, project.id);
                if (historical) {
                    base = historical;
                    directoryName = relative(filesystem.root, historical.path).replaceAll("\\", "/");
                } else {
                    const mapped = await ensureProjectBackupDirectory(root as unknown as FileSystemDirectoryHandle, project, directoryLock, { dateFirstForNew: true, syncTitle: !mediaOnly });
                    const folder = mapped.directory as unknown as NativeDirectory;
                    directoryName = mapped.name;
                    if (mapped.managed) projectTitle = mapped.name;
                    base = mediaOnly ? folder : await folder.getDirectoryHandle("无限画布备份", { create: true });
                }
            } else base = await root.getDirectoryHandle("无限画布备份", { create: true });
            session = { id: randomUUID(), base: base.path, directoryName, mediaOnly, expiresAt: Date.now() + LEASE_MS, active: 0, release };
            return { sessionId: session.id, directoryName, projectTitle, root: config.root, expiresAt: session.expiresAt };
        } catch (e) {
            await release?.();
            throw e;
        } finally {
            beginning = false;
        }
    }
    async function catalog() {
        await filesystem.directory();
        const next = new Map<string, Source>();
        let directories = 0;
        const walk = async (base: string, depth: number) => {
            if (++directories > 5000 || depth > 12) fail("历史目录层级或数量过大，请专项检查");
            await filesystem.check(base);
            const entries = await readdir(base, { withFileTypes: true });
            if (entries.some((e) => e.isSymbolicLink())) fail("历史目录含重解析点，停止扫描");
            if (entries.some((e) => e.isDirectory() && e.name === "snapshots")) {
                const names = (await readdir(join(base, "snapshots")))
                    .filter((name) => /^(?:snapshot|structure)-[\w.-]+\.json$/.test(name))
                    .sort((a, b) => b.replace(/^(snapshot|structure)-/, "").localeCompare(a.replace(/^(snapshot|structure)-/, "")) || a.localeCompare(b));
                if (names.length) {
                    const label = relative(filesystem.root, base).replaceAll("\\", "/") || ".";
                    const id = createHash("sha256").update(label).digest("hex").slice(0, 32);
                    next.set(id, { id, label, base, files: names.map((name) => `snapshots/${name}`) });
                }
            }
            for (const entry of entries) if (entry.isDirectory() && !["assets", "snapshots", "pic", "video", "audio", "media", "node_modules"].includes(entry.name)) await walk(join(base, entry.name), depth + 1);
        };
        await walk(filesystem.root, 0);
        sources.clear();
        for (const [key, value] of next) sources.set(key, value);
        return [...sources.values()].map((source) => ({ sourceId: source.id, label: source.label, files: source.files }));
    }
    function expireRequests() {
        for (const task of requests.values())
            if ((task.state === "queued" || task.state === "running") && task.expiresAt < Date.now()) {
                task.state = "failed";
                task.error = "等待画布执行超时；没有自动重试";
            }
    }
    const middleware = async function (req: IncomingMessage, res: ServerResponse, next?: () => void) {
        const url = new URL(req.url || "/", config.origin);
        // Works both when mounted at the prefix and as a full HTTP test handler.
        const route = url.pathname.startsWith(CANVAS_BACKUP_PREFIX) ? url.pathname.slice(CANVAS_BACKUP_PREFIX.length) || "/" : url.pathname;
        if (!url.pathname.startsWith(CANVAS_BACKUP_PREFIX) && !["/status", "/open-project-folder", "/begin", "/file", "/finish", "/recovery", "/recovery/file", "/requests", "/requests/claim"].includes(route) && !route.startsWith("/requests/")) {
            next?.();
            return;
        }
        res.setHeader("Cache-Control", "no-store");
        const remote = req.socket.remoteAddress || "",
            origin = req.headers.origin,
            host = req.headers.host;
        if (
            !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(remote) ||
            host !== new URL(config.origin).host ||
            (origin && origin !== config.origin) ||
            req.headers[CANVAS_BACKUP_HEADER] !== "1" ||
            (req.headers["sec-fetch-site"] && !["same-origin", "none"].includes(String(req.headers["sec-fetch-site"])))
        ) {
            answer(res, { ok: false, error: "仅允许授权的本机同源备份请求" }, 403);
            return;
        }
        if (closing) {
            answer(res, { ok: false, error: "备份服务正在重启；请稍后重新发起备份" }, 503);
            return;
        }
        activeRequests++;
        try {
            if (req.method === "GET" && route === "/status") {
                try {
                    await filesystem.directory();
                    await expireSession();
                    answer(res, { ok: true, ready: true, root: config.root, busy: !!session || beginning });
                } catch {
                    answer(res, { ok: false, ready: false, root: config.root, error: "固定备份根目录不可访问；不会写入旧目录或C盘" }, 503);
                }
                return;
            }
            if (req.method === "POST" && route === "/begin") {
                const data = await jsonBody(req);
                answer(res, { ok: true, ...(await begin(projectInput(data.project), data.mediaOnly === true)) });
                return;
            }
            if (req.method === "POST" && route === "/open-project-folder") {
                const data = await jsonBody(req);
                try {
                    await openProjectFolder(data.projectId);
                } catch (error) {
                    if ((error as Error).name === "NotFoundError") fail("画布目录尚未就绪，请稍后重试", 404);
                    throw error;
                }
                answer(res, { ok: true });
                return;
            }
            if (req.method === "POST" && route === "/finish") {
                const data = await jsonBody(req),
                    current = await activeSession(data.sessionId);
                current.closing = true;
                // The browser can consume the final response bytes before Node's
                // pipeline finally runs. Drain that I/O without opening a new writer.
                if (current.active) {
                    current.drain ??= new Promise<void>((resolve) => {
                        current.resolveDrain = resolve;
                    });
                    await current.drain;
                }
                await current.release();
                if (session === current) session = undefined;
                answer(res, { ok: true });
                return;
            }
            if (["GET", "HEAD", "PUT"].includes(req.method || "") && route === "/file") {
                const current = await activeSession(url.searchParams.get("sessionId")),
                    path = url.searchParams.get("path") || "";
                if (!(current.mediaOnly ? MEDIA_PATTERN : FILE_PATTERN).test(path)) fail("备份文件路径无效");
                if (current.closing) fail("备份会话正在结束，不能开始新的I/O", 409);
                current.active++;
                try {
                    let target: string;
                    try {
                        target = await filesystem.filePath(current.base, path, req.method === "PUT");
                    } catch (e) {
                        if (req.method !== "PUT" && code(e) === "ENOENT") {
                            answer(res, { ok: false, missing: true }, 404);
                            return;
                        }
                        throw e;
                    }
                    if (req.method === "PUT") {
                        if (!String(req.headers["content-type"] || "").startsWith("application/octet-stream")) fail("备份文件必须使用二进制流");
                        const declaredSize = Number(req.headers["content-length"]);
                        if (Number.isFinite(declaredSize) && declaredSize > MAX_BACKUP_FILE_BYTES) fail("备份文件超过8GiB限制，之前有效版本保持不变", 413);
                        const bytes = await directoryLock(path, () => filesystem.writeStream(target, req));
                        answer(res, { ok: true, bytes });
                    } else {
                        let info;
                        try {
                            info = await stat(target);
                        } catch (e) {
                            if (code(e) === "ENOENT") {
                                answer(res, { ok: false, missing: true }, 404);
                                return;
                            }
                            throw e;
                        }
                        res.setHeader("Content-Length", info.size);
                        res.setHeader("Content-Type", "application/octet-stream");
                        res.setHeader("X-Backup-Mtime", Math.trunc(info.mtimeMs));
                        if (req.method === "HEAD") res.end();
                        else await filesystem.readStream(target, res);
                    }
                } finally {
                    current.active--;
                    if (!current.active) current.resolveDrain?.();
                    current.expiresAt = Date.now() + LEASE_MS;
                }
                return;
            }
            if (req.method === "GET" && route === "/recovery") {
                answer(res, { ok: true, sources: await catalog() });
                return;
            }
            if (req.method === "GET" && route === "/recovery/file") {
                const sourceId = url.searchParams.get("sourceId") || "",
                    path = url.searchParams.get("path") || "";
                if (!/^[a-f0-9]{32}$/.test(sourceId) || !FILE_PATTERN.test(path) || path === "index.json") fail("恢复文件引用无效");
                if (!sources.has(sourceId)) await catalog();
                const source = sources.get(sourceId);
                if (!source) fail("找不到历史恢复来源", 404);
                const target = await filesystem.filePath(source.base, path),
                    info = await stat(target);
                res.setHeader("Content-Length", info.size);
                res.setHeader("Content-Type", "application/octet-stream");
                await filesystem.readStream(target, res);
                return;
            }
            expireRequests();
            if (req.method === "POST" && route === "/requests") {
                const data = await jsonBody(req);
                if (typeof data.projectId !== "string" || !data.projectId || data.projectId.length > 512 || (data.clientId != null && typeof data.clientId !== "string")) fail("需要稳定画布ID");
                const id = data.requestId || randomUUID();
                if (typeof id !== "string" || !/^[\w-]{1,100}$/.test(id)) fail("请求ID无效");
                const existing = requests.get(id);
                if (existing) {
                    if (existing.projectId !== data.projectId) fail("请求ID已属于其他画布", 409);
                    answer(res, { ok: true, task: existing });
                    return;
                }
                if (requests.size >= 200) {
                    const completed = [...requests.values()].find((task) => task.state === "succeeded" || task.state === "failed");
                    if (completed) requests.delete(completed.id);
                    else fail("备份任务队列已满，请等待现有任务结束", 503);
                }
                const task: RequestTask = { id, projectId: data.projectId, clientId: data.clientId, state: "queued", createdAt: new Date().toISOString(), expiresAt: Date.now() + QUEUE_MS };
                requests.set(id, task);
                answer(res, { ok: true, task }, 202);
                return;
            }
            if (req.method === "POST" && route === "/requests/claim") {
                const data = await jsonBody(req);
                if (typeof data.clientId !== "string" || !data.clientId || !Array.isArray(data.projectIds) || data.projectIds.length > 1 || data.projectIds.some((id: unknown) => typeof id !== "string")) fail("只能领取当前画布的备份请求");
                const task = [...requests.values()].find((t) => t.state === "queued" && (!t.clientId || t.clientId === data.clientId) && data.projectIds.includes(t.projectId));
                if (task) {
                    task.state = "running";
                    task.clientId = data.clientId;
                    task.expiresAt = Date.now() + QUEUE_MS;
                }
                answer(res, { ok: true, task: task || null });
                return;
            }
            const match = /^\/requests\/([\w-]{1,100})(\/result)?$/.exec(route);
            if (match) {
                const task = requests.get(match[1]);
                if (!task) fail("找不到任务回执（服务重启后任务不自动重放）", 404);
                if (req.method === "GET" && !match[2]) {
                    answer(res, { ok: true, task });
                    return;
                }
                if (req.method === "POST" && match[2]) {
                    const data = await jsonBody(req);
                    if (task.clientId !== data.clientId) fail("回执客户端不匹配", 409);
                    if (task.state === "succeeded" || task.state === "failed") {
                        answer(res, { ok: true, task });
                        return;
                    }
                    if (task.state !== "running" || typeof data.ok !== "boolean") fail("任务尚未领取或结果无效", 409);
                    task.state = data.ok ? "succeeded" : "failed";
                    task.result = data.result;
                    task.error = data.ok ? undefined : String(data.error || "画布备份失败");
                    answer(res, { ok: true, task });
                    return;
                }
            }
            fail("不支持的备份操作", 404);
        } catch (error) {
            if (res.headersSent) {
                if (!res.writableEnded) res.destroy(error instanceof Error ? error : undefined);
            } else {
                res.removeHeader("Content-Length");
                answer(res, { ok: false, error: code(error) === "ENOENT" ? "固定备份目录或文件不存在，已停止；不会回退其他位置" : error instanceof Error ? error.message : String(error) }, errorStatus(error));
            }
        } finally {
            activeRequests--;
            await releaseWhenDrained();
        }
    };
    return Object.assign(middleware, {
        dispose() {
            if (!disposed) {
                closing = true;
                disposed = new Promise<void>((done, reject) => {
                    disposeResolve = done;
                    disposeReject = reject;
                });
                void releaseWhenDrained();
            }
            return disposed;
        },
    });
}

export function canvasBackupService({ testRoot }: { testRoot?: string } = {}): Plugin {
    let config: ResolvedConfig;
    return {
        name: "canvas-fixed-root-backup",
        configResolved(value) {
            config = value;
        },
        configureServer(server) {
            const handler = createCanvasBackupMiddleware(backupServiceConfig(config.mode, config.root, testRoot));
            server.middlewares.use(CANVAS_BACKUP_PREFIX, handler);
            server.httpServer?.once("close", () => {
                void handler.dispose().catch((error) => console.error("[canvas-backup] 关闭写锁失败", error));
            });
        },
        configurePreviewServer(server) {
            const handler = createCanvasBackupMiddleware(backupServiceConfig(config.mode, config.root, testRoot));
            server.middlewares.use(CANVAS_BACKUP_PREFIX, handler);
            server.httpServer?.once("close", () => {
                void handler.dispose().catch((error) => console.error("[canvas-backup] 关闭写锁失败", error));
            });
        },
    };
}

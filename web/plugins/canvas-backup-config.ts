import { homedir } from "node:os";
import { isAbsolute, relative, resolve, sep } from "node:path";

/** Production has exactly one root; no fallback and no per-request path overrides. */
export const CANVAS_BACKUP_ROOT = resolve(homedir(), "Ai视觉无限画布备份");
export const CANVAS_BACKUP_PREFIX = "/__canvas-backup";
export const CANVAS_BACKUP_HEADER = "x-canvas-backup";
export type BackupServiceConfig = { root: string; origin: string };
export function backupServiceConfig(mode: string, workspace: string, testRoot?: string): BackupServiceConfig {
    if (mode !== "test") return { root: CANVAS_BACKUP_ROOT, origin: "http://localhost:3000" };
    if (!testRoot) throw Error("隔离备份测试必须明确设置工作区内测试根目录");
    const root = resolve(testRoot),
        base = resolve(workspace),
        child = relative(base, root);
    if (!child || child === ".." || child.startsWith(`..${sep}`) || isAbsolute(child)) throw Error("测试备份目录必须位于当前工作区内");
    if (root.toLowerCase() === resolve(CANVAS_BACKUP_ROOT).toLowerCase()) throw Error("测试环境禁止使用正式备份目录");
    return { root, origin: "http://127.0.0.1:5173" };
}

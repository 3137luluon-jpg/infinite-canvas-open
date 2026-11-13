import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolvePluginSkillsRoot } from "../skills/bundled.js";

export const CURSOR_H3_MODEL = "cursor-grok-4.6-high";
export const CURSOR_H3_FAST_MODEL = "cursor-grok-4.6-high-fast";
export type CursorCompileInput = { prompt: string; images: string[]; model?: string };

export function validateCursorInput(value: unknown): CursorCompileInput {
    const input = value as Partial<CursorCompileInput> | null;
    if (!input || typeof input.prompt !== "string" || !input.prompt.trim() || input.prompt.length > 500_000) throw new Error("Cursor 编译正文为空或超过限制");
    if (!Array.isArray(input.images) || input.images.length > 6) throw new Error("Cursor 每镜最多支持6张参考图；未静默丢图");
    if (input.model !== undefined && ![CURSOR_H3_MODEL, CURSOR_H3_FAST_MODEL].includes(input.model)) throw new Error("不支持的 Cursor 编译模型，请重新选择");
    let bytes = 0;
    for (const image of input.images) {
        if (typeof image !== "string" || !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/.test(image)) throw new Error("Cursor 图片必须为 PNG、JPEG 或 WebP 数据");
        bytes += Buffer.from(image.slice(image.indexOf(",") + 1), "base64").length;
    }
    if (bytes > 20 * 1024 * 1024) throw new Error("Cursor 本镜图片合计超过20MB，请缩小图片后重试");
    return input as CursorCompileInput;
}

/** Invoke the bundled Node entry directly: no shell expansion, no collision with Grok's agent. */
async function cursorCommand() {
    const root = process.platform === "win32"
        ? path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"), "cursor-agent", "versions")
        : path.join(os.homedir(), ".local", "share", "cursor-agent", "versions");
    const versions = await readdir(root, { withFileTypes: true }).catch(() => []);
    const version = versions.filter(v => v.isDirectory() && /^\d{4}\.\d{2}\.\d{2}-/.test(v.name)).sort((a, b) => b.name.localeCompare(a.name))[0];
    if (!version) throw new Error("未找到 Cursor Agent CLI，请先安装并登录 Cursor Agent");
    const directory = path.join(root, version.name);
    return { executable: path.join(directory, process.platform === "win32" ? "node.exe" : "node"), entry: path.join(directory, "index.js") };
}

export function parseCursorResult(stdout: string): string {
    const events = stdout.split(/\r?\n/).filter(Boolean).flatMap(line => {
        try { return [JSON.parse(line)]; } catch { return []; }
    });
    const result = events.reverse().find(event => event.type === "result");
    if (!result || result.is_error || result.subtype !== "success" || typeof result.result !== "string" || !result.result.trim()) {
        throw new Error(`Cursor 未完成编译：${String(result?.error?.message || result?.result || "未收到完整结果，请检查 Cursor 登录和网络").slice(0, 1000)}`);
    }
    return extractCursorCompilation(result.result);
}

/** Cursor's result can concatenate a pre-tool explanation and the final JSON. */
export function extractCursorCompilation(text: string): string {
    const candidates: string[] = [];
    let start = -1, depth = 0, quoted = false, escaped = false;
    for (let i = 0; i < text.length; i++) {
        const char = text[i];
        if (start < 0) {
            if (char === "{") { start = i; depth = 1; }
            continue;
        }
        if (quoted) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') quoted = false;
        } else if (char === '"') quoted = true;
        else if (char === "{") depth++;
        else if (char === "}" && --depth === 0) {
            const candidate = text.slice(start, i + 1);
            try {
                const value = JSON.parse(candidate);
                if (typeof value.requestId === "string" && typeof value.shotNodeId === "string") candidates.push(candidate);
            } catch { /* Non-JSON commentary is not a compilation result. */ }
            start = -1;
        }
    }
    if (candidates.length > 1) throw new Error("Cursor 返回多个镜头结果，无法确定唯一编译结果");
    // Plain text probes stay plain text; missing/invalid drafts still fail the frontend's strict validator.
    return candidates[0] || text;
}

export async function runCursorProcess(executable: string, args: string[], cwd: string, prompt: string, signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const child = spawn(executable, args, { cwd, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
        child.stdout.setEncoding("utf8");
        child.stderr.setEncoding("utf8");
        let stdout = "", stderr = "", failure: Error | undefined;
        const kill = () => {
            if (process.platform === "win32" && child.pid) {
                const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
                killer.on("error", () => child.kill());
            } else child.kill("SIGKILL");
        };
        const abort = () => { failure = new Error("Cursor 编译已停止或超时，未写入结果"); kill(); };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
        child.stdout.on("data", chunk => {
            stdout += chunk.toString();
            if (stdout.length > 4_000_000) { failure = new Error("Cursor 返回内容超过限制"); kill(); }
        });
        child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-4000); });
        child.stdin.on("error", () => {});
        child.on("error", error => { failure = error; });
        child.on("close", code => {
            signal.removeEventListener("abort", abort);
            if (failure) return reject(failure);
            if (code !== 0) return reject(new Error(`Cursor 退出（${code}）：${stderr.trim().slice(0, 1000) || "请检查登录、网络和模型权限"}`));
            try { resolve(parseCursorResult(stdout)); } catch (error) { reject(error); }
        });
        child.stdin.end(prompt);
    });
}

/** Read-only agent in a disposable directory; originals and application workspace are never exposed. */
export async function compileWithCursor(value: unknown, signal: AbortSignal): Promise<string> {
    const input = validateCursorInput(value);
    const command = await cursorCommand();
    const skills = resolvePluginSkillsRoot();
    if (!skills) throw new Error("未找到随应用提供的 H3 Skill，请重新构建 Canvas Agent");
    const [skill, compiler] = await Promise.all([
        readFile(path.join(skills, "h3-prompt-writing", "SKILL.md"), "utf8"),
        readFile(path.join(skills, "h3-prompt-writing", "references", "h3-compiler.md"), "utf8"),
    ]);
    const directory = await mkdtemp(path.join(os.tmpdir(), "cinepack-cursor-"));
    try {
        const names: string[] = [];
        for (const [index, image] of input.images.entries()) {
            signal.throwIfAborted();
            const extension = image.slice(11, image.indexOf(";"));
            const name = `Picture-${index + 1}.${extension === "jpeg" ? "jpg" : extension}`;
            await writeFile(path.join(directory, name), Buffer.from(image.slice(image.indexOf(",") + 1), "base64"));
            names.push(name);
        }
        const prompt = `${skill}\n\n${compiler}\n\n本调用为只读H3编译。Skill已完整内联，不必寻找额外Skill。禁止Shell、联网、写文件或任何生成工具。${names.length ? "必须先用图片读取工具逐一查看以下本次参考图；无法读取时返回错误，不得假装看过图片：\n" + names.map((name, i) => `<Picture ${i + 1}>: ${path.join(directory, name)}`).join("\n") : "本次没有图片，只依据文字事实。"}\n\n${input.prompt}\n\n最终回复只包含要求的JSON，不附Markdown或说明。`;
        return await runCursorProcess(command.executable, [command.entry, "--workspace", directory, "--trust", "--mode", "ask", "--model", input.model || CURSOR_H3_MODEL, "--print", "--output-format", "json"], directory, prompt, signal);
    } finally {
        // Only this mkdtemp-created directory is removed, after the child exits.
        await rm(directory, { recursive: true, force: true, maxRetries: 3 });
    }
}

import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createWriteStream } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import type { Plugin } from "vite";

type Clip = { title: string; width: number; height: number; duration: number; bytes: number; extension: string };
type Manifest = { name: string; clips: Clip[] };
type Destination = { root: string; index: string };
class DraftExportError extends Error {}
const maxBytes = 2 * 1024 ** 3;
const validInteger = (value: unknown, max: number): value is number => typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max;
const uuid = () => randomUUID().toUpperCase();

function parseManifest(raw: Buffer): Manifest {
    const data = JSON.parse(raw.toString("utf8")) as Partial<Manifest> | null;
    if (typeof data?.name !== "string" || !data.name.trim() || data.name.length > 80 || /[\u0000-\u001F]/.test(data.name)
        || !Array.isArray(data.clips) || !data.clips.length || data.clips.length > 50
        || data.clips.some((c) => !c || typeof c.title !== "string" || c.title.length > 120 || typeof c.extension !== "string" || !/^(mp4|mov|webm|mkv)$/.test(c.extension)
            || !validInteger(c.width, 16384) || !validInteger(c.height, 16384) || !validInteger(c.duration, 24 * 3600 * 1e6) || !validInteger(c.bytes, maxBytes))) {
        throw new DraftExportError("草稿名称或视频列表无效");
    }
    if (data.clips.reduce((sum, clip) => sum + clip.bytes, 0) > maxBytes) throw new DraftExportError("一次最多导出 2 GB 视频，请分批导出");
    return { name: data.name.trim(), clips: data.clips };
}

// The request is a length-prefixed manifest followed by the original video bytes.
// Read each file directly into staging rather than keeping the entire request in memory.
function readUpload(req: IncomingMessage) {
    const stream = req[Symbol.asyncIterator]();
    let buffer: Buffer = Buffer.alloc(0);
    async function* take(length: number) {
        while (length > 0) {
            if (!buffer.length) {
                const next = await stream.next();
                if (next.done) throw new DraftExportError("视频上传不完整，请重试");
                buffer = next.value as Buffer;
            }
            const size = Math.min(length, buffer.length);
            const piece = buffer.subarray(0, size);
            buffer = buffer.subarray(size);
            length -= size;
            yield piece;
        }
    }
    return {
        take,
        async read(length: number) {
            const pieces = [];
            for await (const piece of take(length)) pieces.push(piece);
            return Buffer.concat(pieces, length);
        },
        async finish() {
            if (buffer.length || !(await stream.next()).done) throw new DraftExportError("收到的视频大小与清单不匹配，请重新导出");
        },
    };
}

async function loadIndex(path: string) {
    const raw = await readFile(path, "utf8");
    const data = JSON.parse(raw.replace(/^\uFEFF/, ""));
    if (!data || !Array.isArray(data.all_draft_store)) throw new DraftExportError("剪映草稿列表格式无法识别");
    return { raw, data };
}

async function getDestination(): Promise<Destination> {
    if (process.platform !== "win32" || !process.env.LOCALAPPDATA) throw new DraftExportError("请在安装了剪映专业版的 Windows 电脑上导出");
    const userData = join(process.env.LOCALAPPDATA, "JianyingPro", "User Data");
    const projects = join(userData, "Projects");
    const defaultRoot = join(projects, "com.lveditor.draft");
    const settings = await readFile(join(userData, "Config", "globalSetting"), "utf8").catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return "";
        throw error;
    });
    const customRoot = /^currentCustomDraftPath=(.+)$/m.exec(settings)?.[1].trim().replace(/^"|"$/g, "").replace(/\\\\/g, "\\");
    if (customRoot && !isAbsolute(customRoot)) throw new DraftExportError("剪映自定义草稿位置无效，请在剪映设置里确认");
    const root = await realpath(customRoot || defaultRoot).catch(() => {
        throw new DraftExportError("找不到剪映草稿目录。请先打开剪映并确认草稿位置");
    });
    const paths = [join(defaultRoot, "root_meta_info.json"), join(projects, "root_meta_info.json"), join(root, "root_meta_info.json")];
    for (const index of paths) {
        try {
            await loadIndex(index);
            return { root, index: await realpath(index) };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
    }
    throw new DraftExportError("找不到剪映草稿列表。请先打开剪映首页，再完全退出后重试");
}

async function checkJianyingClosed() {
    const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const { stdout } = await promisify(execFile)(powershell, ["-NoProfile", "-NonInteractive", "-Command", "if (Get-Process -Name JianyingPro -ErrorAction SilentlyContinue) { 'running' }"], { windowsHide: true, timeout: 5000 });
    if (stdout.trim() === "running") throw new DraftExportError("剪映还开着。请关闭剪映程序，回到画布后再点「导出剪映草稿」。");
}

// Video-only subset of the JianYing draft format. See the format reference in
// https://github.com/Ppppan9/jianying-mcp/blob/3016f4fdbd55d2df3f7e3b8bf4144df968cd10c4/docs/DRAFT_FORMAT.md
function buildDraft(manifest: Manifest, id: string, target: string) {
    const speeds = manifest.clips.map(() => ({ id: uuid(), type: "speed", mode: 0, speed: 1, curve_speed: null }));
    const videos = manifest.clips.map((clip, i) => ({
        id: uuid(), type: "video", path: join(target, "Resources", clipFilename(clip, i)).replaceAll("\\", "/"),
        material_name: clip.title, width: clip.width, height: clip.height, duration: clip.duration,
        category_id: "", category_name: "local", check_flag: 63487, crop_ratio: "free", crop_scale: 1,
        crop: { upper_left_x: 0, upper_left_y: 0, upper_right_x: 1, upper_right_y: 0, lower_left_x: 0, lower_left_y: 1, lower_right_x: 1, lower_right_y: 1 },
        source_platform: 0, audio_fade: null, media_path: "", local_material_id: uuid(), team_id: "",
        video_algorithm: { algorithms: [], complement_frame_config: null, deflicker: null, gameplay_configs: [], motion_blur_config: null, noise_reduction: null, path: "", quality_enhance: null, time_range: null },
    }));
    let duration = 0;
    const segments = videos.map((video, i) => {
        const start = duration;
        duration += video.duration;
        return {
            id: uuid(), material_id: video.id, extra_material_refs: [speeds[i].id],
            source_timerange: { start: 0, duration: video.duration }, target_timerange: { start, duration: video.duration },
            clip: { transform: { x: 0, y: 0 }, scale: { x: 1, y: 1 }, alpha: 1, rotation: 0, flip: { horizontal: false, vertical: false } },
            uniform_scale: { on: true, value: 1 }, hdr_settings: { mode: 1, intensity: 1, nits: 1000 },
            visible: true, reverse: false, volume: 1, last_nonzero_volume: 1, speed: 1, is_tone_modify: false,
            render_index: 0, track_render_index: 0, track_attribute: 0, common_keyframes: [], keyframe_refs: [],
            enable_adjust: true, enable_color_curves: true, enable_color_wheels: true, enable_lut: true,
        };
    });
    const now = Date.now() * 1000;
    const platform = { app_id: 3704, app_source: "lv", app_version: "5.9.0", os: "windows" };
    const emptyBuckets = ["ai_generate_holders", "ai_text_effects", "ai_translates", "audio_balances", "audio_effects", "audio_fades", "audio_pannings", "audio_pitch_shifts",
        "audio_track_indexes", "audios", "beats", "canvases", "chromas", "color_curves", "common_mask", "digital_human_model_dressing", "digital_humans", "drafts",
        "effects", "flowers", "green_screens", "handwrites", "hsl", "hsl_curves", "images", "log_color_wheels", "loudnesses", "manual_beautys", "manual_deformations",
        "material_animations", "material_colors", "multi_language_refs", "placeholder_infos", "placeholders", "plugin_effects", "primary_color_wheels", "realtime_denoises",
        "shapes", "smart_crops", "smart_relights", "sound_channel_mappings", "stickers", "tail_leaders", "text_templates", "texts", "time_marks", "transitions",
        "video_effects", "video_radius", "video_shadows", "video_strokes", "video_trackings", "vocal_beautifys", "vocal_separations"];
    const materials = Object.fromEntries(emptyBuckets.map((key) => [key, []]));
    return {
        id, name: "", duration, fps: 30, version: 360000, new_version: "110.0.0", source: "default", draft_type: "video",
        create_time: now, update_time: now, platform, last_modified_platform: platform, color_space: 0,
        canvas_config: { width: videos[0].width, height: videos[0].height, ratio: "original" },
        config: { maintrack_adsorb: true, video_mute: false, material_save_mode: 0, export_range: null },
        tracks: [{ id: uuid(), type: "video", name: "", is_default_name: true, flag: 0, attribute: 0, segments }],
        materials: { ...materials, videos, speeds },
        keyframes: { adjusts: [], audios: [], effects: [], filters: [], handwrites: [], stickers: [], texts: [], videos: [] },
        cover: null, keyframe_graph_list: [], relationships: [], render_index_track_mode_on: true,
    };
}

const clipFilename = (clip: Clip, i: number) => `${String(i + 1).padStart(2, "0")}.${clip.extension}`;

async function installDraft(req: IncomingMessage, destination: Destination, checkClosed: () => Promise<void>) {
    await checkClosed();
    const upload = readUpload(req);
    const length = (await upload.read(4)).readUInt32BE();
    if (!validInteger(length, 64 * 1024)) throw new DraftExportError("草稿请求无效");
    const manifest = parseManifest(await upload.read(length));
    const id = uuid();
    const { root, index } = destination;
    const stage = await mkdtemp(join(root, ".canvas-stage-"));
    const target = join(root, `canvas-${id}`);
    const pendingIndex = join(dirname(index), `.canvas-index-${id}.tmp`);
    let published = false;
    let installed = false;

    try {
        await mkdir(join(stage, "Resources"));
        for (const [i, clip] of manifest.clips.entries()) {
            await pipeline(Readable.from(upload.take(clip.bytes)), createWriteStream(join(stage, "Resources", clipFilename(clip, i)), { flags: "wx" }));
        }
        await upload.finish();

        const draft = buildDraft(manifest, id, target);
        const draftText = JSON.stringify(draft);
        const now = draft.create_time;
        const name = manifest.name;
        const paths = {
            draft_fold_path: target.replaceAll("\\", "/"), draft_root_path: root.replaceAll("\\", "/"),
            draft_json_file: join(target, "draft_content.json").replaceAll("\\", "/"),
        };
        const entry = {
            ...paths, draft_id: id, draft_name: name, draft_cover: "", draft_type: "", draft_new_version: "",
            draft_is_invisible: false, draft_is_cloud_temp_draft: false, cloud_draft_sync: false, streaming_edit_draft_ready: true,
            draft_timeline_materials_size: Buffer.byteLength(draftText),
            tm_draft_create: now, tm_draft_modified: now, tm_draft_removed: 0, tm_duration: draft.duration,
        };
        await Promise.all([
            writeFile(join(stage, "draft_content.json"), draftText),
            writeFile(join(stage, "draft_meta_info.json"), JSON.stringify({ ...entry, draft_materials: [0, 1, 2, 3, 6, 7, 8].map((type) => ({ type, value: [] })), draft_materials_copied_info: [], draft_segment_extra_info: [] })),
            writeFile(join(stage, "key_value.json"), "{}"),
            writeFile(join(stage, "draft_settings"), `[General]\ndraft_create_time=${Math.floor(now / 1e6)}\ndraft_last_edit_time=${Math.floor(now / 1e6)}\nreal_edit_keys=1\nreal_edit_seconds=0\n`),
        ]);

        await checkClosed();
        const { raw, data } = await loadIndex(index);
        data.all_draft_store.unshift(entry);
        data.draft_ids = Number.isSafeInteger(data.draft_ids) ? data.draft_ids + 1 : data.all_draft_store.length;
        await writeFile(pendingIndex, JSON.stringify(data), { flag: "wx" });
        await rename(stage, target);
        published = true;
        if (await readFile(index, "utf8") !== raw) throw new DraftExportError("剪映草稿列表刚刚发生变化，请重试");
        await rename(pendingIndex, index);
        installed = true;
        return { name, count: manifest.clips.length };
    } finally {
        await rm(pendingIndex, { force: true }).catch(() => undefined);
        const cleanup = published ? target : stage;
        if (!installed && dirname(resolve(cleanup)) === resolve(root)) {
            await rm(cleanup, { recursive: true, force: true }).catch(() => undefined);
        }
    }
}

export function createJianyingMiddleware(origin: string, destination = getDestination, checkClosed = checkJianyingClosed) {
    let exporting = false;
    return async (req: IncomingMessage, res: ServerResponse) => {
        const answer = (status: number, result: unknown) => {
            res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
            res.end(JSON.stringify(result));
        };
        if (req.method !== "POST" || req.url !== "/export" || req.headers["x-canvas-jianying"] !== "1"
            || !["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress || "")
            || req.headers.host !== new URL(origin).host || req.headers.origin !== origin) {
            answer(403, { error: "剪映导出仅支持本机画布页面" });
            return;
        }
        if (exporting) {
            answer(409, { error: "另一份剪映草稿正在导出，请稍后重试" });
            return;
        }
        exporting = true;
        try {
            answer(200, await installDraft(req, await destination(), checkClosed));
        } catch (error) {
            if (error instanceof DraftExportError) {
                answer(422, { error: error.message });
                return;
            }
            console.error("[剪映导出]", error);
            const code = (error as NodeJS.ErrnoException | null)?.code;
            const message = code === "EACCES" || code === "EPERM" ? "剪映草稿目录不可写，请检查权限并完全退出剪映。"
                : code === "ENOSPC" ? "剪映草稿所在磁盘空间不足。请腾出空间后重试。"
                    : "没能写入剪映草稿。请确认剪映已关闭，且剪映设置里的草稿位置可用，再重试。";
            answer(422, { error: message });
        } finally {
            exporting = false;
        }
    };
}

export function jianyingDraft(): Plugin {
    return {
        name: "canvas-jianying-draft",
        configureServer(server) {
            if (server.config.mode !== "test") server.middlewares.use("/__jianying", createJianyingMiddleware("http://localhost:3000"));
        },
        configurePreviewServer(server) {
            server.middlewares.use("/__jianying", createJianyingMiddleware("http://localhost:3000"));
        },
    };
}

import type { ZealmanWorkflowTemplate } from "./zealman-workflow-template";

// ResolutionSelector's enum and MP unit, verified against the cloud node schema.
const ratios: Record<string, string> = {
    "1:1": "1:1 (Square)",
    "2:3": "2:3 (Portrait Photo)",
    "3:2": "3:2 (Photo)",
    "3:4": "3:4 (Portrait Standard)",
    "4:3": "4:3 (Standard)",
    "9:16": "9:16 (Portrait Widescreen)",
    "16:9": "16:9 (Widescreen)",
    "21:9": "21:9 (Ultrawide)",
};

function source(value: unknown): string | undefined {
    return Array.isArray(value) && value.length === 2 ? String(value[0]) : undefined;
}

function activeOutputNodes(workflow: ZealmanWorkflowTemplate) {
    const outputs = Object.entries(workflow).filter(([, node]) => /^(?:VHS_VideoCombine|SaveVideo|SaveImage)$/.test(node.class_type || "") && node.inputs?.save_output !== false);
    const active = new Set<string>();
    const visit = (id: string) => {
        if (active.has(id) || !workflow[id]) return;
        active.add(id);
        for (const value of Object.values(workflow[id].inputs || {})) {
            const upstream = source(value);
            if (upstream) visit(upstream);
        }
    };
    for (const [id] of outputs) visit(id);
    return Object.entries(workflow).filter(([id]) => active.has(id)).map(([, node]) => node);
}

/** A restoration graph consumes existing frames; its duration and dimensions are not generation inputs. */
export function nativeUpscaleControl(workflow: ZealmanWorkflowTemplate) {
    const nodes = activeOutputNodes(workflow);
    const upscalers = nodes.filter((node) => node.class_type === "VOSR2Upscale");
    if (upscalers.length !== 1 || nodes.some((node) => /Sampler|ReferenceToVideo|TextEncode|Empty.*Latent/i.test(node.class_type || ""))) return null;
    const scale = Number(upscalers[0].inputs?.upscale);
    if (!Number.isInteger(scale) || scale < 1) return null;
    const video = nodes.some((node) => /^(?:LoadVideo|VHS_LoadVideo)$/.test(node.class_type || ""));
    if (!video && !nodes.some((node) => node.class_type === "LoadImage")) return null;
    const resize = nodes.find((node) => node.class_type === "JWImageResizeByLongerSide");
    return { kind: video ? "video" as const : "image" as const, scale, preResize: typeof resize?.inputs?.size === "number" ? resize.inputs.size : undefined };
}

/** A depth-only graph processes source frames without generative size/duration controls. */
export function nativeDepthControl(workflow: ZealmanWorkflowTemplate) {
    const nodes = activeOutputNodes(workflow);
    return nodes.some((node) => node.class_type === "ReShotDepthMap")
        && nodes.some((node) => node.class_type === "VHS_LoadVideo")
        && !nodes.some((node) => /Sampler|ReferenceToVideo|TextEncode|Empty.*Latent/i.test(node.class_type || ""));
}

/** SCAIL's shared resize controls both pose and reference frames, not an empty latent. */
export function scailVideoControl(workflow: ZealmanWorkflowTemplate) {
    const nodes = activeOutputNodes(workflow);
    const scail = nodes.filter((node) => node.class_type === "WanSCAILToVideo");
    if (!scail.length) return null;
    const poseId = source(scail[0].inputs?.pose_video);
    const referenceId = source(scail[0].inputs?.reference_image);
    const pose = poseId ? workflow[poseId] : undefined;
    const reference = referenceId ? workflow[referenceId] : undefined;
    if (pose?.class_type !== "ImageResizeKJv2" || reference?.class_type !== "ImageResizeKJv2") return null;
    const widthId = source(pose.inputs?.width);
    const heightId = source(pose.inputs?.height);
    if (!widthId || !heightId || widthId === heightId || source(reference.inputs?.width) !== widthId || source(reference.inputs?.height) !== heightId) return null;
    if (workflow[widthId]?.class_type !== "PrimitiveInt" || workflow[heightId]?.class_type !== "PrimitiveInt") return null;
    const scaleId = source(workflow[widthId].inputs?.value);
    if (!scaleId || source(workflow[heightId].inputs?.value) !== scaleId || workflow[scaleId]?.class_type !== "LayerUtility: ImageScaleByAspectRatio") return null;
    if ((workflow[widthId].inputs?.value as unknown[])?.[1] !== 3 || (workflow[heightId].inputs?.value as unknown[])?.[1] !== 4) return null;
    if (scail.some((node) => source(node.inputs?.pose_video) !== poseId || source(node.inputs?.reference_image) !== referenceId || source(node.inputs?.width) !== poseId || (node.inputs?.width as unknown[])?.[1] !== 1 || source(node.inputs?.height) !== poseId || (node.inputs?.height as unknown[])?.[1] !== 2)) return null;
    const videoId = source(pose.inputs?.image);
    const video = videoId ? workflow[videoId] : undefined;
    if (video?.class_type !== "VHS_LoadVideo" || video.inputs?.select_every_nth !== 1) return null;
    const framesId = source(video.inputs?.frame_load_cap);
    const frames = framesId ? workflow[framesId] : undefined;
    if (frames?.class_type !== "MathExpression|pysssss" || String(frames.inputs?.expression).replace(/\s/g, "") !== "a*b+1") return null;
    const secondsId = source(frames.inputs?.a);
    const fpsId = source(frames.inputs?.b);
    const fps = fpsId ? workflow[fpsId]?.inputs?.value : undefined;
    if (!secondsId || workflow[secondsId]?.class_type !== "PrimitiveInt" || typeof workflow[secondsId].inputs?.value !== "number" || typeof fps !== "number" || fps <= 0 || fps !== video.inputs?.force_rate) return null;
    return { width: `${widthId}:value`, height: `${heightId}:value`, duration: `${secondsId}:value`, videoId: videoId! };
}

export function scailVideoInputValues(workflow: ZealmanWorkflowTemplate, _size: string, quality: string, _seconds: number, referenceSize?: { width: number; height: number }) {
    const control = scailVideoControl(workflow);
    if (!control) return null;
    if (!referenceSize || referenceSize.width <= 0 || referenceSize.height <= 0) throw new Error("无法读取参考图比例，请重新连接参考图。");
    const ratio = `${referenceSize.width}:${referenceSize.height}`;
    const dimensions = zealmanVideoDimensions(ratio, quality);
    return {
        [control.width]: Math.max(32, Math.round(dimensions.width / 32) * 32),
        [control.height]: Math.max(32, Math.round(dimensions.height / 32) * 32),
    };
}

/** Use full source timing and correct the final ratio after model-size alignment. */
export function applyScailReferenceOutput(workflow: ZealmanWorkflowTemplate, quality: string, referenceSize: { width: number; height: number }, sourceDuration: number) {
    const control = scailVideoControl(workflow);
    if (!control) return;
    if (!Number.isFinite(sourceDuration) || sourceDuration <= 0) throw new Error("参考视频没有有效播放时长。");
    const active = activeOutputNodes(workflow);
    const dimensions = zealmanVideoDimensions(`${referenceSize.width}:${referenceSize.height}`, quality);
    const add = (name: string, node: ZealmanWorkflowTemplate[string]) => {
        let id = `canvas_scail_${name}`;
        while (workflow[id]) id += "_";
        workflow[id] = node;
        return id;
    };
    const video = workflow[control.videoId].inputs!;
    video.frame_load_cap = 0;
    video.skip_first_frames = 0;
    const chunks = active.filter((node) => node.class_type === "WanSCAILToVideo");
    const chunk = chunks.at(-1)!;
    const previous = source(chunk.inputs?.previous_frame_count);
    const overlap = Number(previous ? workflow[previous]?.inputs?.value : chunk.inputs?.previous_frame_count);
    const step = Number(chunk.inputs?.length) - overlap;
    for (const loop of active.filter((node) => node.class_type === "TensorLoopOpen")) {
        if (loop.inputs?.mode !== "iterations" || !Number.isInteger(step) || step < 1) throw new Error("Scail2分段循环无法按完整参考视频计算，请检查分段长度与重叠帧数。");
        const iterations = add("iterations", { class_type: "MathExpression|pysssss", inputs: { expression: `ceil(a / ${step}) + 1`, a: [control.videoId, 1] } });
        loop.inputs["mode.iterations"] = [iterations, 0];
    }
    for (const save of active.filter((node) => node.class_type === "VHS_VideoCombine")) {
        const images = save.inputs?.images;
        if (!Array.isArray(images)) continue;
        const resize = add("output_size", { class_type: "ImageScale", inputs: { image: images, upscale_method: "lanczos", width: Math.max(2, Math.round(dimensions.width / 2) * 2), height: Math.max(2, Math.round(dimensions.height / 2) * 2), crop: "disabled" } });
        const count = add("output_frames", { class_type: "GetImageSize", inputs: { image: [resize, 0] } });
        const rate = add("output_rate", { class_type: "MathExpression|pysssss", inputs: { expression: "a / b", a: [count, 2], b: sourceDuration } });
        save.inputs!.images = [resize, 0];
        save.inputs!.frame_rate = [rate, 1];
    }
}

/** Limit adaptation to the H3 resolution graph, never resize reference-image loaders. */
export function h3ResolutionControl(workflow: ZealmanWorkflowTemplate) {
    const nodes = activeOutputNodes(workflow);
    const h3 = nodes.filter((node) => node.class_type === "MiniMaxH3ReferenceToVideo");
    if (!h3.length) return null;
    const width = h3[0].inputs?.width;
    const height = h3[0].inputs?.height;
    const id = source(width);
    if (!id || source(height) !== id || !Array.isArray(width) || width[1] !== 0 || !Array.isArray(height) || height[1] !== 1) return null;
    if (h3.some((node) => source(node.inputs?.width) !== id || source(node.inputs?.height) !== id || (node.inputs?.width as unknown[])?.[1] !== 0 || (node.inputs?.height as unknown[])?.[1] !== 1)) return null;
    const node = workflow[id];
    if (node?.class_type !== "ResolutionSelector" || typeof node.inputs?.aspect_ratio !== "string" || typeof node.inputs.megapixels !== "number") return null;

    const scalers = nodes.filter((item) => item.class_type === "MinimaxH3LatentUpscaler3D");
    let scale = 1;
    if (scalers.length > 1) return null;
    if (scalers.length === 1) {
        const inputs = scalers[0].inputs;
        const scaleValue = inputs?.["mode.scale"];
        const scaleSource = source(scaleValue);
        scale = Number(scaleSource ? workflow[scaleSource]?.inputs?.value : scaleValue);
        if (inputs?.mode !== "scale by multiplier" || !Number.isFinite(scale) || scale < 1 || scale > 4) return null;
    }
    return { id, scale, defaultRatio: node.inputs.aspect_ratio.split(" ")[0], multiple: Number(node.inputs.multiple) || 32 };
}

export function zealmanVideoDimensions(size: string, quality: string, defaultRatio = "16:9") {
    const ratio = !size || size === "auto" || size === "adaptive" ? defaultRatio : size;
    const match = ratio.match(/^(\d+)(?::|x)(\d+)$/);
    if (!match || Number(match[1]) <= 0 || Number(match[2]) <= 0) throw new Error("云端视频画面比例无效，请重新选择。");
    const aspect = Number(match[1]) / Number(match[2]);
    const normalized = quality.toLowerCase().replace(/p$/, "");
    const shortEdge = normalized === "4k" ? 2160 : normalized === "low" ? 480 : ["", "auto", "medium", "high"].includes(normalized) ? 720 : Number(normalized);
    if (![480, 720, 1080, 2160].includes(shortEdge)) throw new Error("云端视频分辨率无效，请选择480P、720P、1080P或4K。");
    return { width: aspect >= 1 ? Math.round(shortEdge * aspect) : shortEdge, height: aspect >= 1 ? shortEdge : Math.round(shortEdge / aspect) };
}

/** Target the final resolution while retaining the workflow's 1x/1.5x/2x sampling recipe. */
export function h3ResolutionInputValues(workflow: ZealmanWorkflowTemplate, size: string, quality: string) {
    const control = h3ResolutionControl(workflow);
    if (!control) return null;
    const { width, height } = zealmanVideoDimensions(size, quality, control.defaultRatio);
    const ratio = Object.keys(ratios).find((key) => {
        const [w, h] = key.split(":").map(Number);
        return Math.abs(w / h - width / height) < 0.002;
    });
    if (!ratio) throw new Error("当前H3工作流不支持此比例，请选择标准横屏、竖屏或方形比例。");
    const megapixels = width * height / (control.scale ** 2 * 1024 ** 2);
    if (megapixels < 0.1 || megapixels > 16) throw new Error("所选分辨率超出当前工作流分辨率节点范围，请调整清晰度或选择其他工作流。");
    return {
        [`${control.id}:aspect_ratio`]: ratios[ratio],
        [`${control.id}:megapixels`]: megapixels,
    };
}

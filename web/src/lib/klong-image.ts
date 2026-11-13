/** Klong Images API: https://docs.klong.lat/docs/image/gpt-image-2 */
export function isKlongImageConfig(config: { baseUrl?: string; apiFormat?: string }) {
    try {
        const url = new URL(config.baseUrl || "");
        return (!config.apiFormat || config.apiFormat === "openai") && url.protocol === "https:" && url.hostname === "api.klong.lat" && !url.username && !url.password;
    } catch {
        return false;
    }
}

export function buildKlongImageBody(input: { model: string; prompt: string; n: number; size?: string; quality?: string; images?: string[]; referenceSize?: { width: number; height: number } }) {
    const size = (input.size || "auto").trim();
    const quality = (input.quality || "1k").trim().toLowerCase();
    const imageSize = ["4k", "high"].includes(quality) ? "4K" : ["2k", "medium", "hd"].includes(quality) ? "2K" : "1K";
    const aspect = size.match(/^(\d+):(\d+)$/);
    const width = aspect ? Number(aspect[1]) : input.referenceSize?.width || 1;
    const height = aspect ? Number(aspect[2]) : input.referenceSize?.height || 1;
    if (width <= 0 || height <= 0 || !Number.isFinite(width / height)) throw new Error("恐龙生图的宽高比无效");
    // 普通 GPT-Image 渠道实测会忽略 image_size；明确像素尺寸才能稳定传递 2K/4K。
    const square = width === height;
    const longEdge = imageSize === "4K" ? square ? 4096 : 3840 : imageSize === "2K" ? square ? 2048 : 2560 : square ? 1024 : 1536;
    const ratio = width / height;
    const pixelSize = /^\d+x\d+$/i.test(size) ? size.toLowerCase() : ratio >= 1 ? `${longEdge}x${Math.max(64, Math.round(longEdge / ratio))}` : `${Math.max(64, Math.round(longEdge * ratio))}x${longEdge}`;
    return {
        model: input.model,
        prompt: input.prompt,
        n: input.n,
        size: pixelSize,
        quality: imageSize === "4K" ? "high" : imageSize === "2K" ? "medium" : "low",
        response_format: "b64_json",
        output_format: "png",
        // 当前 GPT-Image 分组的 /edits 实测识别 image，reference_images 会被当成缺图。
        ...(input.images?.length ? { image: input.images } : {}),
    };
}

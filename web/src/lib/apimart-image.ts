/** APIMart gpt-image-2：size=宽高比，resolution=1k/2k/4k */

const ASPECTS = ["auto", "1:1", "1:3", "3:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "5:4", "4:5", "2:1", "1:2", "21:9", "9:21"] as const;

export function normalizeImageResolution(value?: string) {
    const text = (value || "").trim().toLowerCase();
    if (text === "2k" || text === "medium" || text === "hd") return "2k";
    if (text === "4k" || text === "high") return "4k";
    return "1k";
}

export function normalizeImageAspect(value?: string) {
    const text = (value || "").trim();
    if (!text) return "auto";
    if ((ASPECTS as readonly string[]).includes(text)) return text;
    const pixels = text.match(/^(\d+)x(\d+)$/i);
    if (pixels) {
        const width = Number(pixels[1]);
        const height = Number(pixels[2]);
        const target = width / Math.max(1, height);
        let best = "1:1";
        let bestDiff = Infinity;
        for (const item of ASPECTS) {
            if (item === "auto") continue;
            const [w, h] = item.split(":").map(Number);
            const diff = Math.abs(w / h - target);
            if (diff < bestDiff) {
                best = item;
                bestDiff = diff;
            }
        }
        return best;
    }
    return "auto";
}

export function buildApimartImageBody(input: {
    model: string;
    prompt: string;
    n: number;
    size?: string;
    quality?: string;
    imageUrls?: string[];
}) {
    const size = normalizeImageAspect(input.size);
    const resolution = normalizeImageResolution(input.quality);
    return {
        model: input.model,
        prompt: input.prompt,
        n: input.n,
        size,
        resolution,
        ...(input.imageUrls?.length ? { image_urls: input.imageUrls } : {}),
    };
}

/** chatgpt2api 使用 quality，而不是 APIMart 的 resolution。 */
export function buildChatgpt2ApiImageBody(input: {
    model: string;
    prompt: string;
    n: number;
    size?: string;
    quality?: string;
}) {
    return {
        model: input.model,
        prompt: input.prompt,
        n: input.n,
        size: normalizeImageAspect(input.size),
        quality: normalizeImageResolution(input.quality),
        response_format: "b64_json",
    };
}

const GEEKNOW_GPT_IMAGE_2_PIXELS: Record<string, string> = {
    "1:1": "1024x1024",
    "4:3": "1536x1152",
    "3:4": "1152x1536",
    "3:2": "1536x1024",
    "2:3": "1024x1536",
    "16:9": "1920x1080",
    "9:16": "1080x1920",
    auto: "1024x1024",
};

export function isGptImage2Family(model?: string) {
    return /gpt-image-2/i.test(model || "");
}

export function usesOpenAiMaskEdits(model?: string) {
    const text = (model || "").toLowerCase();
    return text.includes("gpt-image-1") || text.includes("dall-e") || text.includes("dalle");
}

export function isGeeknowImageHost(baseUrl?: string) {
    return /geeknow\.(ai|top)/i.test(baseUrl || "");
}

/** 本地 chatgpt2api 默认端口及其 SSH 隧道入口。 */
export function isChatgpt2ApiUrl(baseUrl?: string) {
    try {
        const url = new URL((baseUrl || "").trim());
        return (url.hostname === "127.0.0.1" || url.hostname === "localhost") && (url.port === "3080" || url.port === "3081");
    } catch {
        return false;
    }
}

/** Geeknow gpt-image-2 的 size 必须是像素，例如 16:9 → 1920x1080。 */
export function gptImage2PixelSize(size?: string) {
    const aspect = normalizeImageAspect(size);
    return GEEKNOW_GPT_IMAGE_2_PIXELS[aspect] || GEEKNOW_GPT_IMAGE_2_PIXELS["1:1"];
}

export function toImageBase64(dataUrl: string) {
    const match = dataUrl.match(/^data:image\/[^;]+;base64,(.+)$/i);
    return match?.[1] || dataUrl;
}

export function buildGeeknowGptImage2Body(input: {
    model: string;
    prompt: string;
    n: number;
    size?: string;
    imageUrls?: string[];
}) {
    return {
        model: input.model,
        prompt: input.prompt,
        n: input.n,
        size: gptImage2PixelSize(input.size),
        ...(input.imageUrls?.length ? { image: input.imageUrls.map(toImageBase64) } : {}),
    };
}

/** OpenAI `/images/edits` 只用像素尺寸或 auto，不能把 APIMart 的 16:9 / 1k 原样带过去。 */
export function normalizeOpenAiEditSize(value?: string) {
    const text = (value || "").trim();
    return /^\d+x\d+$/i.test(text) ? text.toLowerCase() : "auto";
}

export function normalizeOpenAiEditQuality(value?: string) {
    const text = (value || "").trim().toLowerCase();
    if (text === "1k" || text === "low") return "low";
    if (text === "2k" || text === "medium" || text === "hd") return "medium";
    if (text === "4k" || text === "high") return "high";
    return "auto";
}

export function buildOpenAiImageEditFields(input: {
    model: string;
    prompt: string;
    n: number;
    size?: string;
    quality?: string;
}) {
    return {
        model: input.model,
        prompt: input.prompt,
        n: input.n,
        size: normalizeOpenAiEditSize(input.size),
        quality: normalizeOpenAiEditQuality(input.quality),
    };
}

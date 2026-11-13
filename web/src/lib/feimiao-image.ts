/** 飞喵公开目录声明的 OpenAI 聊天生图模型。 */
export function isFeimiaoChatImage(config: { baseUrl: string; model: string; apiFormat: string }) {
    if (config.apiFormat !== "openai" || !["gpt-image-2-pro", "gpt-image-2.5-sunburst", "gpt-image-2.5-flare"].includes(config.model)) return false;
    try {
        return ["fmgo.top", "www.fmgo.top", "api.fmgo.top"].includes(new URL(config.baseUrl).hostname);
    } catch {
        return false;
    }
}

export function buildFeimiaoChatImageBody(model: string, prompt: string, images: string[], size: string, quality: string, n: number) {
    if (n !== 1) throw new Error("飞喵聊天生图每次生成 1 张，请使用画布独立多图任务");
    const format = size.trim().toLowerCase();
    const ratio = format.match(/^(\d+):(\d+)$/);
    const pixels = format.match(/^(\d+)x(\d+)$/);
    if (format && format !== "auto" && !ratio && !pixels) throw new Error("飞喵图片尺寸需为宽高比或像素尺寸");
    const dimensions = ratio || pixels;
    if (dimensions && (!Number(dimensions[1]) || !Number(dimensions[2]))) throw new Error("图片宽高必须大于零");
    // Match https://www.fmgo.top/generate-image.html's build request contract.
    // Keep requirements in the first text block as well.
    const divisor = (a: number, b: number): number => b ? divisor(b, a % b) : a;
    const width = dimensions ? Number(dimensions[1]) : 0;
    const height = dimensions ? Number(dimensions[2]) : 0;
    const gcd = dimensions ? divisor(width, height) : 1;
    const aspectRatio = dimensions ? `${width / gcd}:${height / gcd}` : undefined;
    const resolution = ({ low: "1k", standard: "1k", medium: "2k", hd: "2k", high: "4k", "1k": "1k", "2k": "2k", "4k": "4k" } as Record<string, string>)[quality.trim().toLowerCase()];
    const requirements = ["请生成并返回一张图片。", size && size !== "auto" ? `输出画幅：${size}。` : "", quality && quality !== "auto" ? `期望清晰度：${quality}，实际输出以模型能力为准。` : ""].filter(Boolean).join(" ");
    return {
        model,
        stream: false,
        generationConfig: { imageConfig: {
            ...(aspectRatio ? { aspectRatio } : {}),
            ...(resolution ? { imageSize: resolution } : {}),
        } },
        messages: [{ role: "user", content: [
            { type: "text", text: `${prompt}\n\n${requirements}` },
            ...images.map(url => ({ type: "image_url", image_url: { url } })),
        ] }],
    };
}

export function readFeimiaoChatImages(payload: unknown): string[] {
    const urls = new Set<string>();
    const add = (value: unknown) => {
        if (typeof value === "string" && /^(https?:\/\/|data:image\/)/i.test(value)) urls.add(value);
    };
    const textImages = (text: string) => {
        for (const match of text.matchAll(/!\[[^\]]*\]\(\s*<?((?:https?:\/\/|data:image\/)[^\s>]+?)>?(?:\s+"[^"]*")?\s*\)/gi)) add(match[1]);
        if (/^(https?:\/\/\S+|data:image\/\S+)$/i.test(text.trim())) add(text.trim());
    };
    const content = (value: unknown) => {
        if (typeof value === "string") return textImages(value);
        if (!Array.isArray(value)) return;
        for (const part of value) {
            if (!part || typeof part !== "object") continue;
            if (part.type === "text" && typeof part.text === "string") textImages(part.text);
            if (part.type === "image_url" || part.type === "image") add(typeof part.image_url === "string" ? part.image_url : part.image_url?.url || part.url);
        }
    };
    if (!payload || typeof payload !== "object") return [];
    const data = payload as { choices?: Array<{ message?: { content?: unknown; images?: unknown } }>; data?: Array<{ url?: string; b64_json?: string }> };
    for (const choice of data.choices || []) {
        content(choice.message?.content);
        content(choice.message?.images);
    }
    if (Array.isArray(data.data)) for (const item of data.data) add(item.b64_json ? `data:image/png;base64,${item.b64_json}` : item.url);
    const resultImages = (value: unknown) => {
        if (typeof value === "string") return add(value);
        if (Array.isArray(value)) return value.forEach(resultImages);
        if (!value || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        for (const key of ["result_url", "result_urls", "image_url", "url", "result", "images", "output", "media", "data"]) resultImages(record[key]);
    };
    resultImages(payload);
    return [...urls];
}

export function readFeimiaoImageTask(payload: unknown) {
    const outer = payload && typeof payload === "object" ? payload as Record<string, unknown> : {};
    const root = outer.data && typeof outer.data === "object" && !Array.isArray(outer.data) ? outer.data as Record<string, unknown> : outer;
    const status = String(root.status || "").toLowerCase();
    const taskId = typeof root.task_id === "string" ? root.task_id : status && typeof root.id === "string" ? root.id : "";
    if (["failed", "error", "cancelled", "canceled"].includes(status)) {
        const error = root.error;
        throw new Error(typeof error === "string" ? error : error && typeof error === "object" && "message" in error ? String(error.message) : String(root.error_message || "飞喵生图任务失败"));
    }
    return { taskId, status, images: readFeimiaoChatImages(payload) };
}

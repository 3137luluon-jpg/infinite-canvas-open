/** Official OpenAI uses pixel size and quality, never APIMart resolution/image_urls. */
export function isOfficialOpenAiImageUrl(baseUrl: string) {
    try { return new URL(baseUrl).hostname === "api.openai.com"; } catch { return false; }
}

export function buildOfficialImageFields(input: { model: string; prompt: string; n: number; size?: string; quality?: string }) {
    const quality = (input.quality || "auto").toLowerCase();
    const modern = /^gpt-image-2(?:[.-]|$)/i.test(input.model);
    let size = input.size || "auto";
    if (size !== "auto" && !/^\d+x\d+$/i.test(size)) {
        const match = size.match(/^(\d+):(\d+)$/);
        if (!match) throw new Error("官方生图尺寸格式无效，请重新选择比例");
        const ratio = Number(match[1]) / Number(match[2]);
        if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 3 || ratio < 1 / 3) throw new Error("官方生图请选择 3:1 至 1:3 范围内的比例");
        if (modern) {
            // Exact aspect, 16px steps, <=3840 edge and <=8,294,400 pixels.
            const budget = quality === "4k" ? 8294400 : quality === "2k" ? 4194304 : 1048576;
            let w = Number(match[1]), h = Number(match[2]);
            const gcd = (a: number, b: number): number => b ? gcd(b, a % b) : a;
            const divisor = gcd(w, h);
            w /= divisor; h /= divisor;
            const step = Math.floor(Math.min(Math.sqrt(budget / (w * h * 256)), 3840 / (16 * Math.max(w, h))));
            const width = w * step * 16;
            const height = h * step * 16;
            if (width * height < 655360) throw new Error("该比例无法在官方像素限制内生成，请选择其他比例");
            size = `${width}x${height}`;
        } else {
            if (quality === "4k") throw new Error("当前官方模型未配置 4K 尺寸支持，请选择 GPT Image 2 系列模型");
            size = ratio > 1 ? "1536x1024" : ratio < 1 ? "1024x1536" : "1024x1024";
        }
    }
    if (modern && size !== "auto") {
        const [width, height] = size.toLowerCase().split("x").map(Number);
        if (!width || !height || width % 16 || height % 16 || Math.max(width, height) > 3840 || Math.max(width / height, height / width) > 3 || width * height < 655360 || width * height > 8294400) {
            throw new Error("官方生图尺寸超限：边长须为16的倍数且不超过3840，总像素须在655360至8294400内；请重新选择比例后点击发送。");
        }
    }
    return { model: input.model, prompt: input.prompt, n: input.n, size, quality: quality === "4k" ? "high" : quality === "2k" ? "medium" : quality === "1k" ? "low" : quality };
}

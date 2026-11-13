export type ZealmanVideoResult = {
    type?: string;
    url?: string;
    video_url?: string;
    result_url?: string;
    file_url?: string;
    path?: string;
    filename?: string;
    subfolder?: string;
    mime?: string;
    mime_type?: string;
    mimeType?: string;
    [key: string]: unknown;
};

const videoExtension = /\.(?:mp4|m4v|webm|mov|avi|mkv)$/i;

/** LoadImage/LoadVideo previews are returned alongside generated outputs by ZEALMAN. */
export function isUploadedReferenceResult(result: ZealmanVideoResult) {
    const raw = result.raw && typeof result.raw === "object" ? result.raw as Record<string, unknown> : undefined;
    if (result.type === "input" || raw?.type === "input") return true;
    for (const url of [result.url, result.video_url, result.file_url, result.result_url, result.path]) {
        if (typeof url !== "string") continue;
        try {
            const parsed = new URL(url, "http://comfy.invalid");
            if (parsed.searchParams.get("type") === "input" || parsed.pathname.startsWith("/input/")) return true;
        } catch { /* A non-URL path is handled by the media parser. */ }
    }
    return false;
}

export function zealmanWorkflowError(response: unknown) {
    if (!response || typeof response !== "object") return "";
    const record = response as Record<string, unknown>;
    const error = record.error;
    if (typeof error === "string") return error;
    if (error && typeof error === "object" && typeof (error as Record<string, unknown>).message === "string") return String((error as Record<string, unknown>).message);
    return "";
}

export function collectWorkflowResults(response: unknown, comfyBaseUrl: string) {
    const results: ZealmanVideoResult[] = [];
    const makeViewUrl = (filename: string, subfolder = "") => {
        const viewUrl = new URL("/view", comfyBaseUrl.replace(/\/+$/, ""));
        viewUrl.search = new URLSearchParams({ filename, subfolder, type: "output" }).toString();
        return viewUrl.toString();
    };
    const visit = (value: unknown, fieldName = "") => {
        if (Array.isArray(value)) {
            value.forEach((child) => visit(child, fieldName));
            return;
        }
        if (typeof value === "string") {
            if (/video|videos|gifs|files|output/i.test(fieldName)) {
                const url = /^https?:\/\//i.test(value) || value.startsWith("/") ? value : videoExtension.test(value) ? makeViewUrl(value) : "";
                if (url) results.push({ type: fieldName, url });
            }
            return;
        }
        if (!value || typeof value !== "object") return;
        const item = value as ZealmanVideoResult;
        if (isUploadedReferenceResult(item)) return;
        const url = [item.url, item.video_url, item.result_url, item.file_url, item.path].find((candidate) => typeof candidate === "string" && candidate.trim());
        const candidate = { ...item, ...(typeof url === "string" ? { url } : {}) };
        if (typeof item.file_url === "string" || typeof item.video_url === "string" || typeof item.result_url === "string") {
            candidate.type = `${candidate.type || ""} ${typeof item.file_url === "string" ? "file_url" : ""} ${typeof item.video_url === "string" ? "video_url" : ""} ${typeof item.result_url === "string" ? "result_url" : ""}`;
        }
        if (typeof candidate.url === "string" || typeof candidate.filename === "string") {
            if (!candidate.url && candidate.filename && videoExtension.test(candidate.filename)) {
                candidate.url = makeViewUrl(candidate.filename, candidate.subfolder || "");
            }
            results.push(candidate);
        }
        for (const [key, child] of Object.entries(item)) {
            if (["prompt", "inputs", "input_values", "workflow_template", "extra_data"].includes(key)) continue;
            if ((child && typeof child === "object") || typeof child === "string") visit(child, key);
        }
    };
    visit(response);
    return results;
}

export function isVideoWorkflowResult(result: ZealmanVideoResult) {
    if (isUploadedReferenceResult(result)) return false;
    const mediaHint = `${result.type || ""} ${result.mime || ""} ${result.mime_type || ""} ${result.mimeType || ""} ${result.url || ""} ${result.filename || ""}`;
    const hasVideoUrlField = typeof result.video_url === "string" || typeof result.result_url === "string" || typeof result.file_url === "string";
    return (/video|\.(?:mp4|m4v|webm|mov|avi|mkv)(?:$|[?#&])/i.test(mediaHint) || hasVideoUrlField) && Boolean(result.url);
}

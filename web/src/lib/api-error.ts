import i18n from "@/i18n";

const DISPLAY_MAX = 180;

const apiText = (key: string, options?: Record<string, unknown>) => i18n.t(`apiErrors.${key}`, options);

/** 从接口/异常里摘出可展示的短错误，避免把整段 prompt 或 HTML 堆到节点上 */
export function summarizeApiError(value: unknown, fallback = ""): string {
    const text = extractApiErrorMessage(value) || fallback;
    return clampErrorText(text);
}

function extractApiErrorMessage(value: unknown): string {
    if (!value) return "";
    if (typeof value === "string") return extractFromString(value);
    if (Array.isArray(value)) return extractFromDetailArray(value);
    if (typeof value !== "object") return "";

    const payload = value as {
        msg?: unknown;
        message?: unknown;
        error?: unknown;
        detail?: unknown;
        status_code?: unknown;
    };
    const errorMsg = typeof payload.error === "string" ? payload.error : (payload.error as { message?: unknown } | undefined)?.message;
    return (
        extractApiErrorMessage(payload.msg) ||
        extractApiErrorMessage(payload.message) ||
        extractApiErrorMessage(errorMsg) ||
        extractApiErrorMessage(payload.detail) ||
        ""
    );
}

function extractFromString(value: string) {
    const trimmed = value.trim();
    if (!trimmed) return "";

    // 常见：status_code=422, {"detail":[...]}
    const prefixed = trimmed.match(/^status_code\s*=\s*\d+\s*,\s*(\{[\s\S]*\}|\[[\s\S]*\])\s*$/i);
    if (prefixed?.[1]) {
        const fromJson = extractApiErrorMessage(tryParseJson(prefixed[1]));
        if (fromJson) return fromJson;
    }

    const jsonStart = trimmed.search(/[\{\[]/);
    if (jsonStart >= 0) {
        const fromJson = extractApiErrorMessage(tryParseJson(trimmed.slice(jsonStart)));
        if (fromJson) return fromJson;
    }

    const tooLong = trimmed.match(/at most\s+(\d+)\s+characters/i) || trimmed.match(/最多\s*(\d+)\s*字/);
    if (tooLong || /string_too_long/i.test(trimmed)) {
        const max = Number(tooLong?.[1]);
        return max ? apiText("feimiaoPromptTooLong", { max, length: "…" }) : trimmed;
    }

    if (/internal server error/i.test(trimmed)) return apiText("serviceInternalError");
    if (/<[a-z][\s\S]*>/i.test(trimmed)) return apiText("htmlError", { preview: `${trimmed.slice(0, 80)}...` });
    return trimmed;
}

function extractFromDetailArray(value: unknown[]) {
    const parts = value
        .map((item) => {
            if (!item || typeof item !== "object") return extractApiErrorMessage(item);
            const row = item as {
                msg?: unknown;
                message?: unknown;
                loc?: unknown;
                type?: unknown;
                input?: unknown;
                ctx?: { max_length?: unknown };
            };
            if (row.type === "string_too_long" || (typeof row.msg === "string" && /at most\s+\d+\s+characters/i.test(row.msg))) {
                const max = Number(row.ctx?.max_length) || Number(String(row.msg).match(/at most\s+(\d+)/i)?.[1]);
                const length = typeof row.input === "string" ? [...row.input].length : "…";
                return max ? apiText("feimiaoPromptTooLong", { max, length }) : extractApiErrorMessage(row.msg) || apiText("videoGenerationFailed");
            }
            const msg = extractApiErrorMessage(row.msg) || extractApiErrorMessage(row.message);
            if (!msg) return "";
            // 不拼接 loc/input，避免把超长原文带进界面
            return msg;
        })
        .filter(Boolean);
    return parts.join("；");
}

function tryParseJson(text: string) {
    try {
        return JSON.parse(text);
    } catch {
        // 截断 JSON 时尽量抠出 detail 数组
        const detailMatch = text.match(/"detail"\s*:\s*(\[[\s\S]*?\])\s*[,}]/);
        if (detailMatch?.[1]) {
            try {
                return { detail: JSON.parse(detailMatch[1]) };
            } catch {
                /* ignore */
            }
        }
        return null;
    }
}

function clampErrorText(text: string) {
    const normalized = text.replace(/\s+/g, " ").trim();
    if (!normalized) return "";
    if ([...normalized].length <= DISPLAY_MAX) return normalized;
    return `${[...normalized].slice(0, DISPLAY_MAX).join("")}…`;
}

import type { AiTextMessage } from "./image";

/** Only an HTTP rejection before a Responses stream starts may switch endpoints. */
export class ResponsesEndpointError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
        super(message);
        this.name = "ResponsesEndpointError";
        this.status = status;
    }
}

function unsupportedResponses(error: unknown): error is ResponsesEndpointError {
    if (!(error instanceof ResponsesEndpointError)) return false;
    if (error.status === 501 || error.status === 405) return true;
    if (![400, 404, 500].includes(error.status)) return false;
    // Do not treat a missing model, bad credentials, quota or a transient failure
    // as permission to submit the same request to another endpoint.
    return /^not implemented(?:\s*\(request id:[^)]+\))?\s*$/i.test(error.message.trim())
        || /(?:responses|endpoint|route).*(?:not supported|unsupported|not implemented|not found)/i.test(error.message)
        || /(?:not supported|unsupported|not implemented).*(?:responses|endpoint|route)/i.test(error.message);
}

type ChatPayload = {
    error?: { message?: string };
    message?: string;
    msg?: string;
    code?: number;
    choices?: Array<{
        delta?: { content?: unknown; refusal?: string };
        message?: { content?: unknown; refusal?: string };
    }>;
};

function chatContent(content: unknown): string {
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return "";
    return content.map(part => part && typeof part.text === "string" ? part.text : "").join("");
}

function chatError(payload: ChatPayload): string | undefined {
    return payload.error?.message
        || (typeof payload.code === "number" && payload.code !== 0 ? payload.msg || payload.message || "文本请求失败" : undefined)
        || payload.choices?.[0]?.delta?.refusal || payload.choices?.[0]?.message?.refusal;
}

type CompatibleTextOptions = {
    responses: () => Promise<string>;
    chatUrl: string;
    headers: Record<string, string>;
    model: string;
    messages: AiTextMessage[];
    reasoningEffort?: string;
    signal?: AbortSignal;
    onDelta: (text: string) => void;
};

export async function requestOpenAiCompatibleText(options: CompatibleTextOptions): Promise<string> {
    try {
        return await options.responses();
    } catch (error) {
        if (!unsupportedResponses(error)) throw error;
    }
    options.signal?.throwIfAborted();
    const response = await fetch(options.chatUrl, {
        method: "POST",
        headers: { ...options.headers, Accept: "text/event-stream" },
        body: JSON.stringify({
            model: options.model,
            messages: options.messages,
            stream: true,
            ...(options.reasoningEffort && options.reasoningEffort !== "auto" ? { reasoning_effort: options.reasoningEffort } : {}),
        }),
        signal: options.signal,
    });
    if (!response.ok) {
        const raw = await response.text();
        let detail = raw.slice(0, 300);
        try { const payload = JSON.parse(raw) as ChatPayload; detail = chatError(payload) || payload.message || payload.msg || detail; } catch { /* plain HTTP error */ }
        throw new Error(`Chat Completions（HTTP ${response.status}）：${detail || "文本请求失败"}`);
    }
    if (!response.headers.get("content-type")?.includes("text/event-stream")) {
        const payload = await response.json() as ChatPayload;
        const error = chatError(payload);
        if (error) throw new Error(error);
        const content = chatContent(payload.choices?.[0]?.message?.content);
        if (!content.trim()) throw new Error("模型没有返回文本内容");
        options.onDelta(content);
        return content;
    }
    if (!response.body) throw new Error("模型没有返回文本内容");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "", content = "", finished = false;
    const consume = (block: string) => {
        const data = block.split(/\r?\n/).filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n").trim();
        if (!data || finished) return;
        if (data === "[DONE]") { finished = true; return; }
        const payload = JSON.parse(data) as ChatPayload;
        const error = chatError(payload);
        if (error) throw new Error(error);
        const delta = chatContent(payload.choices?.[0]?.delta?.content);
        if (delta) { content += delta; options.onDelta(content); }
    };
    try {
        for (;;) {
            const { done, value } = await reader.read();
            buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
            let boundary: RegExpMatchArray | null;
            while ((boundary = buffer.match(/\r?\n\r?\n/))) {
                const index = boundary.index!;
                consume(buffer.slice(0, index));
                buffer = buffer.slice(index + boundary[0].length);
            }
            if (done || finished) { if (buffer.trim() && !finished) consume(buffer); break; }
        }
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
    if (!content.trim()) throw new Error("模型没有返回文本内容");
    return content;
}

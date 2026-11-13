import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

const hosts = new Set(["www.runninghub.ai", "runninghub.ai", "www.runninghub.cn", "runninghub.cn"]);
const paths = new Set(["/api/openapi/getJsonApiFormat", "/task/openapi/upload", "/task/openapi/create", "/task/openapi/outputs"]);

/** Same-origin, loopback-only gateway. No persisted credentials and no arbitrary URL forwarding. */
export async function runningHubWorkflowMiddleware(req: IncomingMessage, res: ServerResponse) {
    const address = req.socket.remoteAddress || "";
    const host = req.headers.host || "";
    const origin = req.headers.origin || "";
    if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(address) || !["localhost:3000", "127.0.0.1:5173"].includes(host) || origin !== `http://${host}` || req.method !== "POST" || (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")) {
        res.statusCode = 403; res.end("RunningHub gateway requires a local same-origin request"); return;
    }
    const query = new URL(req.url || "", "http://localhost").searchParams;
    const remoteHost = query.get("host") || "";
    const path = query.get("endpoint") || "";
    if (!hosts.has(remoteHost) || !paths.has(path) || !req.headers.authorization?.startsWith("Bearer ")) {
        res.statusCode = 400; res.end("Invalid RunningHub endpoint or missing authorization"); return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    const onClose = () => { if (!res.writableFinished) controller.abort(); };
    res.once("close", onClose);
    try {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) {
            const bytes = Buffer.from(chunk); size += bytes.length;
            if (size > 32 * 1024 * 1024) { res.statusCode = 413; res.end("Upload exceeds 32MB"); return; }
            chunks.push(bytes);
        }
        const upstream = await fetch(`https://${remoteHost}${path}`, {
            method: "POST", redirect: "error", signal: controller.signal,
            headers: { Authorization: req.headers.authorization, "Content-Type": req.headers["content-type"] || "application/json" },
            body: Buffer.concat(chunks),
        });
        res.statusCode = upstream.status;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        res.end(await upstream.text());
    } catch {
        // Do not expose request bodies, authorization headers or upstream URLs in logs/errors.
        if (!res.writableEnded && !res.destroyed) {
            res.statusCode = 502; res.setHeader("Content-Type", "application/json");
            res.end(JSON.stringify({ code: -1, msg: "RunningHub 网络中断；若正在提交，请先核对平台任务记录，勿重复提交" }));
        }
    } finally { clearTimeout(timer); res.off("close", onClose); }
}

export function runningHubWorkflowProxy(): Plugin {
    return {
        name: "runninghub-workflow-gateway",
        configureServer(server) { server.middlewares.use("/__runninghub-workflow", runningHubWorkflowMiddleware); },
        configurePreviewServer(server) { server.middlewares.use("/__runninghub-workflow", runningHubWorkflowMiddleware); },
    };
}

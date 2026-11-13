import { readdirSync, readFileSync } from "node:fs";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { parseChangelog } from "./src/lib/release";
import { fmgoPricingPlugin } from "./plugins/fmgo-pricing";
import { runningHubWorkflowProxy } from "./plugins/runninghub-workflow-proxy";
import { canvasBackupService } from "./plugins/canvas-backup-service";
import { jianyingDraft } from "./plugins/jianying-draft";

const webDir = dirname(fileURLToPath(import.meta.url));
const localVersion = readFileSync(resolve(webDir, "../VERSION"), "utf8").trim() || "dev";
const localChangelog = readFileSync(resolve(webDir, "../CHANGELOG.md"), "utf8");
const MEDIA_PROXY_PATH = "/__media-proxy";
const SERVER_HEALTH_PATH = "/__server-health";

function isPrivateMediaHost(hostname: string) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (host === "localhost" || host.endsWith(".local")) return true;
    if (isIP(host) === 6) return host === "::" || host === "::1" || host.startsWith("fc") || host.startsWith("fd") || /^fe[89ab]/.test(host);
    if (isIP(host) !== 4) return false;
    const [a, b] = host.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
}

function assertMediaTarget(target: URL) {
    if (target.protocol !== "https:" || isPrivateMediaHost(target.hostname)) throw new Error("unsupported media host");
}

async function fetchMediaTarget(initial: URL, signal: AbortSignal) {
    let target = initial;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
        assertMediaTarget(target);
        const response = await fetch(target, { redirect: "manual", signal });
        if (response.status < 300 || response.status >= 400) return response;
        const location = response.headers.get("location");
        await response.body?.cancel();
        if (!location) throw new Error(`media redirect failed: ${response.status}`);
        target = new URL(location, target);
    }
    throw new Error("too many media redirects");
}

function mediaProxy(): Plugin {
    const middleware = async (req: IncomingMessage, res: ServerResponse) => {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10 * 60_000);
        const onClose = () => {
            if (!res.writableFinished) controller.abort();
        };
        res.once("close", onClose);
        try {
            const target = new URL(new URL(req.url || "", "http://localhost").searchParams.get("url") || "");
            if (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin") throw new Error("cross-site proxy request denied");
            const response = await fetchMediaTarget(target, controller.signal);
            if (!response.ok || !response.body) {
                await response.body?.cancel();
                throw new Error(`media download failed: ${response.status}`);
            }
            res.statusCode = 200;
            res.setHeader("Content-Type", response.headers.get("content-type") || "application/octet-stream");
            const length = response.headers.get("content-length");
            if (length) res.setHeader("Content-Length", length);
            await pipeline(Readable.fromWeb(response.body as import("node:stream/web").ReadableStream), res, { signal: controller.signal });
        } catch (error) {
            console.warn("[media-proxy] download failed", error instanceof Error ? error.name : "Error");
            if (!res.destroyed && !res.writableEnded) {
                if (res.headersSent) res.destroy();
                else {
                    res.removeHeader("Content-Length");
                    res.statusCode = 502;
                    res.end("media proxy failed");
                }
            }
        } finally {
            clearTimeout(timeout);
            res.off("close", onClose);
        }
    };
    return {
        name: "local-media-proxy",
        configureServer(server) {
            server.middlewares.use(MEDIA_PROXY_PATH, middleware);
        },
        configurePreviewServer(server) {
            server.middlewares.use(MEDIA_PROXY_PATH, middleware);
        },
    };
}

function serverHealth(): Plugin {
    const middleware = (_req: IncomingMessage, res: ServerResponse) => {
        res.statusCode = 200;
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
        res.end(JSON.stringify({ ok: true }));
    };
    return {
        name: "local-server-health",
        configureServer(server) {
            server.middlewares.use(SERVER_HEALTH_PATH, middleware);
        },
        configurePreviewServer(server) {
            server.middlewares.use(SERVER_HEALTH_PATH, middleware);
        },
    };
}

// Expose /plugins/index.json with local plugin files from public/plugins.
// The frontend can discover and list them when enabled; development reads the directory live, while builds emit a static registry.
function localPluginsManifest(): Plugin {
    const pluginsDir = resolve(webDir, "public/plugins");
    const listLocalPlugins = () => {
        try {
            return readdirSync(pluginsDir)
                .filter((file) => file.endsWith(".js"))
                .sort()
                .map((file) => `/plugins/${file}`);
        } catch {
            return [];
        }
    };
    return {
        name: "local-plugins-manifest",
        configureServer(server) {
            server.middlewares.use("/plugins/index.json", (_req, res) => {
                res.setHeader("Content-Type", "application/json");
                res.end(JSON.stringify(listLocalPlugins()));
            });
        },
        generateBundle() {
            this.emitFile({ type: "asset", fileName: "plugins/index.json", source: JSON.stringify(listLocalPlugins()) });
        },
    };
}

export default defineConfig({
    base: process.env.VITE_BASE || "/",
    plugins: [react(), localPluginsManifest(), mediaProxy(), serverHealth(), fmgoPricingPlugin(), runningHubWorkflowProxy(), canvasBackupService({ testRoot: resolve(webDir, ".backup-test-data") }), jianyingDraft()],
    // This dependency lives in a lazy worker; discovering it on the first trim can otherwise reload the canvas.
    optimizeDeps: {
        include: ["mediabunny"],
    },
    server: {
        watch: { ignored: ["**/.backup-test-data/**", "**/.cache/**"] },
        host: "localhost",
        port: 3000,
        // IndexedDB / localStorage 按 origin（含端口）隔离；禁止自动换端口以免存档“消失”
        strictPort: true,
    },
    preview: {
        host: "localhost",
        port: 3000,
        strictPort: true,
    },
    resolve: {
        alias: {
            "@": resolve(webDir, "src"),
        },
    },
    define: {
        __APP_VERSION__: JSON.stringify(localVersion),
        __APP_RELEASES__: JSON.stringify(parseChangelog(localChangelog)),
    },
});

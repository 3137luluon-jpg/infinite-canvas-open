import type { IncomingMessage, ServerResponse } from "node:http";
import type { Plugin } from "vite";

/** Public FMGO pricing only: no configurable targets, credentials, or generation calls. */
export function fmgoPricingPlugin(): Plugin {
    const middleware = async (req: IncomingMessage, res: ServerResponse) => {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader("Cache-Control", "no-store");
        if (req.method !== "GET" || (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")) {
            res.statusCode = 403;
            res.end(JSON.stringify({ error: "不允许此价格请求" }));
            return;
        }
        try {
            const responses = await Promise.all(["pricing", "status"].map(path => fetch(`https://www.fmgo.top/api/${path}`, { signal: AbortSignal.timeout(15_000), redirect: "error" })));
            if (responses.some(response => !response.ok)) throw new Error("FMGO 价格接口暂不可用");
            const [pricing, status] = await Promise.all(responses.map(response => response.json()));
            if (pricing.success !== true || !Array.isArray(pricing.data) || status.success !== true) throw new Error("FMGO 返回了无法识别的价格数据");
            const info = status.data || {};
            res.end(JSON.stringify({
                models: pricing.data,
                groupRatios: pricing.group_ratio,
                groups: pricing.usable_group,
                currency: { type: info.quota_display_type, symbol: info.custom_currency_symbol, customRate: info.custom_currency_exchange_rate, usdRate: info.usd_exchange_rate },
                fetchedAt: Date.now(),
            }));
        } catch (error) {
            res.statusCode = 502;
            res.end(JSON.stringify({ error: error instanceof Error ? error.message : "刷新 FMGO 价格失败" }));
        }
    };
    return {
        name: "fmgo-public-pricing",
        configureServer(server) { server.middlewares.use("/__fmgo-pricing", middleware); },
        configurePreviewServer(server) { server.middlewares.use("/__fmgo-pricing", middleware); },
    };
}

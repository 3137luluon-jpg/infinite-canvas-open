import { Router } from "express";
import { compileWithCursor, CURSOR_H3_FAST_MODEL, CURSOR_H3_MODEL } from "../agent/cursor.js";

/** Mount behind the main server's existing token middleware. */
export function cursorRoutes(compile = compileWithCursor) {
    const router = Router();
    router.get("/agent/cursor/config", (_req, res) => res.json({ models: [CURSOR_H3_MODEL, CURSOR_H3_FAST_MODEL] }));
    let busy = false;
    router.post("/agent/cursor/compile", async (req, res, next) => {
        if (busy) return void res.status(409).json({ ok: false, error: "Cursor 正在编译，请等待当前任务完成或停止" });
        busy = true;
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 15 * 60 * 1000);
        const disconnect = () => { if (!res.writableEnded) controller.abort(); };
        res.on("close", disconnect);
        try {
            const text = await compile(req.body, controller.signal);
            if (!controller.signal.aborted) res.json({ ok: true, text });
            else if (!res.destroyed) res.status(408).json({ ok: false, error: "Cursor 编译已停止或超时" });
        } catch (error) {
            if (!res.destroyed) next(error);
        } finally {
            clearTimeout(timeout);
            res.off("close", disconnect);
            busy = false;
        }
    });
    return router;
}

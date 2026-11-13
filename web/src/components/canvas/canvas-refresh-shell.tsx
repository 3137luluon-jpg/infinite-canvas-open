import { CanvasGrid } from "./infinite-canvas";
import { canvasThemes, type CanvasBackgroundMode } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";
import type { ViewportTransform } from "@/types/canvas";

export function CanvasRefreshShell({ backgroundMode = "lines", viewport = { x: 0, y: 0, k: 1 } }: { backgroundMode?: CanvasBackgroundMode; viewport?: ViewportTransform }) {
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    return (
        <main data-canvas-state="loading" aria-busy="true" className="relative h-full min-h-0 overflow-hidden" style={{ background: theme.canvas.background, color: theme.node.text }}>
            <CanvasGrid viewport={viewport} mode={backgroundMode} />
            <p role="status" className="absolute left-5 top-5 text-xs opacity-60">正在打开画布…</p>
        </main>
    );
}

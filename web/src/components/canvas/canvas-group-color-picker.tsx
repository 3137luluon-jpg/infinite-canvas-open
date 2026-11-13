import { type ReactNode, useState } from "react";
import { Popover } from "antd";
import { Check } from "lucide-react";
import { CANVAS_GROUP_COLORS, canvasGroupColorAppearance } from "@/lib/canvas/canvas-group-colors";
import { canvasThemes } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

export function CanvasGroupColorPicker({ value, onChange, children, disabled = false }: { value?: string; onChange: (color: string | undefined) => void; children?: ReactNode; disabled?: boolean }) {
    const [open, setOpen] = useState(false);
    const theme = canvasThemes[useThemeStore(state => state.theme)];
    const current = canvasGroupColorAppearance(value);
    const choose = (color?: string) => { onChange(color); setOpen(false); };
    if (disabled) return <>{children}</>;
    return <span onContextMenu={children ? event => event.stopPropagation() : undefined} data-canvas-no-zoom className="inline-flex shrink-0" onMouseDown={children ? undefined : event => event.stopPropagation()} onPointerDown={children ? undefined : event => event.stopPropagation()} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
        <Popover trigger={children ? "contextMenu" : "click"} placement="topLeft" open={open} onOpenChange={setOpen} content={
            <div data-canvas-no-zoom onPointerDown={event => event.stopPropagation()} onMouseDown={event => event.stopPropagation()} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
                <div className="grid grid-cols-5 gap-3" role="group" aria-label="分组颜色">
                    {CANVAS_GROUP_COLORS.map(entry => <button key={entry.color} type="button" aria-label={entry.label} title={entry.label} aria-pressed={current?.color === entry.color} className="grid size-8 place-items-center rounded-full transition-transform hover:scale-110 focus-visible:outline-2 focus-visible:outline-offset-2" style={{ background: entry.color, outline: current?.color === entry.color ? `2px solid ${entry.color}` : undefined, outlineOffset: 3 }} onClick={() => choose(current?.color === entry.color ? undefined : entry.color)}>
                        {current?.color === entry.color ? <Check className="size-4" style={{ color: entry.color === "#E6E6E6" || entry.color === "#F4B740" ? "#171717" : "#FFFFFF" }} /> : null}
                    </button>)}
                </div>
                <button type="button" className="mt-3 w-full rounded-md py-1 text-xs hover:underline" onClick={() => choose()}>恢复默认底色</button>
            </div>
        }>
            {children || <button type="button" className="grid size-8 place-items-center rounded-lg" style={{ background: theme.toolbar.activeBg }} aria-label={`分组颜色：${current?.label || "默认"}`} title="设置分组颜色" aria-expanded={open}>
                <span className="size-5 rounded-full" style={{ background: current?.color || "#B8B8B8" }} />
            </button>}
        </Popover>
    </span>;
}

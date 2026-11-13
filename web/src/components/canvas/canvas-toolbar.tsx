import type { MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { memo, useState } from "react";
import { Button } from "antd";
import { AlignStartVertical, AlignCenterVertical, AlignEndVertical, AlignStartHorizontal, AlignCenterHorizontal, AlignEndHorizontal, Grid2X2, Redo2, Undo2, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";

import { canvasThemes, type CanvasTheme } from "@/lib/canvas-theme";
import { useThemeStore } from "@/stores/use-theme-store";

import type { CanvasAlignment } from "@/lib/canvas/canvas-alignment";

const alignmentActions = [
    { id: "grid", label: "宫格排列", icon: Grid2X2 },
    { id: "left", label: "左对齐", icon: AlignStartVertical },
    { id: "center-x", label: "左右居中（排成一列）", icon: AlignCenterVertical },
    { id: "right", label: "右对齐", icon: AlignEndVertical },
    { id: "top", label: "顶对齐", icon: AlignStartHorizontal },
    { id: "center-y", label: "上下居中（排成一行）", icon: AlignCenterHorizontal },
    { id: "bottom", label: "底对齐", icon: AlignEndHorizontal },
] as const;

export const CanvasToolbar = memo(function CanvasToolbar({
    canUndo,
    canRedo,
    onUndo,
    onRedo,
    onUpload,
    alignmentCount = 0,
    alignmentInGroup = false,
    onAlign,
}: {
    canUndo: boolean;
    canRedo: boolean;
    onUndo: () => void;
    onRedo: () => void;
    onUpload: () => void;
    alignmentCount?: number;
    alignmentInGroup?: boolean;
    onAlign?: (alignment: CanvasAlignment) => void;
}) {
    const { t } = useTranslation();
    const colorTheme = useThemeStore((state) => state.theme);
    const theme = canvasThemes[colorTheme];
    const [hovered, setHovered] = useState<string | null>(null);
    const dockStyle = {
        background: theme.toolbar.panel,
        borderColor: theme.toolbar.border,
        color: theme.toolbar.item,
        boxShadow: colorTheme === "dark" ? "0 18px 45px rgba(0,0,0,.32)" : "0 16px 40px rgba(28,25,23,.12)",
    };
    const hoverStyle = { background: theme.toolbar.itemHover, color: theme.toolbar.activeText };

    return (
        <div className="pointer-events-none absolute bottom-5 z-50 flex justify-center" style={{ left: 300, right: 16 }}>
            <div data-canvas-no-zoom onPointerDown={(event) => event.stopPropagation()} className="pointer-events-auto flex h-14 items-center gap-1 rounded-xl border px-2 shadow-lg backdrop-blur" style={dockStyle}>
                <ToolbarButton id="tool-undo" label={t("canvas.undo")} disabled={!canUndo} hovered={hovered} hoverStyle={hoverStyle} theme={theme} onHover={setHovered} onClick={onUndo}>
                    <Undo2 className="size-4.5" />
                </ToolbarButton>
                <ToolbarButton id="tool-redo" label={t("canvas.redo")} disabled={!canRedo} hovered={hovered} hoverStyle={hoverStyle} theme={theme} onHover={setHovered} onClick={onRedo}>
                    <Redo2 className="size-4.5" />
                </ToolbarButton>
                <Divider theme={theme} />
                {alignmentCount >= 2 && onAlign ? (
                    <>
                        <span className="px-1 text-xs whitespace-nowrap opacity-60">{alignmentInGroup ? "组内对齐" : "对齐"}</span>
                        {alignmentActions.map(({ id, label, icon: Icon }) => (
                            <ToolbarButton key={id} id={`align-${id}`} label={label} hovered={hovered} hoverStyle={hoverStyle} theme={theme} onHover={setHovered} onClick={() => onAlign(id)}>
                                <Icon className="size-4.5" />
                            </ToolbarButton>
                        ))}
                        <Divider theme={theme} />
                    </>
                ) : null}
                <ToolbarButton id="tool-upload" label={t("canvas.toolbar.upload")} hovered={hovered} hoverStyle={hoverStyle} theme={theme} onHover={setHovered} onClick={onUpload}>
                    <Upload className="size-4.5" />
                </ToolbarButton>
            </div>
        </div>
    );
});

function ToolbarButton({
    id,
    label,
    active,
    hovered,
    activeStyle,
    hoverStyle,
    theme,
    onHover,
    onClick,
    disabled,
    danger,
    children,
}: {
    id: string;
    label: string;
    active?: boolean;
    hovered: string | null;
    activeStyle?: { background: string; color: string };
    hoverStyle: { background: string; color: string };
    theme: CanvasTheme;
    onHover: (id: string | null) => void;
    onClick?: (event: ReactMouseEvent<HTMLElement>) => void;
    disabled?: boolean;
    danger?: boolean;
    children: ReactNode;
}) {
    const showTip = hovered === id && !disabled;

    return (
        <span className="relative inline-flex">
            {showTip ? (
                <span className="pointer-events-none absolute bottom-[calc(100%+8px)] left-1/2 z-10 -translate-x-1/2 whitespace-nowrap rounded-md px-2 py-1 text-xs shadow-lg" style={{ background: theme.node.text, color: theme.node.panel }}>
                    {label}
                </span>
            ) : null}
            <Button
                type="text"
                aria-label={label}
                className="!h-8 !w-8 !min-w-8 !p-0"
                disabled={disabled}
                style={active ? activeStyle : showTip ? hoverStyle : { color: danger ? "#f87171" : theme.toolbar.item, opacity: disabled ? 0.35 : 1 }}
                icon={children}
                onMouseEnter={() => onHover(id)}
                onMouseLeave={() => onHover(null)}
                onClick={onClick}
            />
        </span>
    );
}

function Divider({ theme }: { theme: CanvasTheme }) {
    return <div className="mx-1 h-6 w-px" style={{ background: theme.toolbar.border }} />;
}

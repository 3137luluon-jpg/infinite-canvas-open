// LibTV's public canvas palette: 13hvqvsf-cww5.js (2026-10-15).
// The swatch, translucent frame, and dark title chip use separate treatments.
export const CANVAS_GROUP_COLORS = [
    { color: "#7A7A7A", label: "灰色" },
    { color: "#E74C3C", label: "红色" },
    { color: "#F28A2E", label: "橙色" },
    { color: "#F4B740", label: "黄色" },
    { color: "#2ECC71", label: "绿色" },
    { color: "#08B6DD", label: "青色" },
    { color: "#3B82F6", label: "蓝色" },
    { color: "#8B5CF6", label: "紫色" },
    { color: "#F63B97", label: "粉色" },
    { color: "#E6E6E6", label: "白色" },
] as const;

export function canvasGroupColorAppearance(value?: string) {
    const color = typeof value === "string" ? value.toUpperCase() : "";
    const entry = CANVAS_GROUP_COLORS.find(entry => entry.color === color);
    if (!entry) return undefined;
    return {
        ...entry,
        background: `${entry.color}1A`,
        border: `${entry.color}33`,
        titleBackground: `color-mix(in srgb, ${entry.color} 30%, #000)`,
        titleText: "#FFFFFF",
    };
}

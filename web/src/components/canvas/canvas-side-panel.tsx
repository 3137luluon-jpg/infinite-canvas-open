import { memo, useEffect, useMemo, useState, type PointerEvent as ReactPointerEvent } from "react";
import { Empty, Input, Select } from "antd";
import { ChevronRight, Mountain, Music2, Package, Plus, Search, Shapes, Square, UserRound } from "lucide-react";
import { motion } from "motion/react";
import { useTranslation } from "react-i18next";

import { AssetDetailModal } from "@/components/assets/asset-detail-modal";
import { canvasThemes, type CanvasTheme } from "@/lib/canvas-theme";
import { cn } from "@/lib/utils";
import { useAssetStore, type Asset, type AssetKind, type AssetType } from "@/stores/use-asset-store";
import { CANVAS_SIDE_PANEL_MAX_WIDTH, CANVAS_SIDE_PANEL_MIN_WIDTH, CANVAS_SIDE_PANEL_MOTION_MS, useCanvasSidePanelStore } from "@/stores/use-canvas-side-panel-store";
import { useThemeStore } from "@/stores/use-theme-store";

import type { InsertAssetPayload } from "./asset-picker-modal";

const PANEL_MOTION_SECONDS = CANVAS_SIDE_PANEL_MOTION_MS / 1000;
const PANEL_EASE = [0.22, 1, 0.36, 1] as const;
const NO_PROJECT_FILTER = "__no_asset_project__";
const ASSET_GROUPS: { type: AssetType; icon: typeof Square }[] = [
    { type: "character", icon: UserRound },
    { type: "scene", icon: Mountain },
    { type: "prop", icon: Package },
    { type: "other", icon: Shapes },
];

type Props = {
    onInsertAsset: (payload: InsertAssetPayload) => void;
};

export function CanvasSidePanel({ onInsertAsset }: Props) {
    const { t } = useTranslation();
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const width = useCanvasSidePanelStore((state) => state.width);
    const panelOpen = useCanvasSidePanelStore((state) => state.panelOpen);
    const panelMounted = useCanvasSidePanelStore((state) => state.panelMounted);
    const panelClosing = useCanvasSidePanelStore((state) => state.panelClosing);
    const setWidth = useCanvasSidePanelStore((state) => state.setWidth);
    const [resizing, setResizing] = useState(false);

    const startResize = (event: ReactPointerEvent<HTMLButtonElement>) => {
        event.preventDefault();
        const startX = event.clientX;
        const startWidth = width;
        let nextWidth = startWidth;
        const onMove = (moveEvent: PointerEvent) => {
            nextWidth = Math.min(CANVAS_SIDE_PANEL_MAX_WIDTH, Math.max(CANVAS_SIDE_PANEL_MIN_WIDTH, startWidth + moveEvent.clientX - startX));
            setWidth(nextWidth);
        };
        const onUp = () => {
            localStorage.setItem("canvas-side-panel-width", String(nextWidth));
            window.removeEventListener("pointermove", onMove);
            window.removeEventListener("pointerup", onUp);
            setResizing(false);
        };
        setResizing(true);
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp);
    };

    if (!panelMounted) return null;

    return (
        <motion.div
            className="relative z-[60] flex h-full shrink-0"
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: panelOpen ? width + 1 : 0, opacity: panelOpen ? 1 : 0 }}
            transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: PANEL_EASE }}
            style={{ overflow: "clip", pointerEvents: panelClosing ? "none" : undefined }}
        >
            <motion.aside
                className="relative flex h-full shrink-0 flex-col overflow-hidden border-r"
                initial={{ x: -48 }}
                animate={{ x: panelClosing ? -28 : 0 }}
                transition={{ duration: resizing ? 0 : PANEL_MOTION_SECONDS, ease: PANEL_EASE }}
                style={{ width, background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
                data-canvas-no-zoom
            >
                <div className="px-4 pt-3.5">
                    <span className="inline-block border-b-2 pb-1.5 text-sm font-semibold" style={{ borderColor: theme.toolbar.activeText }}>{t("canvas.sidePanel.assets")}</span>
                </div>
                <div className="mt-2 min-h-0 flex-1 overflow-hidden">
                    <CanvasAssetsTab onInsert={onInsertAsset} theme={theme} />
                </div>
                <button type="button" className="absolute inset-y-0 right-0 z-40 w-4 translate-x-1/2 cursor-col-resize" onPointerDown={startResize} aria-label={t("canvas.sidePanel.resize")} />
            </motion.aside>
        </motion.div>
    );
}

function buildInsertPayload(asset: Asset): InsertAssetPayload {
    if (asset.kind === "text") return { kind: "text", content: asset.data.content, title: asset.title };
    if (asset.kind === "image") return { kind: "image", dataUrl: asset.data.dataUrl || asset.coverUrl, storageKey: asset.data.storageKey, title: asset.title };
    if (asset.kind === "video") return { kind: "video", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, width: asset.data.width, height: asset.data.height };
    return { kind: "audio", url: asset.data.url, storageKey: asset.data.storageKey, title: asset.title, durationMs: asset.data.durationMs };
}

const CanvasAssetsTab = memo(function CanvasAssetsTab({ onInsert, theme }: { onInsert: (payload: InsertAssetPayload) => void; theme: CanvasTheme }) {
    const { t } = useTranslation();
    const assets = useAssetStore((state) => state.assets);
    const projects = useAssetStore((state) => state.projects);
    const setLastProjectId = useAssetStore((state) => state.setLastProjectId);
    const [keyword, setKeyword] = useState("");
    const [typeFilter, setTypeFilter] = useState<AssetType | "all">("all");
    const [kindFilter, setKindFilter] = useState<AssetKind | "all">("all");
    const [projectFilter, setProjectFilter] = useState("all");
    const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
    const [detailAssetId, setDetailAssetId] = useState<string | null>(null);

    const filtered = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return assets
            .filter((asset) => kindFilter === "all" || asset.kind === kindFilter)
            .filter((asset) => typeFilter === "all" || (asset.assetType || "other") === typeFilter)
            .filter((asset) => projectFilter === "all" || (projectFilter === NO_PROJECT_FILTER ? !asset.projectId : asset.projectId === projectFilter))
            .filter((asset) => !query || [asset.title, asset.projectId || ""].join(" ").toLowerCase().includes(query));
    }, [assets, keyword, kindFilter, projectFilter, typeFilter]);
    const groups = useMemo(() => ASSET_GROUPS.map((group) => ({ ...group, items: filtered.filter((asset) => (asset.assetType || "other") === group.type) })).filter((group) => group.items.length > 0), [filtered]);
    const insert = (asset: Asset) => onInsert(buildInsertPayload(asset));

    useEffect(() => {
        if (projectFilter !== "all" && projectFilter !== NO_PROJECT_FILTER && !projects.includes(projectFilter)) setProjectFilter("all");
    }, [projectFilter, projects]);

    return (
        <div className="flex h-full flex-col">
            <div className="space-y-2 px-3 pb-3 pt-1">
                <Input size="small" allowClear prefix={<Search className="size-3.5 text-stone-400" />} placeholder={t("canvas.sidePanel.searchAssets")} value={keyword} onChange={(event) => setKeyword(event.target.value)} />
                <label className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2 text-xs">
                    <span className="opacity-55">媒体</span>
                    <Select size="small" value={kindFilter} onChange={setKindFilter} options={[{ value: "all", label: "全部" }, { value: "image", label: "图片" }, { value: "audio", label: "音频" }, { value: "video", label: "视频" }, { value: "text", label: "其他" }]} />
                </label>
                <label className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2 text-xs">
                    <span className="opacity-55">{t("assets.type")}</span>
                    <Select
                        size="small"
                        value={typeFilter}
                        onChange={setTypeFilter}
                        options={[{ value: "all", label: t("common.all") }, ...ASSET_GROUPS.map((group) => ({ value: group.type, label: t(`assets.assetTypes.${group.type}`) }))]}
                    />
                </label>
                <label className="grid grid-cols-[64px_minmax(0,1fr)] items-center gap-2 text-xs">
                    <span className="opacity-55">{t("assets.projectFilter")}</span>
                    <Select
                        size="small"
                        value={projectFilter}
                        onChange={(value) => { setProjectFilter(value); if (value !== "all" && value !== NO_PROJECT_FILTER) setLastProjectId(value); }}
                        options={[{ value: "all", label: t("common.all") }, { value: NO_PROJECT_FILTER, label: t("assets.noProject") }, ...projects.map((value) => ({ value, label: value }))]}
                    />
                </label>
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
                {groups.length ? (
                    <div className="space-y-1">
                        {groups.map((group) => {
                            const isCollapsed = collapsed[group.type];
                            return (
                                <div key={group.type}>
                                    <button type="button" onClick={() => setCollapsed((current) => ({ ...current, [group.type]: !current[group.type] }))} className="flex w-full items-center gap-1.5 rounded-md px-1.5 py-1.5 text-left text-xs font-semibold opacity-75 transition hover:opacity-100">
                                        <ChevronRight className={cn("size-3.5 transition-transform", !isCollapsed && "rotate-90")} />
                                        <group.icon className="size-3.5" />
                                        <span>{t(`assets.assetTypes.${group.type}`)}</span>
                                        <span className="opacity-50">{group.items.length}</span>
                                    </button>
                                    {isCollapsed ? null : (
                                        <div className="grid grid-cols-2 gap-2 px-1 pb-2 pt-1">
                                            {group.items.map((asset) => <AssetCard key={asset.id} asset={asset} theme={theme} onOpen={() => setDetailAssetId(asset.id)} onInsert={() => insert(asset)} />)}
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                    </div>
                ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("canvas.sidePanel.noAssets")} className="pt-16" />}
            </div>
            <AssetDetailModal open={Boolean(detailAssetId)} assetId={detailAssetId} onClose={() => setDetailAssetId(null)} onInsert={(asset) => { insert(asset); setDetailAssetId(null); }} />
        </div>
    );
});

function AssetCard({ asset, theme, onOpen, onInsert }: { asset: Asset; theme: CanvasTheme; onOpen: () => void; onInsert: () => void }) {
    const { t } = useTranslation();
    return (
        <div className="group relative aspect-square overflow-hidden rounded-xl border transition duration-200 hover:-translate-y-0.5 hover:shadow-lg" style={{ borderColor: theme.node.stroke, background: theme.node.panel }}>
            <button type="button" className="absolute inset-0 z-10" onClick={onOpen} aria-label={t("assets.details")} />
            {asset.kind === "image" ? <img src={asset.data.dataUrl || asset.coverUrl} alt={asset.title} className="size-full object-cover transition duration-300 group-hover:scale-[1.04]" /> : asset.kind === "video" ? <video src={asset.data.url} muted className="size-full object-cover" /> : <div className="grid size-full place-items-center">{asset.kind === "audio" ? <Music2 className="size-8 opacity-55" /> : <Shapes className="size-8 opacity-55" />}</div>}
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-black/0 opacity-0 transition duration-200 group-hover:bg-black/20 group-hover:opacity-100">
                <button type="button" onClick={(event) => { event.stopPropagation(); onInsert(); }} className="pointer-events-auto grid size-8 place-items-center rounded-full bg-white/90 text-stone-700 shadow-sm backdrop-blur transition hover:bg-white hover:text-stone-900 dark:bg-black/60 dark:text-stone-100 dark:hover:bg-black/80" aria-label={t("canvas.sidePanel.inserted")}>
                    <Plus className="size-4" />
                </button>
            </div>
            <div className="pointer-events-none absolute inset-x-0 bottom-0 z-20 truncate bg-gradient-to-t from-black/70 to-transparent px-2 pb-2 pt-7 text-[11px] font-medium text-white">{asset.title}</div>
        </div>
    );
}

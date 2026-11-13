import { useEffect, useMemo, useRef, useState } from "react";
import { App, Button, Empty, Input, Pagination, Tag } from "antd";
import { Download, Music2, Search, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";

import { AssetDetailModal } from "@/components/assets/asset-detail-modal";
import { downloadFile } from "@/lib/download-file";
import { cn } from "@/lib/utils";
import { useAssetStore, type Asset, type AssetKind, type AssetType } from "@/stores/use-asset-store";
import { exportAssets, readAssetPackage } from "./asset-transfer";

const assetTypeOptions = ["all", "character", "scene", "prop", "other"] as const;
const mediaKindOptions: Array<{ value: AssetKind | "all"; label: string }> = [{ value: "all", label: "全部" }, { value: "image", label: "图片" }, { value: "audio", label: "音频" }, { value: "video", label: "视频" }, { value: "text", label: "其他" }];
const NO_PROJECT_FILTER = "__no_asset_project__";

export default function AssetsPage() {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    const assetInputRef = useRef<HTMLInputElement>(null);
    const assets = useAssetStore((state) => state.assets);
    const projects = useAssetStore((state) => state.projects);
    const addAsset = useAssetStore((state) => state.addAsset);
    const addProject = useAssetStore((state) => state.addProject);
    const setLastProjectId = useAssetStore((state) => state.setLastProjectId);
    const removeAsset = useAssetStore((state) => state.removeAsset);
    const [keyword, setKeyword] = useState("");
    const [kindFilter, setKindFilter] = useState<AssetKind | "all">("all");
    const [typeFilter, setTypeFilter] = useState<AssetType | "all">("all");
    const [projectFilter, setProjectFilter] = useState("all");
    const [page, setPage] = useState(1);
    const [pageSize, setPageSize] = useState(12);
    const [detailAssetId, setDetailAssetId] = useState<string | null>(null);

    const filteredAssets = useMemo(() => {
        const query = keyword.trim().toLowerCase();
        return assets.filter((asset) => {
            if (kindFilter !== "all" && asset.kind !== kindFilter) return false;
            if (typeFilter !== "all" && (asset.assetType || "other") !== typeFilter) return false;
            if (projectFilter === NO_PROJECT_FILTER && asset.projectId) return false;
            if (projectFilter !== "all" && projectFilter !== NO_PROJECT_FILTER && asset.projectId !== projectFilter) return false;
            return !query || [asset.title, asset.projectId || "", t(`assets.assetTypes.${asset.assetType || "other"}`)].join(" ").toLowerCase().includes(query);
        });
    }, [assets, keyword, kindFilter, projectFilter, t, typeFilter]);
    const visibleAssets = useMemo(() => filteredAssets.slice((page - 1) * pageSize, page * pageSize), [filteredAssets, page, pageSize]);

    useEffect(() => {
        setPage((value) => Math.min(value, Math.max(1, Math.ceil(filteredAssets.length / pageSize))));
    }, [filteredAssets.length, pageSize]);

    useEffect(() => {
        if (projectFilter !== "all" && projectFilter !== NO_PROJECT_FILTER && !projects.includes(projectFilter)) setProjectFilter("all");
    }, [projectFilter, projects]);

    const download = async (asset: Asset) => {
        if (asset.kind === "text") return;
        const source = asset.kind === "image" ? asset.data.dataUrl || asset.coverUrl : asset.data.url;
        if (!source) return;
        const extension = asset.data.mimeType.split("/")[1]?.replace("jpeg", "jpg").replace("mpeg", "mp3") || "bin";
        try {
            await downloadFile({ source, storageKey: asset.data.storageKey, filename: `${asset.title || "asset"}.${extension}` });
        } catch {
            message.error(t("common.downloadFailed"));
        }
    };

    const remove = (asset: Asset) => {
        modal.confirm({
            title: t("assets.deleteTitle"),
            content: t("assets.deleteConfirm", { name: asset.title }),
            okText: t("common.delete"),
            cancelText: t("common.cancel"),
            okButtonProps: { danger: true },
            onOk: () => {
                removeAsset(asset.id);
                message.success(t("assets.deleted"));
            },
        });
    };

    const exportAll = async () => {
        if (!assets.length) return message.warning(t("assets.noneToExport"));
        await exportAssets(assets, projects, t("assets.packageName"));
    };

    const importAssets = async (file?: File) => {
        if (!file) return;
        try {
            const imported = await readAssetPackage(file);
            imported.projects.forEach(addProject);
            imported.assets.forEach((asset) => {
                const payload = { ...asset } as Record<string, unknown>;
                delete payload.id;
                delete payload.createdAt;
                delete payload.updatedAt;
                addAsset(payload as Parameters<typeof addAsset>[0]);
            });
            message.success(t("assets.imported", { count: imported.assets.length }));
        } catch {
            message.error(t("assets.importFailed"));
        } finally {
            if (assetInputRef.current) assetInputRef.current.value = "";
        }
    };

    return (
        <main className="h-full overflow-y-auto bg-background bg-[radial-gradient(#e5e7eb_1px,transparent_1px)] px-6 py-8 text-stone-900 [background-size:16px_16px] dark:bg-[radial-gradient(rgba(245,245,244,.14)_1px,transparent_1px)] dark:text-stone-100">
            <div className="mx-auto max-w-7xl">
                <header className="text-center">
                    <h1 className="text-4xl font-semibold tracking-tight">{t("assets.title")}</h1>
                    <p className="mt-3 text-sm text-stone-500 dark:text-stone-400">{t("assets.description")}</p>
                </header>

                <div className="mx-auto mt-8 max-w-2xl">
                    <Input.Search size="large" allowClear prefix={<Search className="size-4 text-stone-400" />} value={keyword} placeholder={t("assets.search")} onChange={(event) => { setPage(1); setKeyword(event.target.value); }} />
                </div>

                <div className="mt-6 flex items-start justify-between gap-6 border-b border-stone-200 pb-4 dark:border-stone-800">
                    <div className="min-w-0 space-y-3">
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="w-12 shrink-0 text-xs font-medium text-stone-500">媒体</span>
                            {mediaKindOptions.map((option) => <Tag.CheckableTag key={option.value} checked={kindFilter === option.value} className={cn("prompt-filter-tag", kindFilter === option.value && "is-active")} onChange={() => { setPage(1); setKindFilter(option.value); }}>{option.label}</Tag.CheckableTag>)}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="w-12 shrink-0 text-xs font-medium text-stone-500">{t("assets.type")}</span>
                            {assetTypeOptions.map((option) => (
                                <Tag.CheckableTag key={option} checked={typeFilter === option} className={cn("prompt-filter-tag", typeFilter === option && "is-active")} onChange={() => { setPage(1); setTypeFilter(option); }}>
                                    {option === "all" ? t("common.all") : t(`assets.assetTypes.${option}`)}
                                </Tag.CheckableTag>
                            ))}
                        </div>
                        <div className="flex flex-wrap items-center gap-2">
                            <span className="w-12 shrink-0 text-xs font-medium text-stone-500">{t("assets.projectFilter")}</span>
                            {[{ value: "all", label: t("common.all") }, { value: NO_PROJECT_FILTER, label: t("assets.noProject") }, ...projects.map((value) => ({ value, label: value }))].map((option) => (
                                <Tag.CheckableTag key={option.value} checked={projectFilter === option.value} className={cn("prompt-filter-tag", projectFilter === option.value && "is-active")} onChange={() => { setPage(1); setProjectFilter(option.value); if (option.value !== "all" && option.value !== NO_PROJECT_FILTER) setLastProjectId(option.value); }}>
                                    {option.label}
                                </Tag.CheckableTag>
                            ))}
                        </div>
                    </div>
                    <div className="flex shrink-0 gap-4 pt-1 text-sm">
                        <button type="button" className="font-medium underline-offset-4 hover:underline" onClick={() => void exportAll()}>{t("assets.export")}</button>
                        <button type="button" className="font-medium underline-offset-4 hover:underline" onClick={() => assetInputRef.current?.click()}>{t("assets.import")}</button>
                    </div>
                </div>

                {visibleAssets.length ? (
                    <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                        {visibleAssets.map((asset) => (
                            <article key={asset.id} className="group overflow-hidden rounded-2xl border border-stone-200 bg-background transition hover:-translate-y-0.5 hover:shadow-lg dark:border-stone-800">
                                <button type="button" className="block w-full text-left" onClick={() => setDetailAssetId(asset.id)}>
                                    <AssetPreview asset={asset} />
                                    <div className="space-y-3 p-4">
                                        <h2 className="truncate text-base font-semibold">{asset.title}</h2>
                                        <div className="grid grid-cols-[64px_minmax(0,1fr)] gap-x-3 gap-y-2 text-xs">
                                            <span className="text-stone-500">{t("assets.type")}</span><span>{t(`assets.assetTypes.${asset.assetType || "other"}`)}</span>
                                            <span className="text-stone-500">{t("assets.project")}</span><span className="truncate">{asset.projectId || t("assets.noProject")}</span>
                                            <span className="text-stone-500">媒体</span><span>{mediaKindOptions.find((item) => item.value === asset.kind)?.label}</span>
                                            <span className="text-stone-500">{t("assets.resolution")}</span><span>{asset.kind === "image" || asset.kind === "video" ? `${asset.data.width} × ${asset.data.height}` : "—"}</span>
                                        </div>
                                    </div>
                                </button>
                                <div className="flex gap-2 px-4 pb-4">
                                    {asset.kind !== "text" ? <Button size="small" icon={<Download className="size-3.5" />} onClick={() => void download(asset)}>{t("common.download")}</Button> : null}
                                    <Button size="small" danger icon={<Trash2 className="size-3.5" />} onClick={() => remove(asset)}>{t("common.delete")}</Button>
                                </div>
                            </article>
                        ))}
                    </div>
                ) : <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={t("assets.empty")} className="py-24" />}

                <div className="mt-8 flex justify-center">
                    <Pagination current={page} pageSize={pageSize} total={filteredAssets.length} showSizeChanger pageSizeOptions={[12, 24, 48, 96]} onChange={(nextPage, nextPageSize) => { setPage(nextPage); setPageSize(nextPageSize); }} />
                </div>
            </div>

            <AssetDetailModal open={Boolean(detailAssetId)} assetId={detailAssetId} onClose={() => setDetailAssetId(null)} />
            <input ref={assetInputRef} type="file" accept="application/zip,.zip" className="hidden" onChange={(event) => void importAssets(event.target.files?.[0])} />
        </main>
    );
}

function AssetPreview({ asset }: { asset: Asset }) {
    if (asset.kind === "image") return <img src={asset.data.dataUrl || asset.coverUrl} alt={asset.title} className="aspect-[4/3] w-full bg-stone-100 object-cover dark:bg-stone-900" />;
    if (asset.kind === "video") return <video src={asset.data.url} muted preload="auto" playsInline className="aspect-[4/3] w-full bg-black object-cover" />;
    if (asset.kind === "audio") return <div className="flex aspect-[4/3] items-center justify-center bg-stone-100 text-stone-500 dark:bg-stone-900"><Music2 className="size-10 opacity-60" /></div>;
    return <div className="line-clamp-6 aspect-[4/3] overflow-hidden bg-stone-100 p-5 text-sm dark:bg-stone-900">{asset.data.content}</div>;
}

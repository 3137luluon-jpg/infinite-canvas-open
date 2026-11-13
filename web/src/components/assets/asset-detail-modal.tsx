import { useEffect, useState } from "react";
import { App, AutoComplete, Button, Image, Input, Modal, Select } from "antd";
import { Download, Plus, Save, Trash2, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { downloadFile } from "@/lib/download-file";
import { useAssetStore, type Asset, type AssetType, type AudioAsset, type ImageAsset, type VideoAsset } from "@/stores/use-asset-store";

type DraftBase<T extends Asset> = Omit<T, "id" | "createdAt" | "updatedAt" | "assetType" | "projectId"> & {
    assetType?: AssetType;
    projectId?: string;
};
export type NewAssetDraft = DraftBase<ImageAsset> | DraftBase<VideoAsset> | DraftBase<AudioAsset>;
export type NewImageAssetDraft = DraftBase<ImageAsset>;

type Props = {
    open: boolean;
    assetId?: string | null;
    draft?: NewAssetDraft | null;
    onClose: () => void;
    onInsert?: (asset: Asset) => void;
};

const NO_PROJECT_OPTION = "__no_asset_project__";
const ASSET_TYPES: AssetType[] = ["character", "scene", "prop", "other"];

export function AssetDetailModal({ open, assetId, draft, onClose, onInsert }: Props) {
    const { message, modal } = App.useApp();
    const { t } = useTranslation();
    const assets = useAssetStore((state) => state.assets);
    const projects = useAssetStore((state) => state.projects);
    const lastProjectId = useAssetStore((state) => state.lastProjectId);
    const addAsset = useAssetStore((state) => state.addAsset);
    const addProject = useAssetStore((state) => state.addProject);
    const setLastProjectId = useAssetStore((state) => state.setLastProjectId);
    const removeProject = useAssetStore((state) => state.removeProject);
    const updateAsset = useAssetStore((state) => state.updateAsset);
    const removeAsset = useAssetStore((state) => state.removeAsset);
    const asset = assets.find((item) => item.id === assetId);
    const source = asset || draft;
    const creating = Boolean(draft && !asset);
    const [title, setTitle] = useState("");
    const [assetType, setAssetType] = useState<AssetType>("character");
    const [projectId, setProjectId] = useState("");

    useEffect(() => {
        if (!open || !source) return;
        setTitle(source.title || "");
        setAssetType(source.assetType || (creating ? "character" : "other"));
        setProjectId(source.projectId?.trim() || (creating ? lastProjectId : ""));
    }, [creating, lastProjectId, open, source]);

    const deleteProject = (name: string) => {
        modal.confirm({
            title: t("assets.deleteProjectTitle"),
            content: t("assets.deleteProjectConfirm"),
            okText: t("common.delete"),
            cancelText: t("common.cancel"),
            okButtonProps: { danger: true },
            onOk: () => {
                removeProject(name);
                if (projectId === name) setProjectId("");
            },
        });
    };
    const projectOptions = [
        { value: NO_PROJECT_OPTION, search: t("assets.noProject"), label: <span>{t("assets.noProject")}</span> },
        ...projects.map((value) => ({
            value,
            search: value,
            label: (
                <span className="flex items-center justify-between gap-3">
                    <span className="min-w-0 flex-1 truncate">{value}</span>
                    <button
                        type="button"
                        className="grid size-6 shrink-0 place-items-center rounded-md text-stone-400 transition hover:bg-black/5 hover:text-red-500 dark:hover:bg-white/10"
                        aria-label={t("assets.deleteProjectTitle")}
                        onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
                        onClick={(event) => { event.preventDefault(); event.stopPropagation(); deleteProject(value); }}
                    >
                        <X className="size-3.5" />
                    </button>
                </span>
            ),
        })),
    ];
    const preview = source ? source.kind === "image" ? source.data.dataUrl || source.coverUrl : source.kind === "text" ? source.data.content : source.data.url : "";
    const resolution = source && (source.kind === "image" || source.kind === "video") ? `${source.data.width} × ${source.data.height}` : "—";
    const hasResolution = source?.kind === "image" || source?.kind === "video";
    const showAssetType = source?.kind !== "video" && source?.kind !== "audio";
    const previewAspect = source && (source.kind === "image" || source.kind === "video") && source.data.width && source.data.height ? source.data.width / source.data.height : 16 / 9;

    const validate = () => {
        if (!source?.data || !preview || !title.trim() || (showAssetType && !assetType) || ((source.kind === "image" || source.kind === "video") && (!source.data.width || !source.data.height))) {
            message.error(t("assets.requiredInfo"));
            return false;
        }
        return true;
    };

    const currentAsset = () => {
        if (!asset || !validate()) return null;
        const normalizedProject = projectId.trim() === t("assets.noProject") ? "" : projectId.trim();
        if (normalizedProject) addProject(normalizedProject);
        setLastProjectId(normalizedProject);
        const patch = { title: title.trim(), assetType, projectId: normalizedProject };
        updateAsset(asset.id, patch);
        return { ...asset, ...patch } as Asset;
    };

    const saveNew = () => {
        if (!draft || !validate()) return;
        const normalizedProject = projectId.trim() === t("assets.noProject") ? "" : projectId.trim();
        if (normalizedProject) addProject(normalizedProject);
        setLastProjectId(normalizedProject);
        const next = { ...draft, title: title.trim(), assetType, projectId: normalizedProject, coverUrl: preview };
        addAsset(next as Parameters<typeof addAsset>[0]);
        message.success(t("assets.saved"));
        onClose();
    };

    const commitTitle = () => {
        if (!asset || !title.trim()) return;
        updateAsset(asset.id, { title: title.trim() });
    };

    const commitProject = (value: string) => {
        const next = value === NO_PROJECT_OPTION || value.trim() === t("assets.noProject") ? "" : value.trim();
        if (next) addProject(next);
        setLastProjectId(next);
        setProjectId(next);
        if (asset) updateAsset(asset.id, { projectId: next });
    };

    const download = async () => {
        if (!source || !preview) return;
        if (source.kind === "text") return;
        const extension = source.data.mimeType.split("/")[1]?.replace("jpeg", "jpg").replace("mpeg", "mp3") || "bin";
        try {
            await downloadFile({ source: preview, storageKey: source.data.storageKey, filename: `${title.trim() || source.title || "asset"}.${extension}` });
        } catch {
            message.error(t("common.downloadFailed"));
        }
    };

    const remove = () => {
        if (!asset) return;
        modal.confirm({
            title: t("assets.deleteTitle"),
            content: t("assets.deleteConfirm", { name: asset.title }),
            okText: t("common.delete"),
            cancelText: t("common.cancel"),
            okButtonProps: { danger: true },
            onOk: () => {
                removeAsset(asset.id);
                message.success(t("assets.deleted"));
                onClose();
            },
        });
    };

    return (
        <Modal
            title={creating ? t("assets.add") : t("assets.details")}
            open={open && Boolean(source)}
            onCancel={onClose}
            width={760}
            destroyOnHidden
            footer={
                creating ? (
                    <Button type="primary" icon={<Save className="size-4" />} onClick={saveNew}>{t("common.save")}</Button>
                ) : (
                    <div className="flex w-full justify-end gap-2">
                        {onInsert ? <Button type="primary" icon={<Plus className="size-4" />} onClick={() => { const next = currentAsset(); if (next) onInsert(next); }}>{t("assets.addToCanvas")}</Button> : null}
                        <Button icon={<Download className="size-4" />} onClick={() => void download()}>{t("common.download")}</Button>
                        <Button danger icon={<Trash2 className="size-4" />} onClick={remove}>{t("common.delete")}</Button>
                    </div>
                )
            }
        >
            {source ? (
                <div className="space-y-5 pt-1">
                    <div className="flex justify-center">
                        <div
                            className="overflow-hidden rounded-2xl border border-stone-200 bg-stone-50 leading-none dark:border-stone-800 dark:bg-stone-950"
                            style={{ width: `min(100%, ${previewAspect * 50}vh)`, aspectRatio: previewAspect }}
                        >
                            {source.kind === "image" ? <Image src={preview} alt={title || source.title} width="100%" height="100%" rootClassName="!block !h-full !w-full" className="!block !h-full !w-full object-contain" preview={{ mask: t("common.view") }} /> : source.kind === "video" ? <video src={preview} controls className="size-full object-contain" /> : source.kind === "audio" ? <div className="grid size-full place-items-center p-8"><audio src={preview} controls className="w-full" /></div> : <pre className="size-full overflow-auto whitespace-pre-wrap p-5 text-sm leading-6">{preview}</pre>}
                        </div>
                    </div>
                    <div className="grid gap-4 sm:grid-cols-2">
                        <label className={`space-y-1.5 ${hasResolution ? "" : "sm:col-span-2"}`}>
                            <span className="text-xs text-stone-500">{t("assets.fields.title")}</span>
                            <Input value={title} onChange={(event) => setTitle(event.target.value)} onBlur={commitTitle} onPressEnter={commitTitle} />
                        </label>
                        {hasResolution ? <div className="space-y-1.5">
                            <span className="text-xs text-stone-500">{t("assets.resolution")}</span>
                            <div className="rounded-lg border border-stone-200 px-3 py-2 text-sm dark:border-stone-800">{resolution}</div>
                        </div> : null}
                        {showAssetType ? <label className="space-y-1.5">
                            <span className="text-xs text-stone-500">{t("assets.type")}</span>
                            <Select className="w-full" value={assetType} options={ASSET_TYPES.map((value) => ({ value, label: t(`assets.assetTypes.${value}`) }))} onChange={(value) => { setAssetType(value); if (asset) updateAsset(asset.id, { assetType: value }); }} />
                        </label> : null}
                        <label className={`space-y-1.5 ${showAssetType ? "" : "sm:col-span-2"}`}>
                            <span className="text-xs text-stone-500">{t("assets.project")}</span>
                            <AutoComplete className="w-full" value={projectId} options={projectOptions} filterOption={(input, option) => String(option?.search || "").toLowerCase().includes(input.toLowerCase())} onChange={setProjectId} onSelect={commitProject}>
                                <Input placeholder={t("assets.projectPlaceholder")} onPressEnter={() => commitProject(projectId)} />
                            </AutoComplete>
                        </label>
                    </div>
                </div>
            ) : null}
        </Modal>
    );
}

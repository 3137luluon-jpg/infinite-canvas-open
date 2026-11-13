import { App, Button, Modal } from "antd";
import { FolderOpen, Trash2 } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
    backupGeneratedCanvasMedia,
    clearCanvasRootFolder,
    loadCanvasFolderLabels,
    pickCanvasRootFolder,
    supportsDirectoryPicker,
    type CanvasFolderLabels,
} from "@/lib/canvas/canvas-local-folders";
import type { CanvasProject } from "@/stores/canvas/use-canvas-store";

type LocalFolderProject = Pick<CanvasProject, "id" | "localFolderLabels"> & { nodes?: CanvasProject["nodes"] };

export function CanvasLocalFoldersModal({
    open,
    project,
    storageProjectId,
    variant = "canvas",
    backupMedia,
    onClose,
    onLabelsChange,
}: {
    open: boolean;
    project: LocalFolderProject | null;
    storageProjectId?: string;
    variant?: "canvas" | "board";
    backupMedia?: () => Promise<number>;
    onClose: () => void;
    onLabelsChange: (labels: CanvasFolderLabels) => void;
}) {
    const { t } = useTranslation();
    const { message } = App.useApp();
    const [labels, setLabels] = useState<CanvasFolderLabels>({});
    const supported = supportsDirectoryPicker();
    const folderProjectId = storageProjectId || project?.id || "";

    useEffect(() => {
        if (!open || !project) return;
        void loadCanvasFolderLabels(folderProjectId).then((next) => {
            setLabels({ ...project.localFolderLabels, ...next });
        });
    }, [folderProjectId, open, project]);

    if (!project) return null;

    const pick = async () => {
        try {
            const label = await pickCanvasRootFolder(folderProjectId);
            if (backupMedia) await backupMedia();
            else await backupGeneratedCanvasMedia(folderProjectId, project.nodes || []);
            const next = { root: label };
            setLabels(next);
            onLabelsChange(next);
            message.success(t("canvas.localFolders.picked", { name: label }));
        } catch (error) {
            if (error instanceof DOMException && error.name === "AbortError") return;
            message.error(t("canvas.localFolders.pickFailed"));
        }
    };

    const clear = async () => {
        await clearCanvasRootFolder(folderProjectId);
        setLabels({});
        onLabelsChange({});
    };

    return (
        <Modal open={open} title={variant === "board" ? "看板本地目录" : t("canvas.localFolders.title")} onCancel={onClose} footer={null} destroyOnHidden width={520}>
            <p className="mb-4 text-sm text-stone-500 dark:text-stone-400">{variant === "board" ? "只选一个根目录。看板生成成功的故事板和视频分别写入固定子目录 pic、video（没有会自动创建）；媒体使用 UUID 文件名。重新选择目录时会补写当前看板尚未备份的结果。需 Chrome / Edge。" : t("canvas.localFolders.hint")}</p>
            {!supported ? <p className="mb-4 text-sm text-amber-600">{t("canvas.localFolders.unsupported")}</p> : null}
            <div className="flex items-center gap-2 rounded-lg border border-stone-200 px-3 py-2 dark:border-stone-700">
                <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium">{t("canvas.localFolders.root")}</div>
                    <div className="truncate text-xs text-stone-500">{labels.root || t("canvas.localFolders.unset")}</div>
                </div>
                <Button size="small" icon={<FolderOpen className="size-3.5" />} disabled={!supported} onClick={() => void pick()}>
                    {t("canvas.localFolders.choose")}
                </Button>
                {labels.root ? (
                    <Button size="small" type="text" danger icon={<Trash2 className="size-3.5" />} onClick={() => void clear()} />
                ) : null}
            </div>
            <div className="mt-3 rounded-lg border border-dashed border-stone-200 px-3 py-2 text-xs text-stone-500 dark:border-stone-700 dark:text-stone-400">
                <div>{t("canvas.localFolders.layout.pic")}</div>
                <div>{t("canvas.localFolders.layout.video")}</div>
                <div>{t("canvas.localFolders.layout.audio")}</div>
            </div>
            <div className="mt-5 flex justify-end gap-2">
                <Button onClick={onClose}>{t("common.cancel")}</Button>
            </div>
        </Modal>
    );
}

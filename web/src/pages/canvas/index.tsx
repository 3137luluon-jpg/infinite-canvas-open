import { useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { App, Button, Dropdown } from "antd";
import { FileUp, Plus } from "lucide-react";
import { useTranslation } from "react-i18next";

import { createZip, readZip } from "@/lib/zip";
import { saveAs } from "file-saver";
import { setMediaBlob } from "@/services/file-storage";
import { setImageBlob } from "@/services/image-storage";
import { CanvasDeleteProjectsDialog } from "@/components/canvas/canvas-delete-projects-dialog";
import { CanvasProjectCard } from "@/components/canvas/canvas-project-card";
import type { CanvasExportFile } from "@/types/canvas-export";
import { clearSafePersistRecovery, getSafePersistRecovery } from "@/lib/safe-json-persist";
import { CANVAS_STORE_KEY, useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { BoardProjectCard } from "@/components/board/board-project-card";
import { useBoardStore } from "@/stores/board/use-board-store";
import { importCinePackV1 } from "@/lib/canvas/cinepack-import";

export default function CanvasPage() {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const navigate = useNavigate();
    const [searchParams] = useSearchParams();
    const inputRef = useRef<HTMLInputElement>(null);
    const autoOpenRef = useRef(false);
    const recoveryNotifiedRef = useRef(false);
    const hydrated = useCanvasStore((state) => state.hydrated);
    const recoveredFromBackup = useCanvasStore((state) => state.recoveredFromBackup);
    const projects = useCanvasStore((state) => state.projects);
    const createProject = useCanvasStore((state) => state.createProject);
    const importProject = useCanvasStore((state) => state.importProject);
    const boardsHydrated = useBoardStore((state) => state.hydrated);
    const boards = useBoardStore((state) => state.boards);
    const createBoard = useBoardStore((state) => state.createBoard);

    // Emergency backup reads the live project state only: a missing or closed
    // media database must not prevent saving prompts, nodes and connections.
    const backupProjectStructures = async () => {
        const snapshot = useCanvasStore.getState().projects;
        if (!snapshot.length) return message.warning("当前页面没有可备份的画布");
        try {
            const exportedAt = new Date().toISOString();
            const manifest: CanvasExportFile = { app: "infinite-canvas", version: 3, exportedAt, projects: snapshot.map((project) => ({ project, files: [] })) };
            // Serialize before awaiting so later edits cannot change this backup.
            const data = JSON.stringify(manifest, null, 2);
            const zip = await createZip([
                { name: "projects.json", data },
                { name: "备份说明.txt", data: "此备份包含当前页面中的全部画布结构、提示词和连线，不包含图片、视频、音频文件。可通过首页“导入画布”恢复结构，媒体需从完整备份或本地目录补回。" },
            ]);
            saveAs(zip, `全部画布结构-${exportedAt.replace(/[:.]/g, "-")}.zip`);
            message.warning(`已发起 ${snapshot.length} 个画布的结构备份下载；不含媒体文件，请确认下载完成`, 8);
        } catch (error) {
            console.error("[canvas-structure-backup]", error);
            message.error("结构备份失败，请保留此页面，不要刷新或关闭", 10);
        }
    };

    const mode = searchParams.get("mode");
    const agentMode = mode === "new" || mode === "recent" || mode === "choose";
    const enterProject = (id: string) => {
        const params = new URLSearchParams(agentMode ? searchParams : undefined);
        const query = params.toString();
        navigate(`/canvas/${id}${query ? `?${query}` : ""}`);
    };
    const createAndEnter = () => {
        const id = createProject();
        enterProject(id);
    };
    const importCanvas = async (file?: File) => {
        if (!file) return;
        try {
            const zip = await readZip(file);
            const projectFile = zip.get("projects.json");
            // Historical packages are recovery inputs, not the live co-creation path.
            if (!projectFile && zip.has("cinepack.json")) {
                const result = await importCinePackV1(file);
                message.success(`已恢复历史资产包：${result.title}（${result.shots} 个镜头、${result.assets} 个资产）；未触发生成`);
                enterProject(result.projectId);
                return;
            }
            if (!projectFile) throw new Error("missing projects.json");
            const data = JSON.parse(await projectFile.text()) as CanvasExportFile;
            await Promise.all(
                data.projects.flatMap((project) =>
                    project.files.map(async (item) => {
                        const blob = zip.get(item.path);
                        if (!blob) return;
                        const typedBlob = blob.type ? blob : blob.slice(0, blob.size, item.mimeType);
                        await (item.storageKey.startsWith("image:") ? setImageBlob(item.storageKey, typedBlob) : setMediaBlob(item.storageKey, typedBlob));
                    }),
                ),
            );
            data.projects.forEach((item) => importProject(item.project));
            message.success(t("canvas.imported", { count: data.projects.length }));
        } catch {
            message.error(t("canvas.importFailed"));
        } finally {
            if (inputRef.current) inputRef.current.value = "";
        }
    };
    useEffect(() => {
        if (!hydrated || autoOpenRef.current || (mode !== "new" && mode !== "recent")) return;
        autoOpenRef.current = true;
        enterProject(mode === "new" ? createProject() : projects[0]?.id || createProject());
    }, [createProject, hydrated, mode, projects, t]);

    useEffect(() => {
        if (!hydrated || !recoveredFromBackup || recoveryNotifiedRef.current) return;
        recoveryNotifiedRef.current = true;
        const recovery = getSafePersistRecovery(CANVAS_STORE_KEY);
        message.warning(recovery?.message || "已从备份恢复画布存档，数据未丢失");
        clearSafePersistRecovery(CANVAS_STORE_KEY);
        useCanvasStore.setState({ recoveredFromBackup: false });
    }, [hydrated, message, recoveredFromBackup]);

    if (hydrated && (mode === "new" || mode === "recent")) return <main className="flex h-full items-center justify-center bg-background text-sm text-stone-500">{t("canvas.opening")}</main>;

    return (
        <main className="h-full overflow-auto bg-background text-stone-950 dark:text-stone-100">
            <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-10">
                <header className="flex flex-wrap items-end justify-between gap-4 border-b border-stone-200 pb-6 dark:border-stone-800">
                    <div>
                        <p className="text-xs text-stone-500">{t("canvas.library")}</p>
                        <h1 className="mt-3 text-3xl font-semibold">{t("canvas.title")}</h1>
                    </div>
                    <div className="flex items-center gap-2">
                        <Dropdown
                            trigger={["click"]}
                            menu={{
                                items: [
                                    { key: "history", label: "历史恢复与备份管理", onClick: () => window.dispatchEvent(new Event("canvas-backup-open")) },
                                    { key: "structure", label: "导出全部画布结构（不含媒体）", disabled: !hydrated || !projects.length, onClick: () => void backupProjectStructures() },
                                ],
                            }}
                        >
                            <Button aria-label="备份与恢复" title="历史恢复、备份管理与结构导出">
                                备份与恢复
                            </Button>
                        </Dropdown>
                        <Button disabled={!hydrated} icon={<FileUp className="size-4" />} onClick={() => inputRef.current?.click()}>
                            {t("canvas.import")}
                        </Button>
                        <Button disabled={!hydrated} type="primary" icon={<Plus className="size-4" />} onClick={createAndEnter}>
                            {t("canvas.create")}
                        </Button>
                    </div>
                </header>

                {!hydrated ? (
                    <section className="flex min-h-[360px] items-center justify-center border-y border-stone-200 text-sm text-stone-500 dark:border-stone-800">{t("canvas.loading")}</section>
                ) : projects.length ? (
                    <div className="grid grid-cols-[repeat(auto-fill,250px)] gap-5">
                        {projects.map((project) => (
                            <CanvasProjectCard key={project.id} project={project} />
                        ))}
                    </div>
                ) : (
                    <section className="flex min-h-[360px] flex-col items-center justify-center border-y border-stone-200 text-center dark:border-stone-800">
                        <h2 className="text-xl font-medium">{t("canvas.empty")}</h2>
                        <p className="mt-3 text-sm text-stone-500">{t("canvas.emptyDescription")}</p>
                        <Button type="primary" className="mt-6" icon={<Plus className="size-4" />} onClick={createAndEnter}>
                            {t("canvas.create")}
                        </Button>
                    </section>
                )}

                <section className="mt-4 border-t border-stone-200 pt-8 dark:border-stone-800">
                    <header className="mb-6 flex items-center justify-between gap-4">
                        <div>
                            <p className="text-xs text-stone-500">分镜生产库</p>
                            <h2 className="mt-2 text-2xl font-semibold">看板</h2>
                        </div>
                        <Button disabled={!boardsHydrated} type="primary" icon={<Plus className="size-4" />} onClick={() => navigate(`/boards/${createBoard()}?setupFolders=1`)}>新建看板</Button>
                    </header>
                    {!boardsHydrated ? (
                        <div className="flex min-h-48 items-center justify-center text-sm text-stone-500">正在加载看板…</div>
                    ) : boards.length ? (
                        <div className="grid grid-cols-[repeat(auto-fill,250px)] gap-5">{boards.map((board) => <BoardProjectCard key={board.id} board={board} />)}</div>
                    ) : (
                        <div className="flex min-h-48 flex-col items-center justify-center border-y border-stone-200 text-center dark:border-stone-800"><h3 className="text-lg font-medium">还没有看板</h3><p className="mt-2 text-sm text-stone-500">新建看板，按分镜顺序管理多次视频生成。</p></div>
                    )}
                </section>
            </div>

            <input ref={inputRef} type="file" accept="application/zip,.zip,.cinepack,application/vnd.cineflow.cinepack+zip" className="hidden" onChange={(event) => void importCanvas(event.target.files?.[0])} />
            <CanvasDeleteProjectsDialog />
        </main>
    );
}

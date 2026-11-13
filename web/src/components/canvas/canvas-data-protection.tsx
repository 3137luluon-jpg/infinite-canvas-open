import { useEffect, useState, useSyncExternalStore } from "react";
import { useMatch } from "react-router-dom";
import { App, Button, Modal, Select } from "antd";
import { ShieldCheck } from "lucide-react";
import {
    chooseRecoverySource,
    ensureProjectBackup,
    getBackupState,
    loadBackupSettings,
    listRecoverySources,
    serverRecoverySource,
    startBackupRequestListener,
    repairMissingDiskMedia,
    restoreDiskSnapshot,
    runDiskBackup,
    subscribeBackup,
    type RecoverySource,
    type RecoveryCatalogEntry,
} from "@/lib/canvas/canvas-disk-backup";
import { getPersistErrors, subscribePersistErrors } from "@/lib/persist-health";
import { useCanvasStore } from "@/stores/canvas/use-canvas-store";
import { exportCanvasProjects } from "@/lib/canvas/canvas-export";
import { saveAs } from "file-saver";
import { backupSuccessMessage, sameBackupScope } from "@/lib/canvas/canvas-backup-feedback";

export function CanvasDataProtection() {
    const { message } = App.useApp();
    const [open, setOpen] = useState(false);
    const [source, setSource] = useState<RecoverySource>();
    const [catalog, setCatalog] = useState<RecoveryCatalogEntry[]>([]);
    const [version, setVersion] = useState<string>();
    const [working, setWorking] = useState(false);
    const [preview, setPreview] = useState("");
    const [storageEstimate, setStorageEstimate] = useState("");
    useEffect(() => {
        if (open)
            void navigator.storage
                ?.estimate()
                .then((s) => setStorageEstimate(`浏览器存储：已用 ${((s.usage || 0) / 1024 ** 3).toFixed(2)} GB / 配额 ${((s.quota || 0) / 1024 ** 3).toFixed(2)} GB`))
                .catch(() => {});
    }, [open]);
    const status = useSyncExternalStore(subscribeBackup, getBackupState);
    const errors = useSyncExternalStore(subscribePersistErrors, getPersistErrors);
    useEffect(() => {
        let active = true;
        setPreview("");
        if (source && version)
            void source.io
                .read(version)
                .then(async (file) => {
                    const data = file ? JSON.parse(await file.text()) : null;
                    if (active) setPreview(data?.projects ? `${data.projects.length} 个画布 · ${data.complete ? "完整版本（恢复时再次校验媒体）" : `不完整版本，缺少 ${data.missing?.length ?? "未知"} 项媒体`}` : "备份格式无效");
                })
                .catch(() => {
                    if (active) setPreview("无法读取此版本，请另选备份");
                });
        return () => {
            active = false;
        };
    }, [source, version]);
    useEffect(() => {
        void loadBackupSettings();
        const unsubscribe = useCanvasStore.subscribe((next, previous) => {
            if (!next.hydrated) return;
            const known = new Map(previous.projects.map((p) => [p.id, p.title]));
            for (const project of next.projects)
                if ((!previous.hydrated && !project.title) || (previous.hydrated && (!known.has(project.id) || known.get(project.id) !== project.title))) {
                    void ensureProjectBackup(project.id)
                        .then((ok) => {
                            if (!ok) message.info("画布尚未就绪，请加载后重试备份");
                        })
                        .catch((error) => message.warning(`项目目录未建立：${error instanceof Error ? error.message : String(error)}`));
                }
        });
        const stopRequests = startBackupRequestListener(() => {
            const id = /^\/canvas\/([^/]+)\/?$/.exec(window.location.pathname)?.[1];
            return id && useCanvasStore.getState().hydrated ? [decodeURIComponent(id)] : [];
        });
        const show = () => setOpen(true);
        const beforeUnload = (event: BeforeUnloadEvent) => {
            if (getPersistErrors().length || getBackupState().busy) {
                event.preventDefault();
                event.returnValue = "";
            }
        };
        window.addEventListener("canvas-backup-open", show);
        window.addEventListener("beforeunload", beforeUnload);
        return () => {
            unsubscribe();
            stopRequests();
            window.removeEventListener("canvas-backup-open", show);
            window.removeEventListener("beforeunload", beforeUnload);
        };
    }, []);
    const run = async (task: () => Promise<unknown>) => {
        setWorking(true);
        try {
            await task();
        } catch (error) {
            if (!(error instanceof DOMException && error.name === "AbortError")) message.error(error instanceof Error ? error.message : String(error), 10);
        } finally {
            setWorking(false);
        }
    };
    const unhealthy = errors.length > 0;
    return (
        <>
            {unhealthy && (
                <div role="alert" className="fixed bottom-2 left-1/2 z-[10001] max-w-xl -translate-x-1/2 rounded border border-border bg-background px-3 py-2 text-sm text-foreground shadow">
                    保存失败：请勿关闭页面，先导出备份。
                    <Button size="small" type="link" onClick={() => setOpen(true)}>
                        查看与备份
                    </Button>
                </div>
            )}
            <Modal open={open} zIndex={11000} title="数据保护与恢复" footer={null} onCancel={() => setOpen(false)} width={650}>
                <p className="mb-3">顶栏“备份”直接增量保存当前画布。此处“备份全部画布”保留原全库备份入口；后台任务期间可关闭本面板继续操作。</p>
                <p className="mb-3 text-xs text-muted-foreground">{storageEstimate}</p>
                {status.destinations[0] && (
                    <p className="mb-3 text-sm text-muted-foreground">
                        {status.destinations[0].label} · {status.destinations[0].message}
                    </p>
                )}
                <Button
                    type="primary"
                    loading={working || status.busy}
                    disabled={working || status.busy}
                    className="mb-3"
                    onClick={() =>
                        void run(async () => {
                            await runDiskBackup(true);
                        })
                    }
                >
                    备份全部画布
                </Button>
                <details className="mb-3">
                    <summary className="cursor-pointer text-sm text-muted-foreground">统一目录与备份范围</summary>
                    <p className="my-2 text-sm text-muted-foreground">包含画布、提示词和引用媒体；不含独立看板、渠道密钥与生成订单。保留历史备份，缺失媒体会显示在结果中。</p>
                    <p className="my-2 text-sm text-muted-foreground">备份使用本地服务配置的统一目录，无需选择路径。目录不可用时会明确报错。</p>
                </details>
                {!!errors.length && (
                    <div role="alert" className="mb-3">
                        浏览器保存失败：{errors.map((item) => item.error).join("；")}。请先下载备份，再排查存储，不能将当前状态当作已保存。
                    </div>
                )}
                <div className="mb-4 flex flex-wrap gap-2">
                    <Button
                        disabled={working}
                        onClick={() =>
                            void run(async () => {
                                const entries = await listRecoverySources();
                                setCatalog(entries);
                                if (!entries.length) message.info("统一目录暂无可恢复版本");
                            })
                        }
                    >
                        查看统一目录历史
                    </Button>
                    <Button
                        onClick={() => saveAs(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), mediaIncluded: false, projects: useCanvasStore.getState().projects })], { type: "application/json" }), `画布紧急结构备份-${Date.now()}.json`)}
                    >
                        导出紧急结构备份（不含媒体）
                    </Button>
                    <Button
                        disabled={working}
                        onClick={() =>
                            void run(async () => {
                                const result = await exportCanvasProjects(useCanvasStore.getState().projects, "全部画布完整导出");
                                message.info(result.missingCount ? `已下载，缺少 ${result.missingCount} 项媒体，详见包内清单` : "已发起完整导出下载，请确认下载完成");
                            })
                        }
                    >
                        导出全部画布
                    </Button>
                    <Button
                        disabled={working}
                        onClick={() =>
                            void run(async () => {
                                const next = await chooseRecoverySource();
                                setSource(next);
                                setVersion(next.files[0]);
                            })
                        }
                    >
                        从其他旧目录恢复
                    </Button>
                </div>
                {!!catalog.length && (
                    <Select
                        className="mb-3 w-full"
                        placeholder="选择历史项目目录"
                        options={catalog.map((entry) => ({ value: entry.sourceId, label: entry.label }))}
                        onChange={(id) => {
                            const entry = catalog.find((item) => item.sourceId === id)!;
                            setSource(serverRecoverySource(entry));
                            setVersion(entry.files[0]);
                        }}
                    />
                )}
                {source && (
                    <div className="border-t border-border pt-3">
                        <p className="mb-2">选择历史版本。snapshot 为含可用媒体的版本，structure 为先行结构备份。恢复将新增副本，校验失败不会导入；不覆盖现有画布。</p>
                        <Select className="mb-3 w-full" value={version} onChange={setVersion} options={source.files.map((value) => ({ value, label: value.replace("snapshots/", "") }))} />
                        <p className="mb-3">{preview}</p>
                        <Button
                            className="mb-3"
                            loading={working}
                            disabled={!version || working}
                            onClick={() =>
                                void run(async () => {
                                    const result = await repairMissingDiskMedia(source, version!, setPreview);
                                    setPreview(`已补回 ${result.restored} 项，保留现有 ${result.present} 项，仍缺 ${result.missing} 项；画布结构未改动。`);
                                })
                            }
                        >
                            补回已有画布缺失媒体
                        </Button>
                        <p className="mb-3 text-xs text-muted-foreground">按全部已有画布的引用补回缺失媒体，保留节点、提示词与已有媒体；逐项校验后写入，失败可重复执行。</p>
                        <Button
                            loading={working}
                            disabled={!version}
                            onClick={() =>
                                void run(async () => {
                                    const result = await restoreDiskSnapshot(source, version!);
                                    message.warning(`已恢复 ${result.projects} 个画布副本；缺少 ${result.missing} 项媒体`, 10);
                                })
                            }
                        >
                            校验并恢复为副本
                        </Button>
                    </div>
                )}
            </Modal>
        </>
    );
}
export function CanvasBackupButton() {
    const projectId = useMatch("/canvas/:id")?.params.id;
    const { message } = App.useApp();
    const status = useSyncExternalStore(subscribeBackup, getBackupState);
    const backup = async () => {
        try {
            const before = getBackupState();
            const projectsBefore = useCanvasStore.getState().projects;
            const unchangedBefore = before.phase === "success" && sameBackupScope(before.savedProjects, projectsBefore, projectId);
            const result = await runDiskBackup(true, projectId);
            if (result.cacheWarning) message.warning(result.cacheWarning);
            const projectsAfter = useCanvasStore.getState().projects;
            const feedback = backupSuccessMessage(result, unchangedBefore && sameBackupScope(projectsBefore, projectsAfter, projectId) && sameBackupScope(getBackupState().savedProjects, projectsAfter, projectId));
            if (feedback) message.success(feedback, 2);
            else message.warning(`结构已备份，缺少 ${result.missing} 项媒体；可从画布库“备份与恢复”查看历史`, 6);
        } catch (error) {
            if (!(error instanceof DOMException && error.name === "AbortError")) message.error(error instanceof Error ? error.message : String(error), 10);
        }
    };
    return (
        <span className="inline-flex items-center" data-backup-state={status.phase || "idle"} data-backup-task-id={status.taskId || ""}>
            <button
                type="button"
                disabled={status.busy || !status.settingsLoaded}
                aria-label={status.busy ? "备份中" : "备份"}
                aria-busy={status.busy}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground hover:bg-muted disabled:opacity-50"
                onClick={() => void backup()}
                title={status.error || status.destinations[0]?.message || "增量备份当前画布"}
            >
                <ShieldCheck className="size-4" />
                <span role="status">{status.busy ? "备份中" : "备份"}</span>
            </button>
        </span>
    );
}

import { App, Button, Modal } from "antd";
import { FolderOpen } from "lucide-react";
import { useEffect, useState } from "react";
import { syncProjectDiskMedia } from "@/lib/canvas/canvas-disk-backup";
import { backupRequest } from "@/lib/canvas/canvas-backup-http";

export function CanvasDiskMediaModal({ projectId, onClose, onLegacyFolders }: { projectId: string; onClose: () => void; onLegacyFolders: () => void }) {
    const { message } = App.useApp();
    const [root, setRoot] = useState("");
    const [result, setResult] = useState<Awaited<ReturnType<typeof syncProjectDiskMedia>>>();
    const [error, setError] = useState("");
    const [attempt, setAttempt] = useState(0);
    const [busy, setBusy] = useState(true);
    const [opening, setOpening] = useState(false);

    useEffect(() => {
        let active = true;
        setBusy(true);
        setError("");
        void backupRequest<{ root: string }>("/status").then((status) => {
            if (active) setRoot(status.root);
        }).catch(() => undefined);
        void syncProjectDiskMedia(projectId).then((next) => {
            if (active) setResult(next);
        }).catch((error: unknown) => {
            if (active) setError(error instanceof Error ? error.message : String(error));
        }).finally(() => {
            if (active) setBusy(false);
        });
        return () => { active = false; };
    }, [attempt, projectId]);

    const openFolder = async () => {
        setOpening(true);
        try {
            await backupRequest("/open-project-folder", { projectId });
        } catch (error) {
            message.error(error instanceof Error ? error.message : "打开文件夹失败");
        } finally {
            setOpening(false);
        }
    };

    return (
        <Modal open title="画布资产目录" onCancel={onClose} footer={<Button onClick={onClose}>关闭</Button>}>
            <div className="space-y-3 break-all">
                <div><div className="font-medium">固定根目录</div>{result?.root || root || "正在读取本机配置…"}</div>
                <div><div className="font-medium">当前画布目录</div>{result?.path || (error ? "暂不可用" : "正在同步…")}</div>
                <div className="opacity-75">图片、视频、音频分别存入 pic、video、audio。</div>
                {busy ? <div>正在同步当前画布的素材…</div> : null}
                {error ? <div role="alert">同步失败。{error}</div> : null}
                {result && !busy && !error ? <div>已落盘 {result.available} 项{result.missing ? `，${result.missing} 项暂时无法读取或识别格式` : ""}。</div> : null}
                <Button type="primary" icon={<FolderOpen className="size-4" />} loading={opening} onClick={() => void openFolder()}>打开文件夹</Button>
                <details>
                    <summary className="cursor-pointer text-sm opacity-75">更多操作</summary>
                    <div className="mt-2 flex flex-wrap gap-2">
                        <Button disabled={!result || !!error} onClick={() => {
                            if (result) void navigator.clipboard.writeText(result.path).then(() => message.success("已复制目录路径"), () => message.error("复制失败，请选中路径手动复制"));
                        }}>复制路径</Button>
                        <Button loading={busy} onClick={() => setAttempt((current) => current + 1)}>补存素材</Button>
                        <Button type="link" onClick={onLegacyFolders}>旧目录设置</Button>
                    </div>
                </details>
            </div>
        </Modal>
    );
}

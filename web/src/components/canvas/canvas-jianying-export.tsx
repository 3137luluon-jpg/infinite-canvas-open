import { useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import { Alert, Button, Input, Modal, Select } from "antd";
import { ArrowDown, ArrowUp, Check, Clapperboard, Film, Search, Sparkles, X } from "lucide-react";

import { canvasThemes } from "@/lib/canvas-theme";
import { canExportToJianying, exportJianyingDraft, JianyingExportError } from "@/lib/canvas/jianying-export";
import { videoLibraryEntries, type VideoLibraryEntry, type VideoLibrarySection } from "@/lib/canvas/video-library";
import { cachedVideoPreview } from "@/lib/canvas/video-preview";
import { useThemeStore } from "@/stores/use-theme-store";

type VersionFilter = "all" | "adopted" | "latest";
const maxClips = 50;
const pageSize = 30;

function groupByShot(entries: VideoLibraryEntry[]) {
    const shots = new Map<string, VideoLibraryEntry[]>();
    for (const entry of entries) {
        const { sectionId, shotId } = entry.organization;
        const key = JSON.stringify([sectionId, shotId]);
        const versions = shots.get(key);
        if (versions) versions.push(entry);
        else shots.set(key, [entry]);
    }
    return [...shots.values()];
}

function formatDuration(ms: number) {
    const seconds = Math.round(ms / 1000);
    return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

export function CanvasJianyingExport({ sections, selectedIds, title, onClose }: {
    sections: VideoLibrarySection[];
    selectedIds: Set<string>;
    title: string;
    onClose: () => void;
}) {
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const clips = useMemo(() => videoLibraryEntries(sections).filter(({ node }) => canExportToJianying(node)), [sections]);
    const byId = useMemo(() => new Map(clips.map((entry) => [entry.node.id, entry])), [clips]);
    const latestIds = useMemo(() => new Set(groupByShot(clips).map((versions) => versions[versions.length - 1].node.id)), [clips]);
    const [queue, setQueue] = useState(() => clips.filter(({ node }) => selectedIds.has(node.id)).map(({ node }) => node.id));
    const [query, setQuery] = useState("");
    const [sectionId, setSectionId] = useState("");
    const [version, setVersion] = useState<VersionFilter>("all");
    const [limit, setLimit] = useState(pageSize);
    const [name, setName] = useState(`${title} · 剪映`.slice(0, 80));
    const [progress, setProgress] = useState("");
    const [error, setError] = useState("");
    const [created, setCreated] = useState("");
    const busy = useRef(false);
    const picked = useMemo(() => new Set(queue), [queue]);
    const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const filtered = clips.filter(({ node, organization, adopted }) => {
        if (sectionId && organization.sectionId !== sectionId) return false;
        if ((version === "adopted" && !adopted) || (version === "latest" && !latestIds.has(node.id))) return false;
        const text = `${node.title || ""} ${organization.sectionLabel} ${organization.shotLabel} v${organization.versionOrder}`.toLocaleLowerCase();
        return words.every((word) => text.includes(word));
    });
    const ordered = queue.map((id) => byId.get(id)!);
    const knownDuration = ordered.reduce((sum, { node }) => sum + (node.metadata?.durationMs || 0), 0);
    const completeDuration = ordered.length > 0 && ordered.every(({ node }) => Boolean(node.metadata?.durationMs));
    const tooMany = queue.length > maxClips;

    function toggle(id: string) {
        setQueue((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
    }

    function move(index: number, offset: number) {
        setQueue((current) => {
            const next = [...current];
            [next[index], next[index + offset]] = [next[index + offset], next[index]];
            return next;
        });
    }

    function pickAutomatically() {
        setQueue(groupByShot(filtered).map((versions) => {
            const adopted = versions.filter((entry) => entry.adopted);
            const candidates = adopted.length ? adopted : versions;
            return candidates[candidates.length - 1].node.id;
        }));
    }

    async function submit() {
        if (busy.current || created || !name.trim() || !ordered.length || tooMany) return;
        busy.current = true;
        setError("");
        try {
            setProgress("正在准备导出…");
            setCreated(await exportJianyingDraft(name.trim(), ordered.map(({ node }) => node), setProgress));
        } catch (reason) {
            if (!(reason instanceof JianyingExportError) || reason.cause) console.error("[剪映导出]", reason);
            setError(reason instanceof JianyingExportError ? reason.message : "导出剪映草稿时遇到问题，请稍后重试。");
        } finally {
            busy.current = false;
            setProgress("");
        }
    }

    const palette = {
        "--draft-border": theme.toolbar.border,
        "--draft-panel": theme.node.panel,
        "--draft-background": theme.canvas.background,
        "--draft-muted": theme.node.muted,
        "--draft-selected": theme.toolbar.activeBg,
    } as CSSProperties;

    return (
        <Modal open title={<span className="inline-flex items-center gap-2"><Clapperboard size={18} /> 导出到剪映</span>} width={960}
            styles={{ container: { background: theme.node.panel }, header: { background: "transparent" } }}
            footer={null} onCancel={onClose} closable={!progress} keyboard={!progress} mask={{ closable: false }}>
            {created ? <div className="space-y-4 pt-3">
                <Alert type="success" showIcon title={`已生成「${created}」`} description="打开剪映后，可在首页草稿列表找到它。" />
                <div className="flex justify-end"><Button type="primary" onClick={onClose}>完成</Button></div>
            </div> : <div className="space-y-4 pt-2" style={palette} data-canvas-shortcuts-ignore data-canvas-no-zoom>
                <div className="grid gap-3 md:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
                    <section aria-label="画布成片" className="min-w-0 overflow-hidden rounded-2xl border border-[var(--draft-border)] bg-[var(--draft-panel)]">
                        <div className="space-y-3 border-b border-[var(--draft-border)] p-3.5">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                                <div className="flex items-baseline gap-2"><h3 className="m-0 text-sm font-semibold">画布成片</h3><span className="text-xs text-[var(--draft-muted)]">{filtered.length} / {clips.length} 段</span></div>
                                <Button size="small" icon={<Sparkles size={13} />} disabled={!filtered.length || Boolean(progress)}
                                    title="按当前筛选每镜头选一版，优先已采用，否则取最新，并替换当前清单" onClick={pickAutomatically}>自动选片</Button>
                            </div>
                            <Input allowClear prefix={<Search size={14} />} aria-label="搜索视频" placeholder="搜索视频、段落或镜头" value={query}
                                onChange={(event) => { setQuery(event.target.value); setLimit(pageSize); }} />
                            <div className="grid grid-cols-2 gap-2">
                                <Select aria-label="段落筛选" value={sectionId} onChange={(value) => { setSectionId(value); setLimit(pageSize); }}
                                    options={[{ value: "", label: "全部段落" }, ...sections.filter((section) => section.shots.some((shot) => shot.entries.some(({ node }) => byId.has(node.id)))).map(({ id, label }) => ({ value: id, label }))]} />
                                <Select<VersionFilter> aria-label="版本筛选" value={version} onChange={(value) => { setVersion(value); setLimit(pageSize); }}
                                    options={[{ value: "all", label: "全部版本" }, { value: "adopted", label: "已采用" }, { value: "latest", label: "每镜头最新版" }]} />
                            </div>
                        </div>
                        <div className="min-h-28 max-h-[39vh] space-y-1 overflow-y-auto p-2 md:min-h-48" aria-label="筛选结果">
                            {filtered.slice(0, limit).map(({ node, organization, adopted }) => {
                                const isPicked = picked.has(node.id);
                                const preview = cachedVideoPreview(node.metadata?.content || "");
                                return <label key={node.id} className={`flex min-w-0 cursor-pointer items-center gap-2.5 rounded-lg border px-2.5 py-2 transition-colors ${isPicked ? "border-[var(--draft-border)] bg-[var(--draft-selected)]" : "border-transparent hover:bg-[var(--draft-background)]"}`}>
                                    <input type="checkbox" className="size-4 shrink-0" checked={isPicked} disabled={Boolean(progress)} aria-label={`选择 ${node.title || organization.shotLabel}`} onChange={() => toggle(node.id)} />
                                    <span className="grid h-9 w-14 shrink-0 place-items-center overflow-hidden rounded-md bg-[var(--draft-background)] text-[var(--draft-muted)]" aria-hidden="true">
                                        {preview ? <img src={preview} alt="" className="size-full object-cover" /> : <Film size={15} />}
                                    </span>
                                    <span className="min-w-0 flex-1">
                                        <span className="block truncate text-sm font-medium" title={node.title}>{node.title || "未命名视频"}</span>
                                        <span className="block truncate text-xs text-[var(--draft-muted)]">{organization.sectionLabel} / {organization.shotLabel} · V{organization.versionOrder}</span>
                                    </span>
                                    {adopted ? <span className="shrink-0 text-xs text-[var(--draft-muted)]"><Check size={12} className="mr-0.5 inline" />已采用</span> : latestIds.has(node.id) ? <span className="shrink-0 text-xs text-[var(--draft-muted)]">最新</span> : null}
                                </label>;
                            })}
                            {!filtered.length && <p className="py-8 text-center text-xs text-[var(--draft-muted)]">{clips.length ? "没有符合筛选条件的成片。" : "当前画布还没有可导出的视频。"}</p>}
                            {filtered.length > limit && <div className="py-1 text-center"><Button size="small" type="text" onClick={() => setLimit(limit + pageSize)}>查看更多</Button></div>}
                        </div>
                    </section>
                    <section aria-label="剪辑清单" className="min-w-0 overflow-hidden rounded-2xl border border-[var(--draft-border)] bg-[var(--draft-background)]">
                        <div className="border-b border-[var(--draft-border)] p-3.5">
                            <div className="flex items-center justify-between gap-2">
                                <div className="flex items-baseline gap-2"><h3 className="m-0 text-sm font-semibold">剪辑清单</h3><span className="text-xs text-[var(--draft-muted)]">{queue.length} 段{completeDuration ? ` · 约 ${formatDuration(knownDuration)}` : ""}</span></div>
                                <Button size="small" type="text" disabled={!queue.length || Boolean(progress)} onClick={() => setQueue([])}>清空</Button>
                            </div>
                            <p className="mb-0 mt-1 text-xs text-[var(--draft-muted)]">从上到下对应剪映时间线顺序</p>
                        </div>
                        <ol className="m-0 min-h-28 max-h-[46vh] list-none space-y-1 overflow-y-auto p-2 md:min-h-48" aria-label="草稿镜头顺序">
                            {ordered.map(({ node, organization }, index) => <li key={node.id} className="flex min-w-0 items-center gap-1.5 rounded-lg bg-[var(--draft-panel)] px-2 py-1.5">
                                <span className="grid size-6 shrink-0 place-items-center rounded-md bg-[var(--draft-selected)] text-xs tabular-nums">{String(index + 1).padStart(2, "0")}</span>
                                <span className="min-w-0 flex-1 truncate text-xs font-medium" title={node.title}>{node.title || organization.shotLabel}</span>
                                <Button size="small" type="text" aria-label={`上移第 ${index + 1} 段`} disabled={index === 0 || Boolean(progress)} icon={<ArrowUp size={13} />} onClick={() => move(index, -1)} />
                                <Button size="small" type="text" aria-label={`下移第 ${index + 1} 段`} disabled={index === ordered.length - 1 || Boolean(progress)} icon={<ArrowDown size={13} />} onClick={() => move(index, 1)} />
                                <Button size="small" type="text" aria-label={`移除第 ${index + 1} 段`} disabled={Boolean(progress)} icon={<X size={13} />} onClick={() => toggle(node.id)} />
                            </li>)}
                            {!ordered.length && <li className="py-8 text-center text-xs text-[var(--draft-muted)]">从成片列表勾选，或使用「自动选片」</li>}
                        </ol>
                    </section>
                </div>
                {tooMany && <Alert type="warning" title={`一次最多导出 ${maxClips} 段，请缩小筛选范围或移除部分视频。`} />}
                {error && <Alert type="error" showIcon title={error} />}
                <div className="flex flex-wrap items-end justify-between gap-3 border-t border-[var(--draft-border)] pt-3">
                    <label className="min-w-[160px] flex-1 text-xs font-medium">草稿名称<Input className="mt-1" value={name} maxLength={80} disabled={Boolean(progress)} onChange={(event) => setName(event.target.value)} /></label>
                    <div className="flex flex-wrap items-center gap-3">
                        {progress && <span role="status" className="text-xs text-[var(--draft-muted)]">{progress}</span>}
                        <Button type="primary" icon={<Clapperboard size={15} />} loading={Boolean(progress)} disabled={!queue.length || tooMany || !name.trim()} onClick={() => void submit()}>导出剪映草稿</Button>
                    </div>
                </div>
                <p className="m-0 text-xs leading-5 text-[var(--draft-muted)]">如果剪映开着，请先完全关闭剪映，退回首页还不够。导出成功后再打开剪映，在首页草稿列表查看。</p>
            </div>}
        </Modal>
    );
}

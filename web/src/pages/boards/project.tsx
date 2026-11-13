import { App, Button, Empty, Input, Modal, Select, Tooltip } from "antd";
import { ArrowLeft, Camera, Download, FolderOpen, GripVertical, LoaderCircle, Music2, Pencil, Play, Plus, Star, Trash2, Video as VideoIcon } from "lucide-react";
import { nanoid } from "nanoid";
import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";
import { saveAs } from "file-saver";

import { CanvasNodePromptPanel } from "@/components/canvas/canvas-node-prompt-panel";
import { CanvasLocalFoldersModal } from "@/components/canvas/canvas-local-folders-modal";
import { imageReferenceLabel } from "@/lib/image-reference-prompt";
import { seedanceReferenceLabel } from "@/lib/seedance-video";
import { inferVideoDurationFromPrompt, integerDurationRange, isAutoVideoDuration } from "@/lib/video-duration";
import { createVideoGenerationTask, pollVideoGenerationTask, storeGeneratedVideo } from "@/services/api/video";
import { getImageBlob, resolveImageUrl, uploadImage } from "@/services/image-storage";
import { getMediaBlob, resolveMediaUrl, uploadMediaFile } from "@/services/file-storage";
import { pollApimartImageTask, requestEdit, requestGeneration, type ImageRequestOptions } from "@/services/api/image";
import { pollComfyUiImageTask } from "@/services/api/comfyui";
import { compileKinStoryboardPlan } from "@/lib/canvas/storyboard-generation";
import { mentionedReferenceLabels } from "@/lib/canvas/canvas-mention-style";
import { buildGenerationConfig } from "@/lib/canvas/canvas-generation-helpers";
import { normalizeImageAspect } from "@/lib/apimart-image";
import { backupGeneratedBoardMedia, writeGeneratedBlob, type CanvasFolderLabels } from "@/lib/canvas/canvas-local-folders";
import { createBoardShot, createBoardVideo, useBoardStore } from "@/stores/board/use-board-store";
import { defaultConfig, modelOptionLabel, resolveModelForCapability, resolveModelRequestConfig, useConfigStore, useEffectiveConfig, waitForConfigHydration, type AiConfig } from "@/stores/use-config-store";
import { useAssetStore, type Asset } from "@/stores/use-asset-store";
import { CanvasNodeType, type CanvasNodeData } from "@/types/canvas";
import type { BoardProject, BoardReference, BoardShot, BoardStoryboard, BoardVideo } from "@/types/board";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import type { ReferenceImage } from "@/types/image";
import type { ReferenceAudio, ReferenceVideo } from "@/types/media";
import { AssetDetailModal, type NewAssetDraft } from "@/components/assets/asset-detail-modal";
import type { AssetKind, AssetType } from "@/stores/use-asset-store";

export default function BoardProjectPage() {
    const { id = "" } = useParams();
    const navigate = useNavigate();
    const [searchParams, setSearchParams] = useSearchParams();
    const { message } = App.useApp();
    const config = useEffectiveConfig();
    const board = useBoardStore((state) => state.boards.find((item) => item.id === id));
    const updateBoard = useBoardStore((state) => state.updateBoard);
    const renameBoard = useBoardStore((state) => state.renameBoard);
    const assets = useAssetStore((state) => state.assets);
    const [editingTitle, setEditingTitle] = useState(false);
    const [title, setTitle] = useState("");
    const [previewVideo, setPreviewVideo] = useState<BoardVideo | null>(null);
    const [detailAssetId, setDetailAssetId] = useState<string | null>(null);
    const [newAssetDraft, setNewAssetDraft] = useState<NewAssetDraft | null>(null);
    const [previewStoryboard, setPreviewStoryboard] = useState<string | null>(null);
    const [localFoldersOpen, setLocalFoldersOpen] = useState(false);
    const activePolling = useRef(new Set<string>());
    const activeStoryboardPolling = useRef(new Set<string>());
    const previewVideoRef = useRef<HTMLVideoElement>(null);

    useEffect(() => setTitle(board?.title || ""), [board?.title]);
    useEffect(() => {
        if (!board || searchParams.get("setupFolders") !== "1") return;
        setLocalFoldersOpen(true);
        const next = new URLSearchParams(searchParams);
        next.delete("setupFolders");
        setSearchParams(next, { replace: true });
    }, [board, searchParams, setSearchParams]);

    const mutate = useCallback((updater: (value: BoardProject) => BoardProject) => updateBoard(id, updater), [id, updateBoard]);
    const selectedShot = board?.shots.find((shot) => shot.id === board.activeShotId) || board?.shots[0];
    const selectedVideo = selectedShot?.videos.find((video) => video.id === selectedShot.selectedVideoId) || selectedShot?.videos[0];

    const patchVideo = useCallback((shotId: string, videoId: string, patch: Partial<BoardVideo>) => {
        mutate((current) => ({
            ...current,
            shots: current.shots.map((shot) => shot.id === shotId ? { ...shot, updatedAt: new Date().toISOString(), videos: shot.videos.map((video) => video.id === videoId ? { ...video, ...patch, updatedAt: new Date().toISOString() } : video) } : shot),
        }));
    }, [mutate]);

    const selectShot = (shotId: string) => mutate((current) => {
        const viewedAt = new Date().toISOString();
        return { ...current, activeShotId: shotId, shots: current.shots.map((shot) => shot.id === shotId || shot.id === current.activeShotId ? { ...shot, lastViewedAt: viewedAt } : shot) };
    });
    const selectVideo = (shotId: string, videoId: string) => mutate((current) => ({ ...current, shots: current.shots.map((shot) => shot.id === shotId ? { ...shot, selectedVideoId: videoId } : shot) }));
    const addShot = () => mutate((current) => {
        const shot = createBoardShot(current.shots.length + 1);
        const viewedAt = new Date().toISOString();
        return { ...current, activeShotId: shot.id, shots: [...current.shots.map((item) => item.id === current.activeShotId ? { ...item, lastViewedAt: viewedAt } : item), shot] };
    });

    const poll = useCallback(async (shotId: string, videoId: string, task: NonNullable<BoardVideo["task"]>, taskConfig: AiConfig) => {
        if (activePolling.current.has(videoId)) return;
        activePolling.current.add(videoId);
        try {
            for (let attempt = 0; attempt < 120; attempt += 1) {
                const state = await pollVideoGenerationTask(taskConfig, task);
                if (state.status === "completed") {
                    const stored = await storeGeneratedVideo(state.result);
                    const blob = stored.storageKey ? await getMediaBlob(stored.storageKey).catch(() => null) : null;
                    if (blob) await writeGeneratedBlob(`board:${id}`, "video", blob, "mp4", stored.storageKey).catch(() => false);
                    patchVideo(shotId, videoId, { status: "success", task: undefined, progress: 100, content: stored.url, storageKey: stored.storageKey, mimeType: stored.mimeType, bytes: stored.bytes, width: stored.width || 1280, height: stored.height || 720, durationMs: stored.durationMs });
                    message.success("视频生成完成");
                    return;
                }
                if (state.status === "failed") throw new Error(state.error);
                patchVideo(shotId, videoId, { progress: state.progress });
                await new Promise((resolve) => window.setTimeout(resolve, task.provider === "seedance" || task.provider === "feimiao" ? 5000 : 2500));
            }
            throw new Error("视频生成超时");
        } catch (error) {
            const detail = error instanceof Error ? error.message : "视频生成失败";
            patchVideo(shotId, videoId, { status: "error", task: undefined, error: detail });
            message.error(detail);
        } finally {
            activePolling.current.delete(videoId);
        }
    }, [id, message, patchVideo]);

    useEffect(() => {
        if (!board) return;
        void (async () => {
            await waitForConfigHydration();
            const hydratedConfig = { ...useConfigStore.getState().config, channelMode: "local" as const };
            for (const shot of board.shots) for (const video of shot.videos) {
                if (video.status !== "loading" || !video.task) continue;
                void poll(shot.id, video.id, video.task, videoConfig(hydratedConfig, video));
            }
        })();
    }, [board?.id, config, poll]);

    useEffect(() => {
        if (!board) return;
        void (async () => {
            await waitForConfigHydration();
            const hydratedConfig = { ...useConfigStore.getState().config, channelMode: "local" as const };
            for (const shot of board.shots) for (const video of shot.videos) for (const storyboard of video.storyboards) {
                if (storyboard.status !== "loading" || !storyboard.task || activeStoryboardPolling.current.has(storyboard.id)) continue;
                activeStoryboardPolling.current.add(storyboard.id);
                const task = storyboard.task;
                const imageLabel = modelOptionLabel(hydratedConfig, task.model);
                const pollStoryboard = task.provider === "comfyui" ? pollComfyUiImageTask : pollApimartImageTask;
                void pollStoryboard(resolveModelRequestConfig(hydratedConfig, task.model), task.id, { onTaskState: ({ stage, attempt }) => patchBoardStoryboard(id, shot.id, video.id, storyboard.id, { phase: stage, phaseDetail: stage === "downloading" ? "故事板已生成，正在下载结果" : `${imageLabel} ${stage === "queued" ? "排队中" : "正在生成"}${attempt ? ` · 第 ${attempt} 次查询` : ""}` }) })
                    .then(async (images) => {
                        const stored = await uploadImage(images[0].dataUrl);
                        const blob = stored.storageKey ? await getImageBlob(stored.storageKey).catch(() => null) : null;
                        if (blob) await writeGeneratedBlob(`board:${id}`, "image", blob, "png", stored.storageKey).catch(() => false);
                        patchBoardStoryboard(id, shot.id, video.id, storyboard.id, { status: "success", content: stored.url, storageKey: stored.storageKey, mimeType: stored.mimeType, width: stored.width, height: stored.height, task: undefined, phase: undefined, phaseDetail: undefined });
                    })
                    .catch((error) => patchBoardStoryboard(id, shot.id, video.id, storyboard.id, { status: "error", error: error instanceof Error ? error.message : "故事板轮询失败", task: undefined, phase: undefined }))
                    .finally(() => activeStoryboardPolling.current.delete(storyboard.id));
            }
        })();
    }, [board?.id, config, id]);

    useEffect(() => {
        if (!board) return;
        void Promise.all(board.shots.flatMap((shot) => shot.videos.map(async (video) => {
            const content = video.storageKey ? await resolveMediaUrl(video.storageKey, video.content) : video.content;
            const references = await Promise.all(video.references.map(async (reference) => ({ ...reference, url: reference.storageKey ? (reference.kind === "image" ? await resolveImageUrl(reference.storageKey, reference.url) : await resolveMediaUrl(reference.storageKey, reference.url)) : reference.url })));
            const storyboards = await Promise.all(video.storyboards.map(async (storyboard) => storyboard.storageKey ? { ...storyboard, content: await resolveImageUrl(storyboard.storageKey, storyboard.content) } : storyboard));
            if (content !== video.content || references.some((reference, index) => reference.url !== video.references[index]?.url) || storyboards.some((storyboard, index) => storyboard.content !== video.storyboards[index]?.content)) patchVideo(shot.id, video.id, { content, references, storyboards });
        })));
    }, [board?.id]);

    const submitVideo = async (shotId: string, video: BoardVideo, prompt: string) => {
        const target = { ...video, prompt, status: "loading" as const, content: undefined, storageKey: undefined, task: undefined, error: undefined, progress: undefined };
        patchVideo(shotId, target.id, target);
        try {
            const requestConfig = videoConfig(config, target);
            const { images, videos, audios } = await resolveReferences(target.references);
            const task = await createVideoGenerationTask(requestConfig, prompt, images, videos, audios);
            patchVideo(shotId, target.id, { task });
            void poll(shotId, target.id, task, requestConfig);
        } catch (error) {
            const detail = error instanceof Error ? error.message : "视频任务提交失败";
            patchVideo(shotId, target.id, { status: "error", error: detail });
            message.error(detail);
        }
    };

    const generateCurrent = async (_nodeId: string, _mode: string, prompt: string) => {
        if (!selectedShot || !selectedVideo) return;
        await submitVideo(selectedShot.id, selectedVideo, prompt);
    };

    const generateCopy = async (_nodeId: string, _mode: string, prompt: string) => {
        if (!selectedShot || !selectedVideo) return;
        if (!selectedVideo.content) return submitVideo(selectedShot.id, selectedVideo, prompt);
        const copy = createBoardVideo({ ...selectedVideo, id: nanoid(), prompt, status: "loading", content: undefined, storageKey: undefined, task: undefined, error: undefined, progress: undefined, storyboards: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
        mutate((current) => ({ ...current, shots: current.shots.map((shot) => shot.id === selectedShot.id ? { ...shot, selectedVideoId: copy.id, videos: [...shot.videos, copy] } : shot) }));
        await submitVideo(selectedShot.id, copy, prompt);
    };

    const confirmDeleteVideo = (shotId: string, videoId: string) => Modal.confirm({
        title: "删除空视频记录？",
        content: "只会删除这条尚未生成成片的记录，此操作无法撤销。",
        okText: "删除",
        cancelText: "取消",
        okButtonProps: { danger: true },
        onOk: () => mutate((current) => ({
            ...current,
            shots: current.shots.map((shot) => {
                if (shot.id !== shotId || shot.videos.length <= 1) return shot;
                const target = shot.videos.find((video) => video.id === videoId);
                if (!target || target.content || target.status === "success" || target.status === "loading") return shot;
                const remaining = shot.videos.filter((video) => video.id !== videoId);
                const fallbackId = remaining[0].id;
                return { ...shot, videos: remaining, selectedVideoId: shot.selectedVideoId === videoId ? fallbackId : shot.selectedVideoId, defaultVideoId: shot.defaultVideoId === videoId ? fallbackId : shot.defaultVideoId };
            }),
        })),
    });

    const generateStoryboard = async (_nodeId: string, prompt: string) => {
        if (!currentShot || !currentVideo) return;
        if (!prompt.trim()) return message.warning("还未书写任何提示词");
        const storyboard = { id: nanoid(), index: Math.max(0, ...currentVideo.storyboards.map((item) => item.index)) + 1, status: "loading" as const, phase: "resolving" as const, phaseDetail: "正在读取提示词引用的资产" };
        activeStoryboardPolling.current.add(storyboard.id);
        patchVideo(currentShot.id, currentVideo.id, { storyboards: [...currentVideo.storyboards, storyboard] });
        const patchStoryboard = (patch: Partial<BoardStoryboard>) => {
            const latest = useBoardStore.getState().boards.find((item) => item.id === id)?.shots.find((item) => item.id === currentShot.id)?.videos.find((item) => item.id === currentVideo.id);
            if (latest) patchVideo(currentShot.id, currentVideo.id, { storyboards: latest.storyboards.map((item) => item.id === storyboard.id ? { ...item, ...patch } : item) });
        };
        try {
            const storyboardImageModel = resolveModelForCapability(config, config.storyboardImageModel || config.imageModel, "image");
            const storyboardImageLabel = modelOptionLabel(config, storyboardImageModel);
            const imageConfig = { ...buildGenerationConfig(config, undefined, "image"), model: storyboardImageModel, count: "1", quality: "1k", size: normalizeImageAspect(currentVideo.size || config.videoSize || "16:9") };
            const imageReferences = currentVideo.references.filter((reference) => reference.kind === "image");
            const labels = mentionedReferenceLabels(prompt, imageReferences.map((reference) => reference.label));
            const mentioned = imageReferences.filter((reference) => labels.has(reference.label));
            const references = await Promise.all(mentioned.map(async (reference): Promise<ReferenceImage> => ({ id: reference.id, name: reference.title, type: reference.mimeType, dataUrl: await resolveImageUrl(reference.storageKey, reference.url), storageKey: reference.storageKey })));
            const plan = await compileKinStoryboardPlan(config, prompt, references.map((reference, index) => ({ canvasLabel: mentioned[index].label, reference })), imageConfig.size, { onStage: (phase, detail) => patchStoryboard({ phase, phaseDetail: detail }) });
            const textOnlyComfyUi = resolveModelRequestConfig(config, storyboardImageModel).apiFormat === "comfyui";
            patchStoryboard({ phase: "submitting", phaseDetail: textOnlyComfyUi ? `正在向 ${storyboardImageLabel} 提交已编译 Prompt（当前工作流不上传参考图）` : `正在向 ${storyboardImageLabel} 提交 ${plan.references.length} 张压缩参考图` });
            const storyboardRequestOptions: ImageRequestOptions = { onRemoteTask: (task) => patchStoryboard({ task: { ...task, model: storyboardImageModel }, phase: "queued", phaseDetail: `${storyboardImageLabel} 已接单 · ${task.id.slice(-8)}` }), onTaskState: ({ stage, attempt }) => patchStoryboard({ phase: stage, phaseDetail: stage === "downloading" ? "故事板已生成，正在下载结果" : `${storyboardImageLabel} ${stage === "queued" ? "排队中" : "正在生成"}${attempt ? ` · 第 ${attempt} 次查询` : ""}` }) };
            const image = await (textOnlyComfyUi ? requestGeneration(imageConfig, plan.prompt, storyboardRequestOptions) : requestEdit(imageConfig, plan.prompt, plan.references, undefined, storyboardRequestOptions)).then((items) => items[0]);
            patchStoryboard({ phase: "saving", phaseDetail: "正在保存故事板" });
            const stored = await uploadImage(image.dataUrl);
            const blob = stored.storageKey ? await getImageBlob(stored.storageKey).catch(() => null) : null;
            if (blob) await writeGeneratedBlob(`board:${id}`, "image", blob, "png", stored.storageKey).catch(() => false);
            patchStoryboard({ status: "success", content: stored.url, storageKey: stored.storageKey, mimeType: stored.mimeType, width: stored.width, height: stored.height, task: undefined, phase: undefined, phaseDetail: undefined });
        } catch (error) {
            const detail = error instanceof Error ? error.message : "故事板生成失败";
            patchStoryboard({ status: "error", error: detail, task: undefined, phase: undefined, phaseDetail: detail });
            message.error(detail);
        } finally {
            activeStoryboardPolling.current.delete(storyboard.id);
        }
    };

    const prepareDroppedAsset = async (file: File) => {
        try {
            if (file.type.startsWith("image/")) {
                const stored = await uploadImage(file);
                setNewAssetDraft({ kind: "image", title: file.name.replace(/\.[^.]+$/, ""), assetType: "character", coverUrl: stored.url, tags: [], source: "看板拖入", data: { dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType } });
            } else if (file.type.startsWith("video/")) {
                const stored = await uploadMediaFile(file, "video");
                setNewAssetDraft({ kind: "video", title: file.name.replace(/\.[^.]+$/, ""), assetType: "other", coverUrl: "", tags: [], source: "看板拖入", data: { url: stored.url, storageKey: stored.storageKey, width: stored.width || 1280, height: stored.height || 720, bytes: stored.bytes, mimeType: stored.mimeType } });
            } else if (file.type.startsWith("audio/")) {
                const stored = await uploadMediaFile(file, "audio");
                setNewAssetDraft({ kind: "audio", title: file.name.replace(/\.[^.]+$/, ""), assetType: "other", coverUrl: "", tags: [], source: "看板拖入", data: { url: stored.url, storageKey: stored.storageKey, durationMs: stored.durationMs, bytes: stored.bytes, mimeType: stored.mimeType } });
            } else message.warning("仅支持图片、视频和音频文件");
        } catch { message.error("读取拖入文件失败"); }
    };

    const capturePreviewFrame = async () => {
        const video = previewVideoRef.current;
        if (!video || !video.videoWidth || !video.videoHeight) return message.warning("视频画面尚未准备好");
        const canvas = document.createElement("canvas");
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        canvas.getContext("2d")?.drawImage(video, 0, 0);
        const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
        if (!blob) return message.error("截取当前帧失败");
        const stored = await uploadImage(blob);
        await writeGeneratedBlob(`board:${id}`, "image", blob, "png", stored.storageKey).catch(() => false);
        useAssetStore.getState().addAsset({ kind: "image", title: `视频截帧-${new Date().toLocaleTimeString("zh-CN", { hour12: false }).replace(/:/g, "-")}`, assetType: "other", projectId: "", coverUrl: stored.url, tags: [], source: "看板视频截帧", data: { dataUrl: stored.url, storageKey: stored.storageKey, width: stored.width, height: stored.height, bytes: stored.bytes, mimeType: stored.mimeType }, metadata: { source: "board", boardId: id, videoId: previewVideo?.id, timeMs: Math.round(video.currentTime * 1000) } });
        message.success("当前帧已加入资产库");
    };

    if (!board) return <main className="grid h-full place-items-center bg-background"><Empty description="看板不存在或尚未完成加载" /></main>;
    const currentShot = selectedShot || board.shots[0];
    const currentVideo = selectedVideo || currentShot?.videos[0];
    const node = currentVideo ? boardVideoNode(currentVideo) : null;
    const mentionReferences = currentVideo ? currentVideo.references.map(toCanvasReference) : [];

    return (
        <main className="flex h-dvh min-h-0 flex-col overflow-hidden bg-background text-stone-950 dark:text-stone-100">
            <header className="flex h-16 shrink-0 items-center gap-3 border-b border-stone-200 px-4 dark:border-stone-800">
                <Button type="text" icon={<ArrowLeft className="size-5" />} onClick={() => navigate("/")} aria-label="返回主页" />
                {editingTitle ? <Input className="max-w-sm" value={title} autoFocus onChange={(event) => setTitle(event.target.value)} onBlur={() => { if (renameBoard(board.id, title)) setEditingTitle(false); }} onKeyDown={(event) => event.key === "Enter" && (renameBoard(board.id, title) ? setEditingTitle(false) : message.warning("看板名称不能为空或重名"))} /> : <button type="button" className="text-xl font-semibold" onDoubleClick={() => setEditingTitle(true)}>{board.title}</button>}
                <span className="text-xs text-stone-500">双击名称修改</span>
                <Tooltip title="本地目录">
                    <button type="button" onClick={() => setLocalFoldersOpen(true)} className="grid size-7 place-items-center rounded-full transition hover:bg-black/5 dark:hover:bg-white/10" aria-label="本地目录"><FolderOpen className="size-4" /></button>
                </Tooltip>
            </header>

            <div className="grid min-h-0 flex-1 grid-cols-[144px_minmax(0,1fr)_168px_184px] overflow-hidden">
                <aside className="flex min-h-0 flex-col border-r border-stone-200 p-3 dark:border-stone-800">
                    <div className="mb-3 flex items-center justify-between"><h2 className="font-semibold">分镜列表</h2><span className="text-xs text-stone-500">{board.shots.length} 个</span></div>
                    <div className="min-h-0 flex-1 space-y-2 overflow-y-auto">
                        {board.shots.map((shot, index) => <ShotCard key={shot.id} shot={shot} index={index} selected={shot.id === currentShot?.id} onSelect={() => selectShot(shot.id)} onRename={(title) => mutate((current) => ({ ...current, shots: current.shots.map((item) => item.id === shot.id ? { ...item, title } : item) }))} onMove={(source) => reorderShots(mutate, source, index)} />)}
                    </div>
                    <Button className="mt-3" icon={<Plus className="size-4" />} onClick={addShot}>新建分镜</Button>
                </aside>

                <section className="flex min-h-0 flex-col overflow-hidden border-r border-stone-200 p-4 dark:border-stone-800">
                    <h2 className="mb-3 text-lg font-semibold">视频创作台</h2>
                    <div className="min-h-0 flex-1">{node && currentShot && currentVideo ? <CanvasNodePromptPanel node={node} isRunning={currentVideo.status === "loading"} modeOverride="video" allowExpand={false} fillHeight mentionReferences={mentionReferences} storyboards={currentVideo.storyboards.map((item) => storyboardNode(currentVideo.id, item))} onPromptChange={(_, prompt) => patchVideo(currentShot.id, currentVideo.id, { prompt })} onConfigChange={(_, patch) => patchVideo(currentShot.id, currentVideo.id, { model: patch.model, size: patch.size, vquality: patch.vquality, seconds: isAutoVideoDuration(patch.seconds) ? inferVideoDurationFromPrompt(currentVideo.prompt || "", integerDurationRange(5, 15)) : Number(patch.seconds || currentVideo.seconds || 15), generateAudio: patch.generateAudio === "true", watermark: patch.watermark === "true" })} onGenerate={generateCurrent} onGenerateCopy={generateCopy} onStop={() => undefined} onDisconnectReference={(reference) => patchVideo(currentShot.id, currentVideo.id, { references: currentVideo.references.filter((item) => item.id !== reference.id) })} onGenerateStoryboard={generateStoryboard} onPreviewStoryboard={(storyboardId) => setPreviewStoryboard(currentVideo.storyboards.find((item) => item.id === storyboardId)?.content || null)} onDeleteStoryboard={(storyboardId) => Modal.confirm({ title: "删除故事板？", content: "删除后将从当前视频记录中移除。", okText: "删除", cancelText: "取消", okButtonProps: { danger: true }, onOk: () => patchVideo(currentShot.id, currentVideo.id, { storyboards: currentVideo.storyboards.filter((item) => item.id !== storyboardId) }) })} /> : <Empty description="请先新建分镜" />}</div>
                </section>

                <BoardAssetShelf assets={assets} onOpen={setDetailAssetId} onAdd={(asset) => currentShot && currentVideo && patchVideo(currentShot.id, currentVideo.id, { references: addAssetReference(currentVideo.references, asset) })} onDropFile={prepareDroppedAsset} />

                <aside className="min-h-0 overflow-y-auto p-4">
                    <h2 className="mb-3 text-lg font-semibold">视频生成记录</h2>
                    {currentShot?.videos.length ? <div className="space-y-3">{currentShot.videos.map((video) => <VideoCard key={video.id} video={video} selected={video.id === currentVideo?.id} isDefault={video.id === currentShot.defaultVideoId} onSelect={() => selectVideo(currentShot.id, video.id)} onPreview={() => setPreviewVideo(video)} onDefault={() => mutate((current) => ({ ...current, shots: current.shots.map((shot) => shot.id === currentShot.id ? { ...shot, defaultVideoId: video.id } : shot) }))} onDelete={!video.content && video.status !== "success" && video.status !== "loading" && currentShot.videos.length > 1 ? () => confirmDeleteVideo(currentShot.id, video.id) : undefined} />)}</div> : <Empty description="还没有视频记录" />}
                </aside>
            </div>

            <Modal open={Boolean(previewVideo)} title="视频预览" footer={previewVideo?.content ? <div className="flex justify-end gap-2"><Button icon={<Download className="size-4" />} onClick={() => saveAs(previewVideo.content!, `${previewVideo.id}.mp4`)}>下载</Button><Button icon={<Camera className="size-4" />} onClick={() => void capturePreviewFrame()}>截取当前帧到资产库</Button></div> : null} width="min(1100px, 92vw)" onCancel={() => setPreviewVideo(null)}>{previewVideo?.content ? <video ref={previewVideoRef} src={previewVideo.content} controls autoPlay className="max-h-[72vh] w-full bg-black object-contain" /> : <Empty description={previewVideo?.error || "视频尚未生成完成"} />}</Modal>
            <Modal open={Boolean(previewStoryboard)} title="故事板预览" footer={null} width="min(1200px, 94vw)" onCancel={() => setPreviewStoryboard(null)}>{previewStoryboard ? <img src={previewStoryboard} className="max-h-[80vh] w-full object-contain" /> : null}</Modal>
            <AssetDetailModal open={Boolean(detailAssetId)} assetId={detailAssetId} onClose={() => setDetailAssetId(null)} onInsert={(asset) => { if (currentShot && currentVideo) patchVideo(currentShot.id, currentVideo.id, { references: addAssetReference(currentVideo.references, asset) }); setDetailAssetId(null); }} />
            <AssetDetailModal open={Boolean(newAssetDraft)} draft={newAssetDraft} onClose={() => setNewAssetDraft(null)} />
            <CanvasLocalFoldersModal open={localFoldersOpen} variant="board" storageProjectId={`board:${board.id}`} project={board} backupMedia={() => backupGeneratedBoardMedia(`board:${board.id}`, useBoardStore.getState().boards.find((item) => item.id === board.id) || board)} onClose={() => setLocalFoldersOpen(false)} onLabelsChange={(labels: CanvasFolderLabels) => mutate((current) => ({ ...current, localFolderLabels: labels }))} />
        </main>
    );
}

function reorderShots(mutate: (updater: (board: BoardProject) => BoardProject) => void, from: number, to: number) {
    if (from === to || to < 0) return;
    mutate((board) => { const shots = [...board.shots]; const [shot] = shots.splice(from, 1); shots.splice(Math.min(to, shots.length), 0, shot); return { ...board, shots }; });
}

function ShotCard({ shot, index, selected, onSelect, onRename, onMove }: { shot: BoardShot; index: number; selected: boolean; onSelect: () => void; onRename: (title: string) => void; onMove: (index: number) => void }) {
    const [editing, setEditing] = useState(false);
    const [title, setTitle] = useState(shot.title);
    const video = shot.videos.find((item) => item.id === shot.defaultVideoId) || shot.videos[0];
    const busy = shot.videos.some((item) => item.status === "loading" || item.storyboards.some((storyboard) => storyboard.status === "loading"));
    const lastViewedAt = Date.parse(shot.lastViewedAt || shot.createdAt);
    const unread = !selected && shot.videos.some((item) => (item.status === "success" || item.storyboards.some((storyboard) => storyboard.status === "success")) && Date.parse(item.updatedAt) > lastViewedAt);
    return <div draggable onDragStart={(event) => event.dataTransfer.setData("text/shot-index", String(index))} onDragOver={(event) => event.preventDefault()} onDrop={(event) => onMove(Number(event.dataTransfer.getData("text/shot-index")))} onClick={onSelect} className={`group relative aspect-square w-full cursor-pointer overflow-hidden rounded-xl border transition ${selected ? "border-blue-500 ring-1 ring-blue-500" : "border-stone-200 hover:border-stone-400 dark:border-stone-800 dark:hover:border-stone-600"}`}>
        <div className="absolute inset-0 grid place-items-center bg-black/10 dark:bg-white/5">{video?.content ? <video src={video.content} muted preload="metadata" className="size-full object-cover" /> : <VideoIcon className="size-9 opacity-35" />}</div>
        <div className="absolute left-2 top-2 flex items-center gap-0.5 rounded bg-black/60 px-1.5 py-1 text-xs text-white"><GripVertical className="size-3.5" />{index + 1}</div>
        {busy ? <LoaderCircle className="absolute right-2 top-2 size-5 animate-spin text-amber-400 drop-shadow" /> : null}
        {unread ? <span className="absolute bottom-11 right-2 size-2.5 rounded-full bg-red-500 ring-2 ring-white dark:ring-stone-950" /> : null}
        <div className="absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent px-3 pb-2 pt-10 text-white">{editing ? <Input size="small" value={title} autoFocus onClick={(event) => event.stopPropagation()} onChange={(event) => setTitle(event.target.value)} onBlur={() => { onRename(title.trim() || shot.title); setEditing(false); }} /> : <div className="flex min-w-0 items-center gap-1"><span className="truncate text-sm">{shot.title}</span><button type="button" className="shrink-0 rounded p-1 opacity-70 transition hover:bg-white/15 hover:opacity-100" onClick={(event) => { event.stopPropagation(); setEditing(true); }}><Pencil className="size-3.5" /></button></div>}</div>
    </div>;
}

function VideoCard({ video, selected, isDefault, onSelect, onPreview, onDefault, onDelete }: { video: BoardVideo; selected: boolean; isDefault: boolean; onSelect: () => void; onPreview: () => void; onDefault: () => void; onDelete?: () => void }) {
    return <div onClick={onSelect} className={`group relative aspect-square cursor-pointer overflow-hidden rounded-xl border-2 ${selected ? "border-blue-500" : "border-transparent"} bg-black/10 dark:bg-white/5`}>
        {video.content ? <video src={video.content} muted preload="metadata" className="size-full object-cover" /> : video.status === "loading" ? <div className="flex size-full flex-col items-center justify-center gap-3 px-3 text-center"><div className="size-9 animate-spin rounded-full border-2 border-stone-600 border-t-blue-500" /><div className="space-y-1"><div className="text-xs leading-5">{video.task ? "飞喵正在生成视频" : "正在准备飞喵视频请求"}{typeof video.progress === "number" ? ` · ${Math.round(video.progress)}%` : ""}</div><div className="line-clamp-2 text-[10px] leading-4 opacity-50">{video.task ? `任务 ${video.task.id.slice(-8)}` : "正在整理提示词和参考资产"}</div></div></div> : <div className="grid size-full place-items-center text-xs opacity-60">{video.status === "error" ? "生成失败" : "空视频"}</div>}
        {video.content ? <button type="button" onClick={(event) => { event.stopPropagation(); onPreview(); }} className="absolute left-1/2 top-1/2 z-10 grid size-11 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full bg-black/60 text-white opacity-0 transition group-hover:opacity-100"><Play className="size-5 fill-current" /></button> : null}
        <button type="button" onClick={(event) => { event.stopPropagation(); onDefault(); }} className="absolute bottom-1 left-1 z-10"><Star className={`size-5 ${isDefault ? "fill-amber-400 text-amber-400" : "text-white/70"}`} /></button>
        <div className="absolute right-1 top-1 z-10 flex gap-1 opacity-0 group-hover:opacity-100">{video.content ? <Tooltip title="下载"><button type="button" className="rounded bg-black/60 p-1 text-white" onClick={(event) => { event.stopPropagation(); saveAs(video.content!, `${video.id}.mp4`); }}><Download className="size-4" /></button></Tooltip> : null}{onDelete ? <Tooltip title="删除空记录"><button type="button" className="rounded bg-black/60 p-1 text-white" onClick={(event) => { event.stopPropagation(); onDelete(); }}><Trash2 className="size-4" /></button></Tooltip> : null}</div>
    </div>;
}

function AssetShelfCard({ asset, onOpen, onAdd }: { asset: Asset; onOpen: () => void; onAdd: () => void }) {
    const url = asset.kind === "image" ? asset.data.dataUrl || asset.coverUrl : asset.kind === "video" ? asset.data.url : "";
    return <div className="group relative aspect-square w-full overflow-hidden rounded-xl border border-stone-200 dark:border-stone-800"><button type="button" className="absolute inset-0 z-10" onClick={onOpen} />{asset.kind === "image" ? <img src={url} className="size-full object-cover" /> : asset.kind === "video" ? <video src={url} muted preload="auto" playsInline className="size-full object-cover" /> : asset.kind === "audio" ? <div className="grid size-full place-items-center"><Music2 className="size-9 opacity-45" /></div> : <div className="grid size-full place-items-center p-4 text-center text-sm">{asset.title}</div>}<button type="button" className="absolute left-2 top-2 z-20 grid size-9 place-items-center rounded-full bg-black/65 text-white opacity-0 transition group-hover:opacity-100" onClick={onAdd}><Plus className="size-5" /></button><div className="absolute inset-x-0 bottom-0 truncate bg-gradient-to-t from-black/80 px-3 pb-2 pt-8 text-sm text-white">{asset.title}</div></div>;
}

function BoardAssetShelf({ assets, onOpen, onAdd, onDropFile }: { assets: Asset[]; onOpen: (id: string) => void; onAdd: (asset: Asset) => void; onDropFile: (file: File) => void }) {
    const projects = useAssetStore((state) => state.projects);
    const setLastProjectId = useAssetStore((state) => state.setLastProjectId);
    const [kind, setKind] = useState<AssetKind | "all">("all");
    const [type, setType] = useState<AssetType | "all">("all");
    const [project, setProject] = useState("all");
    const filtered = assets.filter((asset) => (kind === "all" || asset.kind === kind) && (type === "all" || (asset.assetType || "other") === type) && (project === "all" || (project === "none" ? !asset.projectId : asset.projectId === project)));
    return <aside className="flex min-h-0 flex-col overflow-hidden border-r border-stone-200 p-3 dark:border-stone-800" onDragOver={(event) => event.preventDefault()} onDrop={(event) => { event.preventDefault(); const file = event.dataTransfer.files[0]; if (file) onDropFile(file); }}>
        <div className="mb-3 text-center"><h2 className="text-lg font-semibold">我的资产</h2><div className="mt-1 text-xs text-stone-500">拖入文件可新建资产</div></div>
        <div className="mb-3 space-y-2"><Select size="small" className="w-full" value={kind} onChange={setKind} options={[{ value: "all", label: "全部媒体" }, { value: "image", label: "图片" }, { value: "audio", label: "音频" }, { value: "video", label: "视频" }, { value: "text", label: "其他" }]} /><Select size="small" className="w-full" value={type} onChange={setType} options={[{ value: "all", label: "全部类型" }, { value: "character", label: "角色" }, { value: "scene", label: "场景" }, { value: "prop", label: "道具" }, { value: "other", label: "其他" }]} /><Select size="small" className="w-full" value={project} onChange={(value) => { setProject(value); if (value !== "all" && value !== "none") setLastProjectId(value); }} options={[{ value: "all", label: "全部项目" }, { value: "none", label: "无" }, ...projects.map((value) => ({ value, label: value }))]} /></div>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto pr-1">{filtered.map((asset) => <AssetShelfCard key={asset.id} asset={asset} onOpen={() => onOpen(asset.id)} onAdd={() => onAdd(asset)} />)}</div>
    </aside>;
}

function boardVideoNode(video: BoardVideo): CanvasNodeData {
    return { id: video.id, type: CanvasNodeType.Video, title: "视频", position: { x: 0, y: 0 }, width: 480, height: 270, metadata: { content: video.content, prompt: video.prompt, composerContent: video.prompt, status: video.status, model: video.model, size: video.size, vquality: video.vquality, seconds: String(video.seconds || ""), generateAudio: String(video.generateAudio ?? true), watermark: String(video.watermark ?? false), storageKey: video.storageKey, naturalWidth: video.width, naturalHeight: video.height, bytes: video.bytes, mimeType: video.mimeType, durationMs: video.durationMs } };
}

function storyboardNode(videoId: string, storyboard: BoardVideo["storyboards"][number]): CanvasNodeData {
    return { id: storyboard.id, type: CanvasNodeType.Image, title: `故事板${storyboard.index}`, position: { x: 0, y: 0 }, width: storyboard.width || 480, height: storyboard.height || 270, metadata: { hidden: true, storyboardSourceNodeId: videoId, storyboardIndex: storyboard.index, content: storyboard.content, storageKey: storyboard.storageKey, mimeType: storyboard.mimeType, naturalWidth: storyboard.width, naturalHeight: storyboard.height, status: storyboard.status, errorDetails: storyboard.error, generationPhase: storyboard.phase, generationDetail: storyboard.phaseDetail } };
}

function patchBoardStoryboard(boardId: string, shotId: string, videoId: string, storyboardId: string, patch: Partial<BoardStoryboard>) {
    const updatedAt = new Date().toISOString();
    useBoardStore.getState().updateBoard(boardId, (board) => ({ ...board, shots: board.shots.map((shot) => shot.id === shotId ? { ...shot, updatedAt, videos: shot.videos.map((video) => video.id === videoId ? { ...video, updatedAt, storyboards: video.storyboards.map((storyboard) => storyboard.id === storyboardId ? { ...storyboard, ...patch } : storyboard) } : video) } : shot) }));
}

function toCanvasReference(reference: BoardReference): CanvasResourceReference {
    return { id: reference.id, nodeId: reference.id, connectionId: reference.id, kind: reference.kind, label: reference.label, title: reference.title, previewUrl: reference.url, active: true };
}

function addAssetReference(current: BoardReference[], asset: Asset) {
    if (asset.kind === "text" || current.some((reference) => reference.assetId === asset.id)) return current;
    const kind: "image" | "video" | "audio" = asset.kind;
    let index = 0;
    let label = kind === "image" ? imageReferenceLabel(index) : seedanceReferenceLabel(kind, index);
    while (current.some((reference) => reference.label === label)) label = kind === "image" ? imageReferenceLabel(++index) : seedanceReferenceLabel(kind, ++index);
    if (asset.kind === "image") return [...current, { id: nanoid(), assetId: asset.id, kind, label, title: asset.title, url: asset.data.dataUrl, storageKey: asset.data.storageKey, mimeType: asset.data.mimeType, width: asset.data.width, height: asset.data.height, bytes: asset.data.bytes }];
    if (asset.kind === "video") return [...current, { id: nanoid(), assetId: asset.id, kind, label, title: asset.title, url: asset.data.url, storageKey: asset.data.storageKey, mimeType: asset.data.mimeType, width: asset.data.width, height: asset.data.height, bytes: asset.data.bytes }];
    return [...current, { id: nanoid(), assetId: asset.id, kind, label, title: asset.title, url: asset.data.url, storageKey: asset.data.storageKey, mimeType: asset.data.mimeType, bytes: asset.data.bytes, durationMs: asset.data.durationMs }];
}

async function resolveReferences(references: BoardReference[]) {
    const images: ReferenceImage[] = [];
    const videos: ReferenceVideo[] = [];
    const audios: ReferenceAudio[] = [];
    for (const reference of references) {
        if (reference.kind === "image") images.push({ id: reference.id, name: reference.title, type: reference.mimeType, dataUrl: await resolveImageUrl(reference.storageKey, reference.url), storageKey: reference.storageKey });
        else if (reference.kind === "video") videos.push({ id: reference.id, name: reference.title, type: reference.mimeType, url: await resolveMediaUrl(reference.storageKey, reference.url), storageKey: reference.storageKey, width: reference.width, height: reference.height, bytes: reference.bytes, durationMs: reference.durationMs });
        else audios.push({ id: reference.id, name: reference.title, type: reference.mimeType, url: await resolveMediaUrl(reference.storageKey, reference.url), storageKey: reference.storageKey, durationMs: reference.durationMs });
    }
    return { images, videos, audios };
}

function videoConfig(config: AiConfig, video: BoardVideo): AiConfig {
    const model = video.model || resolveModelForCapability(config, config.videoModel, "video");
    return { ...config, model, videoModel: model, size: video.size || config.videoSize || config.size || defaultConfig.size, vquality: video.vquality || config.vquality, videoSeconds: String(video.seconds || config.videoSeconds || 15), videoGenerateAudio: String(video.generateAudio ?? config.videoGenerateAudio ?? true), videoWatermark: String(video.watermark ?? config.videoWatermark ?? false) };
}

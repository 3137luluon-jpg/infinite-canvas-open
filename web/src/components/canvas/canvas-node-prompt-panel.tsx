import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, ArrowUp, FileText, Image as ImageIcon, LoaderCircle, Maximize2, Minimize2, Music2, Settings, Square, Video, X } from "lucide-react";
import { Button, InputNumber, Modal, Popover, Tooltip } from "antd";
import { useTranslation } from "react-i18next";

import { ModelPicker } from "@/components/model-picker";
import { defaultConfig, hasConfigForCapability, isAiConfigReady, resolveModelForCapability, resolveModelRequestConfig, resolveModelScript, useConfigStore, useEffectiveConfig, type AiConfig, type ModelCapability } from "@/stores/use-config-store";
import { isRunningHubWorkflowConfig, parseRhMapping } from "@/lib/runninghub-workflow";
import { getZealmanWorkflowUsage, isZealmanWorkflowModel, type ZealmanWorkflowUsage } from "@/services/api/zealman-comfyui";
import { canvasThemes } from "@/lib/canvas-theme";
import { hasCanvasReferenceMention, stripCanvasReferenceFromPrompt } from "@/lib/canvas/canvas-mention-style";
import { isCinePackVideoShotNode, preferredCinePackVideoPrompt } from "@/lib/canvas/cinepack-video-prompt";
import { resolveImageUrl } from "@/services/image-storage";
import { useThemeStore } from "@/stores/use-theme-store";
import { CanvasImageSettingsPopover } from "./canvas-image-settings-popover";
import { CanvasAudioSettingsPopover, type CanvasAudioSettingKey } from "./canvas-audio-settings-popover";
import { CanvasPromptChipInput, type CanvasPromptChipInputHandle } from "./canvas-prompt-chip-input";
import { CanvasVideoSettingsPopover } from "./canvas-video-settings-popover";
import { CanvasVideoPrice } from "./canvas-video-price";
import { CanvasTextSettingsPopover } from "./canvas-text-settings-popover";
import { CanvasNodeType, type CanvasGenerationMode, type CanvasGenerationPhase, type CanvasNodeData, type CanvasNodeMetadata } from "@/types/canvas";
import type { CanvasResourceReference } from "@/lib/canvas/canvas-resource-references";
import { cn } from "@/lib/utils";

export type CanvasNodeGenerationMode = CanvasGenerationMode;

type CanvasNodePromptPanelProps = {
    node: CanvasNodeData;
    isRunning: boolean;
    onPromptChange: (nodeId: string, prompt: string) => void;
    onConfigChange: (nodeId: string, patch: Partial<CanvasNodeMetadata>) => void;
    onGenerate: (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => void;
    onGenerateCopy?: (nodeId: string, mode: CanvasNodeGenerationMode, prompt: string) => void;
    onStop: (nodeId: string) => void;
    mentionReferences?: CanvasResourceReference[];
    onDisconnectReference?: (reference: CanvasResourceReference) => void;
    onFocusReference?: (sourceNodeId: string, referenceNodeId: string) => void;
    onReorderReferences?: (nodeId: string, ids: string[]) => void;
    onImageSettingsOpenChange?: (open: boolean) => void;
    modeOverride?: CanvasNodeGenerationMode; // Plugin nodes set their generation type through useBuiltinPanel.mode.
    storyboards?: CanvasNodeData[];
    onGenerateStoryboard?: (nodeId: string, prompt: string) => void;
    onPreviewStoryboard?: (nodeId: string) => void;
    onDeleteStoryboard?: (nodeId: string) => void;
    allowExpand?: boolean;
    fillHeight?: boolean;
};

export function CanvasNodePromptPanel({ node, isRunning, onPromptChange, onConfigChange, onGenerate, onGenerateCopy, onStop, mentionReferences = [], onDisconnectReference, onFocusReference, onReorderReferences, onImageSettingsOpenChange, modeOverride, storyboards = [], onGenerateStoryboard, onPreviewStoryboard, onDeleteStoryboard, allowExpand = true, fillHeight = false }: CanvasNodePromptPanelProps) {
    const { t } = useTranslation();
    const globalConfig = useEffectiveConfig();
    const openConfigDialog = useConfigStore((state) => state.openConfigDialog);
    const updateGlobalConfig = useConfigStore((state) => state.updateConfig);
    const theme = canvasThemes[useThemeStore((state) => state.theme)];
    const mode = modeOverride ?? defaultMode(node.type);
    const config = buildNodeConfig(globalConfig, node, mode);
    const rhWorkflow = isRunningHubWorkflowConfig(resolveModelRequestConfig(config, config.model));
    const rhMapping = useMemo(() => {
        if (!rhWorkflow) return null;
        try { return parseRhMapping(resolveModelScript(config, config.model)); } catch { return null; }
    }, [rhWorkflow, config.model, config.channels]);
    const rhSettings = <Popover trigger="click" content={<div className="max-w-72 space-y-2 text-xs">
        <p>比例与画质沿用 RunningHub 工作流设置。</p>
        {rhMapping?.bindings.some(b => b.source === "seconds") ? <label>时长（秒） <InputNumber aria-label="RunningHub 工作流时长" min={1} value={Number(config.videoSeconds) || undefined} onChange={value => onConfigChange(node.id, videoConfigPatch("videoSeconds", String(value || "")))} /></label> : <p>时长沿用云端设置。</p>}
        {mode === "image" && rhMapping?.bindings.some(b => b.source === "count") ? <label>出图数量 <InputNumber aria-label="RunningHub 工作流数量" min={1} max={15} value={Number(config.count) || 1} onChange={value => onConfigChange(node.id, imageConfigPatch("count", String(value || 1)))} /></label> : null}
    </div>}><Button type="text" size="small">云端规格{rhMapping?.bindings.some(b => b.source === "seconds") ? ` · ${config.videoSeconds}秒` : ""}</Button></Popover>;
    const capability: ModelCapability = mode === "image" ? "image" : mode === "video" ? "video" : mode === "audio" ? "audio" : "text";
    const hasGenerationConfig = hasConfigForCapability(config, capability);
    const hasTextContent = node.type === CanvasNodeType.Text && Boolean(node.metadata?.content?.trim());
    const hasImageContent = node.type === CanvasNodeType.Image && Boolean(node.metadata?.content);
    const hasVideoContent = node.type === CanvasNodeType.Video && Boolean(node.metadata?.content);
    const hasAudioContent = node.type === CanvasNodeType.Audio && Boolean(node.metadata?.content);
    const hasExistingAsset = hasImageContent || hasVideoContent || hasAudioContent;
    const regenerateInPlace = Boolean(node.metadata?.regenerateInPlace);
    const isEditingExistingContent = hasTextContent || hasImageContent;
    const [prompt, setPrompt] = useState(() => preferredCinePackVideoPrompt(node));
    const [expanded, setExpanded] = useState(false);
    const [showConfirmModal, setShowConfirmModal] = useState(false);
    const [comfyUsage, setComfyUsage] = useState<ZealmanWorkflowUsage | null>(null);
    const [comfyUsageError, setComfyUsageError] = useState("");
    const compactInputRef = useRef<CanvasPromptChipInputHandle>(null);
    const expandedInputRef = useRef<CanvasPromptChipInputHandle>(null);
    const [referencePreviewUrls, setReferencePreviewUrls] = useState<Record<string, string>>({});
    const referencePreviewSignature = mentionReferences.map((reference) => `${reference.id}:${reference.storageKey || reference.previewUrl || ""}`).join("|");

    useEffect(() => {
        let current = true;
        void Promise.all(mentionReferences.map(async (reference) => [reference.id, reference.kind === "image" ? await resolveImageUrl(reference.storageKey, reference.previewUrl) : reference.previewUrl || ""] as const)).then((entries) => {
            if (current) setReferencePreviewUrls(Object.fromEntries(entries));
        });
        return () => {
            current = false;
        };
    }, [referencePreviewSignature]);
    const resolvedMentionReferences = useMemo(() => mentionReferences.map((reference) => ({ ...reference, previewUrl: referencePreviewUrls[reference.id] || reference.previewUrl })), [mentionReferences, referencePreviewUrls]);

    // Restore prompts only when switching nodes; preserve the current input after generation on the same node.
    useEffect(() => {
        const preferred = preferredCinePackVideoPrompt(node);
        setPrompt(preferred);
        if (isCinePackVideoShotNode(node) && (node.metadata?.prompt !== preferred || node.metadata?.composerContent !== preferred)) {
            onConfigChange(node.id, { prompt: preferred, composerContent: preferred });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [node.id]);

    const updatePrompt = (value: string) => {
        setPrompt(value);
        // Video nodes can carry a saved composer value from an import or a copy.
        if (node.type === CanvasNodeType.Video) onConfigChange(node.id, { prompt: value, composerContent: value });
        else if (isEditingExistingContent) onConfigChange(node.id, { composerContent: value });
        else onPromptChange(node.id, value);
    };

    const openExpandedEditor = () => {
        setExpanded(true);
    };

    const activeAssets = useMemo(() => resolvedMentionReferences.filter((item) => item.active), [resolvedMentionReferences]);
    const mentionedLabels = useMemo(
        () => new Set(activeAssets.filter((item) => hasCanvasReferenceMention(prompt, item)).map((item) => item.label)),
        [prompt, activeAssets],
    );
    const showAssetBar = (mode === "image" || mode === "video") && activeAssets.length > 0;
    const connectedAssetCounts = useMemo(
        () => ({
            image: activeAssets.filter((item) => item.kind === "image").length,
            video: activeAssets.filter((item) => item.kind === "video").length,
            audio: activeAssets.filter((item) => item.kind === "audio").length,
        }),
        [activeAssets],
    );
    const hasRequiredMedia = (["image", "video", "audio"] as const).every((kind) => {
        const required = comfyUsage?.referenceSlots.filter((slot) => slot.kind === kind && slot.required).length || 0;
        return connectedAssetCounts[kind] >= required || (kind === "image" && mode === "image" && hasImageContent);
    });
    const canSubmitWithoutPrompt = Boolean((mode === "image" || mode === "video") && comfyUsage && !comfyUsage.acceptsPrompt && hasRequiredMedia);
    const canSubmit = Boolean(prompt.trim()) || canSubmitWithoutPrompt;
    const promptPlaceholder = canSubmitWithoutPrompt
        ? comfyUsage?.preservesSource ? "连接素材后直接超分，无需提示词" : "此工作流使用云端预设提示词，可直接生成"
        : t(`canvas.promptPanel.${mode === "image" && hasImageContent ? "editImage" : mode === "text" && hasTextContent ? "editText" : mode}`);

    const submit = () => {
        const text = prompt.trim();
        if (isRunning || !canSubmit) return;
        if (hasExistingAsset && !regenerateInPlace) {
            setShowConfirmModal(true);
            return;
        }
        onGenerate(node.id, mode, text);
    };

    const confirmGenerate = () => {
        setShowConfirmModal(false);
        const text = prompt.trim();
        if (!canSubmit) return;
        if (onGenerateCopy && hasExistingAsset) {
            onGenerateCopy(node.id, mode, text);
        } else {
            onGenerate(node.id, mode, text);
        }
    };
    useEffect(() => {
        setComfyUsage(null);
        setComfyUsageError("");
        if ((mode !== "image" && mode !== "video")) return;
        const requestConfig = resolveModelRequestConfig(config, config.model);
        if (isRunningHubWorkflowConfig(requestConfig)) {
            try {
                const mapping = parseRhMapping(resolveModelScript(config, config.model));
                const slots = [...new Set(mapping.bindings.map(b => b.source).filter(source => /^(image|video|audio):/.test(source)))].map(source => {
                    const [kind, number] = source.split(":");
                    return { key: source, nodeId: mapping.bindings.find(b => b.source === source)!.nodeId, kind: kind as "image" | "video" | "audio", required: true, label: `参考${kind === "image" ? "图" : kind === "video" ? "视频" : "音频"}${number}` };
                });
                setComfyUsage({ workflowId: mapping.workflowId, referenceSlots: slots, acceptsPrompt: mapping.bindings.some(b => b.source === "prompt"), guide: `RunningHub：${slots.map(s => s.label).join("、") || "无需参考素材"}。${mapping.bindings.some(b => b.source === "prompt") ? "提示词传入映射节点" : "使用云端预设提示词"}；回填 #${mapping.outputNodeId}。比例、画质及未映射时长沿用云端设置。` });
            } catch (error) { setComfyUsageError(error instanceof Error ? error.message : "请先配置工作流映射"); }
            return;
        }
        if (requestConfig.apiFormat !== "comfyui" || !isZealmanWorkflowModel(requestConfig.model, requestConfig)) return;
        const controller = new AbortController();
        let disposed = false;
        const timeout = window.setTimeout(() => controller.abort(), 8_000);
        void getZealmanWorkflowUsage(requestConfig, requestConfig.model, controller.signal)
            .then(setComfyUsage)
            .catch((error) => {
                if (disposed) return;
                if (controller.signal.aborted) setComfyUsageError("云端实例未启动或暂不可用；不会影响本地画布和其他模型。");
                else setComfyUsageError(error instanceof Error ? error.message : "暂时无法读取云端工作流说明");
            })
            .finally(() => window.clearTimeout(timeout));
        return () => {
            disposed = true;
            window.clearTimeout(timeout);
            controller.abort();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [mode, config.model, config.channels]);
    const promptCharCount = useMemo(() => [...prompt].length, [prompt]);
    const renderPromptCount = (className = "") =>
        mode === "video" ? (
            <span className={`shrink-0 text-xs tabular-nums opacity-55 ${className}`} title={t("canvas.promptPanel.charCountHint")}>
                {t("canvas.promptPanel.charCount", { count: promptCharCount })}
            </span>
        ) : null;

    const insertAssetReference = (target: "compact" | "expanded") => (reference: CanvasResourceReference) => {
        (target === "expanded" ? expandedInputRef : compactInputRef).current?.insertReference(reference);
    };

    const disconnectAsset = (reference: CanvasResourceReference) => {
        const next = stripCanvasReferenceFromPrompt(prompt, reference);
        if (next !== prompt) updatePrompt(next);
        onDisconnectReference?.(reference);
    };

    return (
        <div
            data-canvas-no-zoom
            className={cn("rounded-2xl border p-3 shadow-2xl backdrop-blur", fillHeight && "flex h-full min-h-0 flex-col overflow-hidden")}
            style={{ background: theme.toolbar.panel, borderColor: theme.toolbar.border, color: theme.node.text }}
            onMouseDown={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onWheel={(event) => event.stopPropagation()}
        >
            {showAssetBar ? (
                <div className={cn("mb-2", fillHeight && "max-h-28 shrink-0 overflow-y-auto") }>
                    <ConnectedAssetBar
                        assets={activeAssets}
                        mentionedLabels={mentionedLabels}
                        theme={theme}
                        ariaLabel={t("canvas.promptPanel.connectedAssets")}
                        onInsert={insertAssetReference("compact")}
                        onFocus={onFocusReference ? (reference) => onFocusReference(node.id, reference.nodeId) : undefined}
                        onDisconnect={disconnectAsset}
                        onReorder={!isRunning && onReorderReferences ? (ids) => onReorderReferences(node.id, ids) : undefined}
                    />
                </div>
            ) : null}
            {(comfyUsage || comfyUsageError) ? (
                <div className="mb-2 rounded-lg border px-2.5 py-2 text-xs leading-5" style={{ borderColor: theme.toolbar.border, color: theme.node.text }}>
                    {comfyUsage ? (
                        <>
                            <div><span className="font-medium">云端工作流用法：</span>{comfyUsage.guide}</div>
                            {comfyUsage.referenceSlots.length ? (
                                <div className="mt-0.5 opacity-65">
                                    当前已连接：图片 {connectedAssetCounts.image}、视频 {connectedAssetCounts.video}、音频 {connectedAssetCounts.audio}；生成时会自动上传并逐槽填入。
                                </div>
                            ) : null}
                        </>
                    ) : <span className="opacity-65">{comfyUsageError}</span>}
                </div>
            ) : null}
            <CanvasPromptChipInput
                ref={compactInputRef}
                value={prompt}
                references={resolvedMentionReferences}
                onChange={updatePrompt}
                onSubmit={submit}
                containerClassName={fillHeight ? "min-h-0 flex-1" : undefined}
                className={cn("thin-scrollbar w-full cursor-text resize-none rounded-xl px-3 py-2 text-sm leading-5 outline-none", fillHeight ? "h-full min-h-0" : "h-40")}
                style={{ background: "transparent", color: theme.node.text }}
                placeholder={!canSubmitWithoutPrompt && mode === "image" && activeAssets.some((asset) => asset.kind === "image") ? "结合参考图，描述要生成的图片内容" : promptPlaceholder}
                stableNodeMentions={isCinePackVideoShotNode(node)}
            />

            <div className={cn("mt-2 flex min-w-0 shrink-0 items-center justify-between gap-2", mode === "video" && "flex-wrap")}>
                <div className={cn("flex min-w-0 items-center gap-2", mode === "video" && "min-w-[220px] flex-1")}>
                    {allowExpand ? <Tooltip title={t("canvas.promptPanel.expandEditor")}>
                        <Button type="text" className="!h-8 !w-8 !min-w-8 shrink-0 !rounded-full !bg-transparent !p-0" style={{ color: theme.node.text }} icon={<Maximize2 className="size-3.5" />} onClick={openExpandedEditor} aria-label={t("canvas.promptPanel.expandEditor")} />
                    </Tooltip> : null}
                    {hasGenerationConfig ? (
                        <>
                            {mode === "image" ? (
                                <>
                                    <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="image" onMissingConfig={() => openConfigDialog(false)} className="max-w-[190px]" />
                                    {rhWorkflow ? rhSettings : comfyUsage?.preservesSource ? <span className="text-xs opacity-65" title={comfyUsage.guide}>原比例 · 云端超分</span> : <CanvasImageSettingsPopover
                                        config={config}
                                        placement="topLeft"
                                        buttonClassName="!h-10 !max-w-[170px] !justify-start !rounded-full !px-3"
                                        onConfigChange={(key, value) => onConfigChange(node.id, imageConfigPatch(key, value))}
                                        onMissingConfig={() => openConfigDialog(false)}
                                        onOpenChange={onImageSettingsOpenChange}
                                    />}
                                </>
                            ) : mode === "video" ? (
                                <>
                                    <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="video" onMissingConfig={() => openConfigDialog(false)} className="min-w-0 w-0 max-w-[190px] flex-1" />
                                    <div className="min-w-0 max-w-[170px] flex-1">
                                        {rhWorkflow ? rhSettings : comfyUsage?.preservesSource ? <span className="text-xs opacity-65" title={comfyUsage.guide}>原比例 · 原时长 · 云端处理</span> : <CanvasVideoSettingsPopover fullWidth followsReferences={comfyUsage?.followsReferences} config={config} prompt={prompt} buttonClassName="!h-10 !min-w-0 !max-w-full !justify-start !rounded-full !px-3" onConfigChange={(key, value) => onConfigChange(node.id, videoConfigPatch(key, value))} />}
                                    </div>
                                </>
                            ) : mode === "audio" ? (
                                <>
                                    <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="audio" onMissingConfig={() => openConfigDialog(false)} className="max-w-[190px]" />
                                    <CanvasAudioSettingsPopover config={config} buttonClassName="!h-10 !max-w-[170px] !justify-start !rounded-full !px-3" onConfigChange={(key, value) => onConfigChange(node.id, audioConfigPatch(key, value))} />
                                </>
                            ) : (
                                <>
                                    <ModelPicker config={config} value={config.model} onChange={(model) => onConfigChange(node.id, { model })} capability="text" onMissingConfig={() => openConfigDialog(false)} className="max-w-[190px]" />
                                    <CanvasTextSettingsPopover config={config} onConfigChange={(_, value) => onConfigChange(node.id, { reasoningEffort: value })} />
                                </>
                            )}
                        </>
                    ) : null}
                </div>
                <div className={cn("flex shrink-0 items-center gap-2", mode === "video" && "ml-auto")}>
                    {hasGenerationConfig ? (
                        <>
                            {mode === "video" ? <CanvasVideoPrice baseUrl={resolveModelRequestConfig(config, config.model).baseUrl} model={resolveModelRequestConfig(config, config.model).model} color={theme.node.text} /> : null}
                            {renderPromptCount("min-w-[4.5rem] text-right")}
                            <Button
                                type="primary"
                                className="!h-10 !min-w-16 shrink-0 !rounded-full !px-3"
                                danger={isRunning}
                                disabled={!isRunning && !canSubmit}
                                onClick={() => (isRunning ? onStop(node.id) : submit())}
                                aria-label={t(isRunning ? "canvas.promptPanel.stopGeneration" : "canvas.promptPanel.generate")}
                            >
                                <span className="flex items-center gap-1.5">
                                    {isRunning ? (
                                        <>
                                            <LoaderCircle className="size-4 animate-spin" />
                                            <Square className="size-3.5 fill-current" />
                                            <span className="text-xs font-medium">{t("canvas.promptPanel.stop")}</span>
                                        </>
                                    ) : (
                                        <ArrowUp className="size-4" />
                                    )}
                                </span>
                            </Button>
                        </>
                    ) : (
                        <Button
                            type="primary"
                            className="!h-10 !shrink-0 !rounded-full !px-4"
                            onClick={() => openConfigDialog(false)}
                        >
                            <span className="flex items-center gap-1.5">
                                <Settings className="size-4" />
                                <span>{t("canvas.promptPanel.goToConfig")}</span>
                            </span>
                        </Button>
                    )}
                </div>
            </div>
            {mode === "video" ? (
                <StoryboardControls
                    storyboards={storyboards}
                    theme={theme}
                    config={globalConfig}
                    onModelChange={(model) => updateGlobalConfig("textModel", model)}
                    onImageModelChange={(model) => updateGlobalConfig("storyboardImageModel", model)}
                    onMissingConfig={() => openConfigDialog(false)}
                    onGenerate={() => onGenerateStoryboard?.(node.id, prompt)}
                    onPreview={onPreviewStoryboard}
                    onDelete={onDeleteStoryboard}
                />
            ) : null}
            <Modal
                title={
                    <div className="flex min-w-0 items-center gap-3 pr-6">
                        <span>{t("canvas.promptPanel.editorTitle")}</span>
                        {renderPromptCount()}
                    </div>
                }
                open={expanded}
                centered
                width={1054}
                closable={{ closeIcon: <Minimize2 className="size-4" />, "aria-label": t("canvas.promptPanel.collapseEditor") }}
                styles={{
                    container: { background: theme.toolbar.panel, border: `1px solid ${theme.toolbar.border}`, paddingInline: 16 },
                    header: { background: "transparent" },
                }}
                footer={null}
                onCancel={() => setExpanded(false)}
                destroyOnHidden
            >
                <div data-canvas-no-zoom className="pt-2" onWheelCapture={(event) => event.stopPropagation()}>
                    {showAssetBar ? (
                        <div className="mb-3">
                            <ConnectedAssetBar
                                assets={activeAssets}
                                mentionedLabels={mentionedLabels}
                                theme={theme}
                                ariaLabel={t("canvas.promptPanel.connectedAssets")}
                                onInsert={insertAssetReference("expanded")}
                                onFocus={onFocusReference ? (reference) => onFocusReference(node.id, reference.nodeId) : undefined}
                                onDisconnect={disconnectAsset}
                                onReorder={!isRunning && onReorderReferences ? (ids) => onReorderReferences(node.id, ids) : undefined}
                            />
                        </div>
                    ) : null}
                    <CanvasPromptChipInput
                        ref={expandedInputRef}
                        value={prompt}
                        references={resolvedMentionReferences}
                        onChange={updatePrompt}
                        className="thin-scrollbar h-[min(74dvh,calc(100dvh-12rem))] w-full cursor-text overflow-y-auto py-2 text-[14px] font-medium leading-[1.8] outline-none"
                        style={{ background: "transparent", color: theme.node.text, fontFamily: '"PingFang SC", -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei", sans-serif' }}
                        placeholder={!canSubmitWithoutPrompt && mode === "image" && activeAssets.some((asset) => asset.kind === "image") ? "结合参考图，描述要生成的图片内容" : promptPlaceholder}
                        stableNodeMentions={isCinePackVideoShotNode(node)}
                    />
                </div>
            </Modal>
            <Modal
                title={t("canvas.promptPanel.overwriteTitle")}
                open={showConfirmModal}
                centered
                onCancel={() => setShowConfirmModal(false)}
                footer={
                    <>
                        <Button onClick={() => setShowConfirmModal(false)}>{t("common.cancel")}</Button>
                        <Button danger type="primary" onClick={confirmGenerate}>
                            {t("canvas.promptPanel.overwriteConfirm")}
                        </Button>
                    </>
                }
            >
                <p className="text-sm opacity-60">
                    {t("canvas.promptPanel.overwriteContent")}
                </p>
            </Modal>
        </div>
    );
}

function StoryboardControls({
    storyboards,
    theme,
    config,
    onModelChange,
    onImageModelChange,
    onMissingConfig,
    onGenerate,
    onPreview,
    onDelete,
}: {
    storyboards: CanvasNodeData[];
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    config: AiConfig;
    onModelChange: (model: string) => void;
    onImageModelChange: (model: string) => void;
    onMissingConfig: () => void;
    onGenerate: () => void;
    onPreview?: (nodeId: string) => void;
    onDelete?: (nodeId: string) => void;
}) {
    return (
        <div className="mt-3 shrink-0 border-t pt-2.5" style={{ borderColor: theme.toolbar.border }}>
            <div className="flex min-h-9 flex-wrap items-center justify-between gap-3">
                <span className="text-sm leading-5" style={{ color: theme.node.text }}>
                    使用此提示词生成故事板，进行基础视觉验证
                </span>
                <div className="flex min-w-0 flex-wrap items-center justify-end gap-2">
                    <span className="shrink-0 text-xs opacity-60">大模型</span>
                    <ModelPicker config={config} value={config.textModel} onChange={onModelChange} capability="text" onMissingConfig={onMissingConfig} className="max-w-[180px]" />
                    <span className="shrink-0 text-xs opacity-60">生图</span>
                    <ModelPicker config={config} value={config.storyboardImageModel || config.imageModel} onChange={onImageModelChange} capability="image" onMissingConfig={onMissingConfig} className="max-w-[180px]" />
                    <Tooltip title="生成故事板">
                        <button
                            type="button"
                            className="grid size-9 shrink-0 place-items-center rounded-lg bg-transparent transition hover:bg-black/5 dark:hover:bg-white/10"
                            style={{ color: theme.node.text }}
                            onClick={onGenerate}
                            aria-label="使用当前提示词生成故事板"
                        >
                            <ArrowRight className="size-4" />
                        </button>
                    </Tooltip>
                </div>
            </div>
            {storyboards.length ? (
                <div className="thin-scrollbar mt-2 flex min-h-14 items-center gap-2 overflow-x-auto border-t pt-2.5" style={{ borderColor: theme.toolbar.border }} aria-label="故事板列表">
                    {storyboards.map((storyboard) => (
                        <StoryboardItem key={storyboard.id} node={storyboard} theme={theme} onPreview={onPreview} onDelete={onDelete} />
                    ))}
                </div>
            ) : null}
        </div>
    );
}

function StoryboardItem({ node, theme, onPreview, onDelete }: { node: CanvasNodeData; theme: (typeof canvasThemes)[keyof typeof canvasThemes]; onPreview?: (nodeId: string) => void; onDelete?: (nodeId: string) => void }) {
    const status = node.metadata?.status || "idle";
    const index = node.metadata?.storyboardIndex || 0;
    const loading = status === "loading";
    const failed = status === "error";
    const content = node.metadata?.content;
    const phase = node.metadata?.generationPhase;
    const failedPhase = node.metadata?.generationFailedPhase;
    const detail = node.metadata?.generationDetail;
    const progress = node.metadata?.generationProgress;
    const phaseText = storyboardPhaseText(phase);
    const [now, setNow] = useState(Date.now());
    useEffect(() => {
        if (!loading) return;
        const timer = window.setInterval(() => setNow(Date.now()), 1_000);
        return () => window.clearInterval(timer);
    }, [loading]);
    const elapsedSeconds = node.metadata?.generationPhaseStartedAt ? Math.max(0, Math.round((now - node.metadata.generationPhaseStartedAt) / 1_000)) : 0;
    const popover = content ? (
        <img src={content} alt={`故事板${index}`} className="block max-h-72 max-w-96 rounded-lg object-contain" />
    ) : (
        <div className="max-w-80 space-y-1 text-sm leading-5" style={{ color: theme.node.text }}>
            <div className="font-medium">{loading ? phaseText : failedPhase ? `失败阶段：${storyboardPhaseText(failedPhase)}` : "故事板生成失败"}</div>
            {detail ? <div className="opacity-75">{detail}</div> : null}
            {loading && typeof progress === "number" ? <div className="tabular-nums opacity-75">进度：{Math.round(progress)}%</div> : null}
            {loading && elapsedSeconds ? <div className="tabular-nums opacity-60">当前阶段已持续 {elapsedSeconds} 秒</div> : null}
            {!loading ? <div className="opacity-75">{node.metadata?.errorDetails || "请求失败"}</div> : null}
        </div>
    );
    return (
        <div className="group relative">
            <Popover title={`故事板 ${index}`} content={popover} trigger="hover" mouseEnterDelay={0.25}>
                <button
                    type="button"
                    className="relative grid size-11 place-items-center overflow-hidden rounded-lg border-2 bg-transparent text-sm font-semibold tabular-nums transition hover:opacity-80"
                    style={{ borderColor: failed ? "#ef4444" : loading ? "#f59e0b" : theme.node.stroke, color: theme.node.text }}
                    onClick={() => content && onPreview?.(node.id)}
                    aria-label={`故事板${index}${loading ? "，生成中" : failed ? "，生成失败" : ""}`}
                >
                    {loading ? <LoaderCircle className="absolute size-8 animate-spin text-amber-500/80" /> : null}
                    <span className="relative z-10">{index}</span>
                </button>
            </Popover>
            {!loading ? (
                <button
                    type="button"
                    className="absolute -right-1.5 -top-1.5 z-10 grid size-4 place-items-center rounded-full bg-red-500 text-white opacity-0 shadow-sm transition group-hover:opacity-100 hover:bg-red-400"
                    aria-label={`删除故事板${index}`}
                    title="删除故事板"
                    onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                    }}
                    onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        onDelete?.(node.id);
                    }}
                >
                    <X className="size-2.5 stroke-[3]" />
                </button>
            ) : null}
        </div>
    );
}

function storyboardPhaseText(phase?: CanvasGenerationPhase) {
    if (phase === "resolving") return "正在读取参考资产";
    if (phase === "compressing") return "正在压缩参考图";
    if (phase === "planning") return "正在等待故事板大模型编译";
    if (phase === "submitting") return "正在提交故事板生图任务";
    if (phase === "queued") return "生图任务已接单，正在排队";
    if (phase === "generating") return "生图模型正在生成故事板";
    if (phase === "downloading") return "正在下载故事板结果";
    if (phase === "saving") return "正在保存故事板";
    if (phase === "packing") return "正在打包提示词";
    return "正在准备故事板";
}

function ConnectedAssetBar({
    assets,
    mentionedLabels,
    theme,
    ariaLabel,
    onInsert,
    onFocus,
    onDisconnect,
    onReorder,
}: {
    assets: CanvasResourceReference[];
    mentionedLabels: Set<string>;
    theme: (typeof canvasThemes)[keyof typeof canvasThemes];
    ariaLabel: string;
    onInsert: (reference: CanvasResourceReference) => void;
    onFocus?: (reference: CanvasResourceReference) => void;
    onDisconnect?: (reference: CanvasResourceReference) => void;
    onReorder?: (ids: string[]) => void;
}) {
    const { t } = useTranslation();
    const barRef = useRef<HTMLDivElement>(null);
    const dragRef = useRef<{ id: string; x: number; y: number; target: string; moved: boolean; offsetX: number; offsetY: number; width: number; height: number } | null>(null);
    const suppressClick = useRef(false);
    const pendingInserts = useRef(new Map<string, ReturnType<typeof setTimeout>>()).current;
    useEffect(() => () => {
        pendingInserts.forEach((timer) => clearTimeout(timer));
        pendingInserts.clear();
    }, [pendingInserts]);
    const [dragTarget, setDragTarget] = useState<string | null>(null);
    const [draggingId, setDraggingId] = useState<string | null>(null);
    const [dragPreview, setDragPreview] = useState<{ left: number; top: number; width: number; height: number } | null>(null);
    const latest = useRef({ assets, onReorder });
    latest.current = { assets, onReorder };
    useEffect(() => {
        // Hit-test the thumbnail rectangles: a hover preview or the captured source must not intercept the drop.
        const targetAt = (x: number, y: number) => {
            const bar = barRef.current;
            if (!bar) return null;
            const bounds = bar.getBoundingClientRect();
            if (x < bounds.left - 12 || x > bounds.right + 12 || y < bounds.top - 12 || y > bounds.bottom + 12) return null;
            let best: { id: string; distance: number } | null = null;
            for (const element of bar.querySelectorAll<HTMLElement>("[data-reference-id]")) {
                const rect = element.getBoundingClientRect();
                const distance = Math.hypot(x - (rect.left + rect.width / 2), y - (rect.top + rect.height / 2));
                if (!best || distance < best.distance) best = { id: element.dataset.referenceId!, distance };
            }
            return best?.id || null;
        };
        const move = (event: PointerEvent) => {
            const drag = dragRef.current;
            if (!drag) return;
            if (Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 5 && !drag.moved) return;
            drag.moved = true;
            suppressClick.current = true;
            setDragPreview({ left: event.clientX - drag.offsetX, top: event.clientY - drag.offsetY, width: drag.width, height: drag.height });
            const target = targetAt(event.clientX, event.clientY);
            if (target) {
                drag.target = target;
                setDragTarget(drag.target);
            }
        };
        const up = (event: PointerEvent) => {
            const drag = dragRef.current;
            dragRef.current = null;
            setDragTarget(null);
            setDraggingId(null);
            setDragPreview(null);
            const target = targetAt(event.clientX, event.clientY);
            if (!drag?.moved || !target || drag.id === target || !latest.current.onReorder) return;
            const ids = latest.current.assets.map((asset) => asset.id);
            const from = ids.indexOf(drag.id);
            const to = ids.indexOf(target);
            if (from < 0 || to < 0) return;
            ids.splice(from, 1); ids.splice(to, 0, drag.id);
            latest.current.onReorder(ids);
        };
        const cancel = () => { dragRef.current = null; setDragTarget(null); setDraggingId(null); setDragPreview(null); };
        const key = (event: KeyboardEvent) => { if (event.key === "Escape") cancel(); };
        window.addEventListener("pointermove", move, true);
        window.addEventListener("pointerup", up, true);
        window.addEventListener("pointercancel", cancel);
        window.addEventListener("blur", cancel);
        window.addEventListener("keydown", key);
        return () => {
            window.removeEventListener("pointermove", move, true); window.removeEventListener("pointerup", up, true);
            window.removeEventListener("pointercancel", cancel); window.removeEventListener("blur", cancel); window.removeEventListener("keydown", key);
        };
    }, []);
    const draggedReference = assets.find((asset) => asset.id === draggingId);
    return (
        <div ref={barRef} className="flex flex-wrap gap-2" aria-label={ariaLabel}>
            {assets.map((reference) => {
                const highlighted = mentionedLabels.has(reference.label);
                const canDisconnect = Boolean(reference.connectionId && onDisconnect);
                return (
                    <div key={reference.id} data-reference-id={reference.id} className={`group relative ${dragTarget === reference.id ? "ring-2 ring-blue-400 rounded-lg" : ""}`}>
                        <Popover content={<>
                            <ConnectedAssetPreview reference={reference} theme={theme} />
                            {onFocus ? <div className="mt-2 text-center text-xs opacity-70">双击可聚焦至节点</div> : null}
                        </>} trigger="hover" mouseEnterDelay={0.2} destroyOnHidden {...(draggingId ? { open: false } : {})}>
                            <button
                                type="button"
                                className={`relative inline-flex size-12 overflow-hidden rounded-lg border-2 p-0 transition hover:opacity-90 ${onReorder ? "cursor-grab active:cursor-grabbing" : "cursor-pointer"} ${draggingId === reference.id ? "opacity-50" : ""}`}
                                style={{
                                    borderColor: highlighted ? "#eab308" : theme.node.stroke,
                                    boxShadow: highlighted ? "0 0 0 1px rgba(234,179,8,0.45)" : undefined,
                                    background: theme.node.fill || "transparent",
                                    color: theme.node.text,
                                    touchAction: "none",
                                }}
                                aria-label={`${reference.label} · ${reference.title || reference.label}`}
                                title={onReorder ? `悬停预览，拖动调整参考顺序，点击插入引用${onFocus ? "，双击聚焦至节点" : ""}` : undefined}
                                onPointerDown={(event) => {
                                    if (!onReorder || !canDisconnect || event.button !== 0) return;
                                    event.preventDefault(); event.stopPropagation();
                                    suppressClick.current = false;
                                    const rect = event.currentTarget.getBoundingClientRect();
                                    dragRef.current = { id: reference.id, x: event.clientX, y: event.clientY, target: reference.id, moved: false, offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top, width: rect.width, height: rect.height };
                                    setDraggingId(reference.id);
                                    event.currentTarget.setPointerCapture(event.pointerId);
                                }}
                                onMouseDown={(event) => {
                                    // 保持输入框焦点与光标位置，便于插入到当前 caret
                                    event.preventDefault();
                                    event.stopPropagation();
                                }}
                                onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    if (suppressClick.current) { suppressClick.current = false; return; }
                                    if (!onFocus || event.detail === 0) {
                                        onInsert(reference);
                                        return;
                                    }
                                    // Wait for a possible double-click before editing the prompt.
                                    clearTimeout(pendingInserts.get(reference.id));
                                    pendingInserts.delete(reference.id);
                                    if (event.detail !== 1) return;
                                    pendingInserts.set(reference.id, setTimeout(() => {
                                        pendingInserts.delete(reference.id);
                                        onInsert(reference);
                                    }, 500));
                                }}
                                onDoubleClick={(event) => {
                                    if (!onFocus) return;
                                    event.preventDefault();
                                    event.stopPropagation();
                                    clearTimeout(pendingInserts.get(reference.id));
                                    pendingInserts.delete(reference.id);
                                    onFocus(reference);
                                }}
                            >
                                <AssetThumb reference={reference} />
                                <span className="pointer-events-none absolute bottom-0 left-0 rounded-tr bg-black/70 px-1 text-[10px] leading-4 text-white">{reference.label}</span>
                                {highlighted ? <span className="pointer-events-none absolute inset-0 rounded-[6px] ring-1 ring-amber-400/80" /> : null}
                            </button>
                        </Popover>
                        {canDisconnect ? (
                            <button
                                type="button"
                                className="absolute right-0.5 top-0.5 z-30 grid size-5 place-items-center rounded-full bg-red-500 text-white opacity-0 shadow-sm transition group-hover:opacity-100 hover:bg-red-400"
                                aria-label={t("canvas.promptPanel.disconnectAsset")}
                                title={t("canvas.promptPanel.disconnectAsset")}
                                onMouseDown={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                }}
                                onClick={(event) => {
                                    event.preventDefault();
                                    event.stopPropagation();
                                    onDisconnect?.(reference);
                                }}
                            >
                                <X className="size-2.5 stroke-[3]" />
                            </button>
                        ) : null}
                    </div>
                );
            })}
            {dragPreview && draggedReference ? createPortal(
                <div data-reference-drag-preview aria-hidden="true" className="pointer-events-none fixed z-[10000] overflow-hidden rounded-lg border-2 shadow-2xl" style={{ ...dragPreview, borderColor: theme.node.activeStroke, background: theme.toolbar.panel, boxShadow: "0 8px 24px rgba(0,0,0,0.4)", transform: "scale(1.06)" }}>
                    <AssetThumb reference={draggedReference} />
                    <span className="absolute bottom-0 left-0 whitespace-nowrap rounded-tr bg-black/70 text-white" style={{ fontSize: dragPreview.width / 48 * 10, lineHeight: `${dragPreview.width / 48 * 16}px`, paddingInline: dragPreview.width / 48 * 4 }}>{draggedReference.label}</span>
                </div>, document.body,
            ) : null}
        </div>
    );
}

function ConnectedAssetPreview({ reference, theme }: { reference: CanvasResourceReference; theme: (typeof canvasThemes)[keyof typeof canvasThemes] }) {
    const videoRef = useRef<HTMLVideoElement>(null);
    const audioRef = useRef<HTMLAudioElement>(null);
    useEffect(() => {
        const media = videoRef.current || audioRef.current;
        if (!media) return;
        void media.play().catch(() => undefined);
        return () => {
            media.pause();
            media.currentTime = 0;
        };
    }, []);
    return (
        <div className="w-64" style={{ color: theme.node.text }}>
            <div className="mb-2 truncate text-sm font-medium">{reference.title || reference.label}</div>
            {reference.kind === "image" && reference.previewUrl ? <img src={reference.previewUrl} alt={reference.title} className="max-h-64 w-full rounded-lg object-contain" /> : null}
            {reference.kind === "video" && reference.previewUrl ? <video ref={videoRef} src={reference.previewUrl} autoPlay muted controls playsInline preload="auto" className="max-h-64 w-full rounded-lg bg-black object-contain" /> : null}
            {reference.kind === "audio" && reference.previewUrl ? <audio ref={audioRef} src={reference.previewUrl} autoPlay controls preload="auto" className="w-full" /> : null}
            {reference.kind === "text" && reference.text ? <div className="thin-scrollbar max-h-56 overflow-auto whitespace-pre-wrap break-words text-xs leading-5">{reference.text}</div> : null}
            {!reference.previewUrl && !(reference.kind === "text" && reference.text) ? <div className="py-4 text-center text-xs opacity-60">暂无可预览内容</div> : null}
        </div>
    );
}

function AssetThumb({ reference }: { reference: CanvasResourceReference }) {
    if (reference.kind === "image" && reference.previewUrl) {
        return <img src={reference.previewUrl} alt="" draggable={false} className="pointer-events-none size-full select-none object-cover" />;
    }
    if (reference.kind === "video" && reference.previewUrl) {
        return <video src={reference.previewUrl} className="pointer-events-none size-full select-none object-cover" muted preload="metadata" />;
    }
    const Icon = reference.kind === "audio" ? Music2 : reference.kind === "video" ? Video : reference.kind === "image" ? ImageIcon : FileText;
    return (
        <span className="grid size-full place-items-center opacity-70">
            <Icon className="size-5" />
        </span>
    );
}

function defaultMode(type: CanvasNodeData["type"]): CanvasNodeGenerationMode {
    return type === CanvasNodeType.Text ? "text" : type === CanvasNodeType.Video ? "video" : type === CanvasNodeType.Audio ? "audio" : "image";
}

function buildNodeConfig(globalConfig: AiConfig, node: CanvasNodeData, mode: CanvasNodeGenerationMode): AiConfig {
    const defaultSize = mode === "video" ? globalConfig.videoSize : mode === "image" ? globalConfig.imageSize : globalConfig.size;
    return {
        ...globalConfig,
        model: resolveModelForCapability(globalConfig, node.metadata?.model, mode),
        reasoningEffort: node.metadata?.reasoningEffort || globalConfig.reasoningEffort || defaultConfig.reasoningEffort,
        quality: node.metadata?.quality || globalConfig.quality || defaultConfig.quality,
        size: node.metadata?.size || defaultSize || defaultConfig.size,
        background: node.metadata?.background ?? globalConfig.background ?? defaultConfig.background,
        videoSeconds: node.metadata?.seconds || globalConfig.videoSeconds || defaultConfig.videoSeconds,
        vquality: node.metadata?.vquality || globalConfig.vquality || defaultConfig.vquality,
        videoGenerateAudio: node.metadata?.generateAudio || globalConfig.videoGenerateAudio || defaultConfig.videoGenerateAudio,
        videoWatermark: node.metadata?.watermark || globalConfig.videoWatermark || defaultConfig.videoWatermark,
        audioVoice: node.metadata?.audioVoice || globalConfig.audioVoice || defaultConfig.audioVoice,
        audioFormat: node.metadata?.audioFormat || globalConfig.audioFormat || defaultConfig.audioFormat,
        audioSpeed: node.metadata?.audioSpeed || globalConfig.audioSpeed || defaultConfig.audioSpeed,
        audioInstructions: node.metadata?.audioInstructions || globalConfig.audioInstructions || defaultConfig.audioInstructions,
        count: String(node.metadata?.count || globalConfig.count || defaultConfig.count),
    };
}

function videoConfigPatch(key: keyof AiConfig, value: string) {
    if (key === "videoSeconds") return { seconds: value };
    if (key === "videoGenerateAudio") return { generateAudio: value };
    if (key === "videoWatermark") return { watermark: value };
    return { [key]: value };
}

function imageConfigPatch(key: keyof AiConfig, value: string) {
    if (key === "count") return { count: Number(value) };
    return { [key]: value };
}

function audioConfigPatch(key: CanvasAudioSettingKey, value: string) {
    if (key === "audioVoice") return { audioVoice: value };
    if (key === "audioFormat") return { audioFormat: value };
    if (key === "audioSpeed") return { audioSpeed: value };
    return { audioInstructions: value };
}

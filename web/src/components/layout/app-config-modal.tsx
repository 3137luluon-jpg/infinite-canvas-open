import { App, Button, Form, Input, Modal, Progress, Select, Tabs } from "antd";
import type { TFunction } from "i18next";
import { Check, CircleOff, Cloud, Download, Loader2, Pencil, Plus, RefreshCw, Trash2, Upload, Wifi } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { imageAspectOptions, imageQualityOptions } from "@/components/image-settings-panel";
import { DefaultVideoModelPicker } from "@/components/layout/default-video-model-picker";
import { ModelPicker } from "@/components/model-picker";
import { normalizeVideoResolutionValue, normalizeVideoSizeValue, videoResolutionOptions, videoSecondOptions, videoSizeOptions } from "@/components/video-settings-panel";
import { ChannelEditorDrawer } from "@/components/layout/channel-editor-drawer";
import { ConfigLocalStorage } from "@/components/layout/config-local-storage";
import { useGptConnectionCheck, type ConnectionStatus } from "@/hooks/use-gpt-connection-check";
import type { AppLocale } from "@/i18n";
import { getFeimiaoSpec, isFeimiaoModelConfig, normalizeFeimiaoAspectRatio, normalizeFeimiaoDuration, normalizeFeimiaoResolution } from "@/lib/feimiao-video";
import { isAutoVideoDuration, VIDEO_DURATION_AUTO } from "@/lib/video-duration";
import { isSeedanceVideoConfig, normalizeSeedanceDuration, normalizeSeedanceRatio, normalizeSeedanceResolution, seedanceDurationOptions, seedanceRatioOptions, seedanceResolutionOptions } from "@/lib/seedance-video";
import { exportAppConfig, importAppConfig } from "@/services/config-file";
import { DOLA_RATIOS, dolaDurations } from "@/lib/dola-video";
import { AGNES_VIDEO_RATIOS, agnesRatio, isAgnesConfig } from "@/lib/agnes";
import { isRunningHubConfig, RUNNINGHUB_RATIOS, RUNNINGHUB_RESOLUTIONS } from "@/lib/runninghub";
import { integerDurationRange, resolveVideoDuration } from "@/lib/video-duration";
import { resolveModelRequestConfig } from "@/stores/use-config-store";
import { syncAppDataToWebdav, type AppSyncDomainKey, type AppSyncProgressEvent } from "@/services/app-sync";
import { testWebdavConnection, WEBDAV_MANIFEST_FILE_NAME } from "@/services/webdav-sync";
import { createModelChannel, modelOptionName, modelOptionsFromChannels, normalizeModelOptionValue, selectableModelsByCapability, useConfigStore, type AiConfig, type ApiCallFormat, type ConfigTabKey, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";

type WebdavDomainProgress = {
    stage: string;
    current?: number;
    total?: number;
    status?: "active" | "success" | "exception";
};

const webdavDomainKeys: AppSyncDomainKey[] = ["canvas", "assets", "image-workbench", "video-workbench"];
function createWebdavDomainProgress(): Record<AppSyncDomainKey, WebdavDomainProgress> {
    return webdavDomainKeys.reduce(
        (progress, key) => ({
            ...progress,
            [key]: { stage: "等待同步" },
        }),
        {} as Record<AppSyncDomainKey, WebdavDomainProgress>,
    );
}

export function AppConfigPanel({ showDoneButton = false, initialTab = "channels" }: { showDoneButton?: boolean; initialTab?: ConfigTabKey }) {
    const { message, modal } = App.useApp();
    const { i18n, t } = useTranslation();
    const configInputRef = useRef<HTMLInputElement>(null);
    const [activeTab, setActiveTab] = useState<ConfigTabKey>(initialTab === "prompt-sources" ? "channels" : initialTab);
    const [editingChannelId, setEditingChannelId] = useState("");
    const [newChannel, setNewChannel] = useState<ModelChannel | null>(null);
    const [testingWebdav, setTestingWebdav] = useState(false);
    const [syncingWebdav, setSyncingWebdav] = useState(false);
    const [webdavSyncStatus, setWebdavSyncStatus] = useState("");
    const [webdavDomainProgress, setWebdavDomainProgress] = useState(createWebdavDomainProgress);
    const { gptStatus, gptMessage, imageStatus, imageMessage, checkConnection } = useGptConnectionCheck();
    const config = useConfigStore((state) => state.config);
    const webdav = useConfigStore((state) => state.webdav);
    const updateConfig = useConfigStore((state) => state.updateConfig);
    const videoPrefConfig = { ...config, model: config.videoModel || config.model };
    const videoModelName = modelOptionName(config.videoModel);
    const agnesVideo = isAgnesConfig(resolveModelRequestConfig(config, config.videoModel));
    const runningHubVideo = isRunningHubConfig(resolveModelRequestConfig(config, config.videoModel));
    const dolaVideo = config.channels.some(channel => channel.apiFormat === "dola" && channel.models.some(model => `${channel.id}::${model.name}` === config.videoModel));
    const feimiaoVideo = isFeimiaoModelConfig(videoPrefConfig, config.videoModel);
    const seedanceVideo = !feimiaoVideo && isSeedanceVideoConfig(videoPrefConfig);
    const feimiaoSpec = getFeimiaoSpec(videoModelName);
    const videoRatioOptions = runningHubVideo ? RUNNINGHUB_RATIOS.map(option) : agnesVideo ? AGNES_VIDEO_RATIOS.map(option) : dolaVideo ? DOLA_RATIOS.map(option) : feimiaoVideo
        ? feimiaoSpec.aspectRatios.map(option)
        : seedanceVideo
          ? seedanceRatioOptions.map(({ value }) => option(value))
          : videoSizeOptions;
    const videoQualityOptions = runningHubVideo ? RUNNINGHUB_RESOLUTIONS.map(option) : agnesVideo ? [{ value: "720p", label: "720P" }] : dolaVideo ? [] : feimiaoVideo
        ? feimiaoSpec.resolutions.map(option)
        : seedanceVideo
          ? seedanceResolutionOptions.map(({ value, label }) => ({ value, label }))
          : videoResolutionOptions;
    const videoDurationOptions = [
        secondsOption(VIDEO_DURATION_AUTO),
        ...(runningHubVideo ? integerDurationRange(4, 15).map(secondsOption) : agnesVideo ? integerDurationRange(4, 12).map(secondsOption) : dolaVideo ? dolaDurations(videoModelName).map(secondsOption) : feimiaoVideo
            ? feimiaoSpec.durations.map(secondsOption)
            : seedanceVideo
              ? seedanceDurationOptions.map(secondsOption)
              : videoSecondOptions.map(secondsOption)),
    ];
    const selectedVideoSize = runningHubVideo ? normalizeSeedanceRatio(config.videoSize) : agnesVideo ? (() => { try { return agnesRatio(config.videoSize, true); } catch { return config.videoSize; } })() : dolaVideo ? config.videoSize : feimiaoVideo
        ? normalizeFeimiaoAspectRatio(config.videoSize, videoModelName)
        : seedanceVideo
          ? normalizeSeedanceRatio(config.videoSize)
          : normalizeVideoSizeValue(config.videoSize);
    const selectedVideoQuality = runningHubVideo ? normalizeSeedanceResolution(config.vquality) : agnesVideo ? "720p" : feimiaoVideo
        ? normalizeFeimiaoResolution(config.vquality, videoModelName)
        : seedanceVideo
          ? normalizeSeedanceResolution(config.vquality)
          : normalizeVideoResolutionValue(config.vquality);
    const selectedVideoSeconds = isAutoVideoDuration(config.videoSeconds)
        ? VIDEO_DURATION_AUTO
        : String(runningHubVideo ? resolveVideoDuration(config.videoSeconds || "5", "", integerDurationRange(4, 15), 5) : agnesVideo ? resolveVideoDuration(config.videoSeconds || "5", "", integerDurationRange(4, 12), 5) : feimiaoVideo ? normalizeFeimiaoDuration(config.videoSeconds, videoModelName) : seedanceVideo ? normalizeSeedanceDuration(config.videoSeconds) : config.videoSeconds);
    const updateWebdavConfig = useConfigStore((state) => state.updateWebdavConfig);
    const shouldPromptContinue = useConfigStore((state) => state.shouldPromptContinue);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    const clearPromptContinue = useConfigStore((state) => state.clearPromptContinue);
    const webdavReady = Boolean(webdav.url.trim());
    const editingChannel = newChannel || config.channels.find((channel) => channel.id === editingChannelId) || null;
    const checkingStoryboardApi = gptStatus === "checking" || imageStatus === "checking";
    const locale = i18n.resolvedLanguage as AppLocale;
    useEffect(() => setActiveTab(initialTab === "prompt-sources" ? "channels" : initialTab), [initialTab]);

    const saveConfig = (nextConfig: AiConfig) => {
        (Object.keys(nextConfig) as Array<keyof AiConfig>).forEach((key) => updateConfig(key, nextConfig[key]));
    };

    const finishConfig = () => {
        const ready = config.channels.some((channel) => channel.baseUrl.trim() && (channel.apiFormat === "comfyui" || channel.apiKey.trim()) && channel.models.length);
        setConfigDialogOpen(false);
        if (!ready) return;
        message.success(t(shouldPromptContinue ? "config.savedContinue" : "config.saved"));
        clearPromptContinue();
    };

    const loadConfigFile = async (file: File) => {
        try {
            await importAppConfig(file);
            message.success(t("config.imported"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.importFailed"));
        } finally {
            if (configInputRef.current) configInputRef.current.value = "";
        }
    };

    const updateChannels = (channels: ModelChannel[]) => saveConfig(withChannels(config, channels));

    const saveChannel = (channel: ModelChannel) => {
        const exists = config.channels.some((item) => item.id === channel.id);
        updateChannels(exists ? config.channels.map((item) => (item.id === channel.id ? channel : item)) : [...config.channels, channel]);
        setNewChannel(null);
        setEditingChannelId("");
    };

    const addChannel = () => {
        const channel = createModelChannel({ name: t("config.channels.numberedName", { count: config.channels.length + 1 }) });
        setNewChannel(channel);
        setEditingChannelId(channel.id);
    };

    const removeChannel = (channel: ModelChannel) => {
        if (config.channels.length <= 1) {
            message.warning(t("config.channels.keepOne"));
            return;
        }
        modal.confirm({
            title: `删除“${channel.name || t("config.channels.unnamed")}”？`,
            content: "只会删除这条 API 渠道配置，不会删除画布、素材或已经生成的内容。引用该渠道模型的默认选择会自动切换到其他可用模型。",
            okText: t("common.delete"),
            cancelText: t("common.cancel"),
            okButtonProps: { danger: true },
            onOk: () => updateChannels(config.channels.filter((item) => item.id !== channel.id)),
        });
    };

    const closeChannelEditor = () => {
        setNewChannel(null);
        setEditingChannelId("");
    };

    const testWebdav = async () => {
        if (!webdavReady) {
            message.error(t("config.webdav.missingUrl"));
            return;
        }
        setTestingWebdav(true);
        try {
            await testWebdavConnection(webdav);
            message.success(t("config.webdav.available"));
        } catch (error) {
            message.error(error instanceof Error ? error.message : t("config.webdav.testFailed"));
        } finally {
            setTestingWebdav(false);
        }
    };

    const updateWebdavProgress = (event: AppSyncProgressEvent) => {
        setWebdavSyncStatus(event.stage);
        if (!event.domain) return;
        setWebdavDomainProgress((current) => ({
            ...current,
            [event.domain as AppSyncDomainKey]: {
                stage: event.stage,
                current: event.current,
                total: event.total,
                status: event.status,
            },
        }));
    };

    const syncWebdav = async () => {
        if (!webdavReady) {
            message.error(t("config.webdav.missingUrl"));
            return;
        }
        setSyncingWebdav(true);
        setWebdavDomainProgress(createWebdavDomainProgress());
        setWebdavSyncStatus(t("config.webdav.preparing"));
        try {
            const result = await syncAppDataToWebdav(webdav, updateWebdavProgress);
            updateWebdavConfig("lastSyncedAt", result.syncedAt);
            message.success(t("config.webdav.completed", { projects: result.projects, assets: result.assets, records: result.imageLogs + result.videoLogs, files: result.uploadedFiles, bytes: formatBytes(result.uploadedBytes) }));
        } catch (error) {
            setWebdavSyncStatus(error instanceof Error ? error.message : t("config.webdav.failed"));
            message.error(error instanceof Error ? error.message : t("config.webdav.failed"));
        } finally {
            setSyncingWebdav(false);
        }
    };

    return (
        <>
            <div className="flex justify-end border-b border-stone-200 pb-3 dark:border-stone-800">
                <div className="flex gap-2">
                    <Button icon={<Upload className="size-4" />} onClick={() => configInputRef.current?.click()}>
                        {t("config.import")}
                    </Button>
                    <Button icon={<Download className="size-4" />} onClick={exportAppConfig}>
                        {t("config.export")}
                    </Button>
                    <input ref={configInputRef} type="file" accept="application/json,.json" className="hidden" onChange={(event) => event.target.files?.[0] && void loadConfigFile(event.target.files[0])} />
                </div>
            </div>
            <Tabs
                activeKey={activeTab}
                onChange={(key) => setActiveTab(key as ConfigTabKey)}
                items={[
                    {
                        key: "channels",
                        label: t("config.tabs.channels"),
                        children: (
                            <div>
                                <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
                                    <div className="text-xs text-stone-500">每条 API 可同时提供大语言模型、生图、视频或音频模型；模型能力在渠道编辑器中逐个指定。</div>
                                    <Button type="primary" size="small" icon={<Plus className="size-3.5" />} onClick={addChannel}>
                                        {t("config.channels.add")}
                                    </Button>
                                </div>
                                <div className="space-y-2">
                                    {config.channels.map((channel) => (
                                        <div key={channel.id} className="flex items-center justify-between gap-3 rounded-lg border border-stone-200 px-4 py-3 dark:border-stone-800">
                                            <div className="min-w-0">
                                                <div className="flex min-w-0 items-center gap-2">
                                                    <div className="truncate text-sm font-semibold">{channel.name || t("config.channels.unnamed")}</div>
                                                    {channelCapabilities(channel).map((capability) => (
                                                        <span key={capability} className="shrink-0 rounded border border-stone-300 px-1.5 py-0.5 text-[10px] font-medium text-stone-500 dark:border-stone-700 dark:text-stone-400">
                                                            {capabilityLabel(capability)}
                                                        </span>
                                                    ))}
                                                </div>
                                                <div className="mt-1 truncate text-xs text-stone-500">
                                                    {isRunningHubConfig(channel) ? "RunningHub" : apiFormatLabel(channel.apiFormat, t)} · {t("config.channels.modelCount", { count: channel.models.length })} · {channel.baseUrl || t("config.channels.missingUrl")}
                                                </div>
                                            </div>
                                            <div className="flex shrink-0 gap-2">
                                                <Button size="small" icon={<Pencil className="size-3.5" />} onClick={() => setEditingChannelId(channel.id)}>
                                                    {t("common.edit")}
                                                </Button>
                                                <Button size="small" danger type="text" aria-label={`删除${channel.name}`} icon={<Trash2 className="size-3.5" />} onClick={() => removeChannel(channel)} />
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            </div>
                        ),
                    },
                    {
                        key: "preferences",
                        label: t("config.tabs.preferences"),
                        children: (
                            <Form layout="vertical" requiredMark={false}>
                                <div className="mb-2 text-sm font-semibold">{t("config.preferences.defaultModels")}</div>
                                <div className="mb-4 grid gap-4 md:grid-cols-2">
                                    <div className="space-y-3 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                        <Form.Item label={t("config.preferences.defaultImageModel")} className="mb-0">
                                            <ModelPicker config={config} value={config.imageModel} onChange={(model) => updateConfig("imageModel", model)} capability="image" fullWidth />
                                        </Form.Item>
                                        <div className="grid grid-cols-2 gap-3">
                                            <Form.Item label={t("settingsPanels.image.resolution")} className="mb-0">
                                                <Select value={config.quality} options={imageQualityOptions} onChange={(value) => updateConfig("quality", value)} />
                                            </Form.Item>
                                            <Form.Item label={t("settingsPanels.image.aspectRatio")} className="mb-0">
                                                <Select value={config.imageSize} options={imageAspectOptions} onChange={(value) => updateConfig("imageSize", value)} />
                                            </Form.Item>
                                        </div>
                                    </div>
                                    <div className="space-y-3 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                        <Form.Item label={t("config.preferences.defaultVideoModel")} className="mb-0">
                                            <DefaultVideoModelPicker config={config} />
                                        </Form.Item>
                                        <div className="grid grid-cols-3 gap-3">
                                            <Form.Item label={t("settingsPanels.video.ratio")} className="mb-0">
                                                <Select value={selectedVideoSize} options={videoRatioOptions} onChange={(value) => updateConfig("videoSize", value)} />
                                            </Form.Item>
                                            {videoQualityOptions.length ? (
                                                <Form.Item label={t("settingsPanels.video.resolution")} className="mb-0">
                                                    <Select value={selectedVideoQuality} options={videoQualityOptions} onChange={(value) => updateConfig("vquality", value)} />
                                                </Form.Item>
                                            ) : null}
                                            <Form.Item label={t("settingsPanels.video.duration")} className="mb-0">
                                                <Select value={selectedVideoSeconds} options={videoDurationOptions} onChange={(value) => updateConfig("videoSeconds", value)} />
                                            </Form.Item>
                                        </div>
                                    </div>
                                </div>
                                <div className="grid gap-4 md:grid-cols-2">
                                    <Form.Item label={t("config.preferences.defaultTextModel")} extra={t("config.preferences.defaultTextModelHint")} className="mb-0">
                                        <ModelPicker config={config} value={config.textModel} onChange={(model) => updateConfig("textModel", model)} capability="text" fullWidth />
                                    </Form.Item>
                                    <Form.Item label={t("config.preferences.storyboardImageModel")} extra={t("config.preferences.storyboardImageModelHint")} className="mb-0">
                                        <ModelPicker config={config} value={config.storyboardImageModel || config.imageModel} onChange={(model) => updateConfig("storyboardImageModel", model)} capability="image" fullWidth />
                                    </Form.Item>
                                    <Form.Item label={t("config.preferences.defaultAudioModel")} className="mb-0">
                                        <ModelPicker config={config} value={config.audioModel} onChange={(model) => updateConfig("audioModel", model)} capability="audio" fullWidth />
                                    </Form.Item>
                                </div>
                                <section className="mt-4 rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                    <div className="flex flex-wrap items-start justify-between gap-3">
                                        <div>
                                            <div className="text-sm font-semibold">故事板 API 响应检测</div>
                                            <div className="mt-1 text-xs text-stone-500">验证当前故事板大模型响应；APIMart 生图渠道只查询余额和鉴权，其他生图渠道仅检查配置，不提交计费任务。</div>
                                        </div>
                                        <Button size="small" icon={checkingStoryboardApi ? <Loader2 className="size-3.5 animate-spin" /> : <RefreshCw className="size-3.5" />} disabled={checkingStoryboardApi} onClick={() => void checkConnection(config)}>
                                            开始检测
                                        </Button>
                                    </div>
                                    <div className="mt-3 grid gap-2 md:grid-cols-2">
                                        <StoryboardApiStatus label="大模型" status={gptStatus} message={gptMessage} />
                                        <StoryboardApiStatus label="生图模型" status={imageStatus} message={imageMessage} />
                                    </div>
                                </section>
                            </Form>
                        ),
                    },
                    {
                        key: "webdav",
                        label: "WebDAV",
                        children: (
                            <Form layout="vertical" requiredMark={false}>
                                <section className="rounded-lg border border-stone-200 p-3 dark:border-stone-800">
                                    <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                                        <div>
                                            <div className="flex items-center gap-2 text-sm font-semibold">
                                                <Cloud className="size-4" />
                                                {t("config.webdav.title")}
                                            </div>
                                            <div className="mt-1 text-xs text-stone-500">{t("config.webdav.description")}</div>
                                        </div>
                                        <div className="text-xs text-stone-500">{webdav.lastSyncedAt ? t("config.webdav.lastSynced", { time: formatWebdavTime(webdav.lastSyncedAt, locale) }) : t("config.webdav.neverSynced")}</div>
                                    </div>
                                    <div className="grid gap-4 md:grid-cols-2">
                                        <Form.Item label={t("config.webdav.url")} className="mb-4">
                                            <Input value={webdav.url} placeholder="https://nas.example.com/webdav" onChange={(event) => updateWebdavConfig("url", event.target.value)} />
                                        </Form.Item>
                                        <Form.Item label={t("config.webdav.directory")} extra={t("config.webdav.directoryDescription", { manifest: WEBDAV_MANIFEST_FILE_NAME })} className="mb-4">
                                            <Input value={webdav.directory} placeholder="infinite-canvas" onChange={(event) => updateWebdavConfig("directory", event.target.value)} />
                                        </Form.Item>
                                        <Form.Item label={t("config.webdav.username")} className="mb-0">
                                            <Input value={webdav.username} autoComplete="username" onChange={(event) => updateWebdavConfig("username", event.target.value)} />
                                        </Form.Item>
                                        <Form.Item label={t("config.webdav.password")} className="mb-0">
                                            <Input.Password value={webdav.password} autoComplete="current-password" onChange={(event) => updateWebdavConfig("password", event.target.value)} />
                                        </Form.Item>
                                    </div>
                                    <div className="mt-4 flex flex-wrap items-center gap-2">
                                        <Button icon={<Wifi className="size-4" />} disabled={!webdavReady || syncingWebdav} loading={testingWebdav} onClick={() => void testWebdav()}>
                                            {t("config.webdav.test")}
                                        </Button>
                                        <Button type="primary" icon={<RefreshCw className="size-4" />} disabled={!webdavReady || testingWebdav} loading={syncingWebdav} onClick={() => void syncWebdav()}>
                                            {t(syncingWebdav ? "config.webdav.syncing" : "config.webdav.syncNow")}
                                        </Button>
                                        {webdavSyncStatus ? <span className="text-xs text-stone-500">{syncStageLabel(webdavSyncStatus, t)}</span> : null}
                                    </div>
                                    {syncingWebdav || webdavSyncStatus ? <WebdavProgressGrid progress={webdavDomainProgress} t={t} /> : null}
                                </section>
                            </Form>
                        ),
                    },
                    {
                        key: "local-storage",
                        label: t("config.tabs.localStorage"),
                        children: <ConfigLocalStorage active={activeTab === "local-storage"} />,
                    },
                ]}
            />
            {showDoneButton ? (
                <div className="mt-4 flex justify-end">
                    <Button type="primary" onClick={finishConfig}>
                        {t("common.done")}
                    </Button>
                </div>
            ) : null}
            <ChannelEditorDrawer open={Boolean(editingChannel)} channel={editingChannel} onSave={saveChannel} onClose={closeChannelEditor} />
        </>
    );
}

export function AppConfigModal() {
    const { t } = useTranslation();
    const isConfigOpen = useConfigStore((state) => state.isConfigOpen);
    const configTab = useConfigStore((state) => state.configTab);
    const setConfigDialogOpen = useConfigStore((state) => state.setConfigDialogOpen);
    return (
        <Modal
            title={
                <div className="flex flex-wrap items-baseline gap-x-8 gap-y-1 pr-8">
                    <div>
                        <div className="text-lg font-semibold">{t("config.title")}</div>
                        <div className="mt-1 text-xs font-normal text-stone-500">{t("config.modalDescription")}</div>
                    </div>
                    <div className="text-sm font-medium text-stone-500">可接入多个 API，并为每个模型指定用途</div>
                </div>
            }
            open={isConfigOpen}
            width={980}
            centered
            onCancel={() => setConfigDialogOpen(false)}
            styles={{ body: { maxHeight: "72vh", overflowY: "auto", paddingRight: 12 } }}
            footer={null}
        >
            <AppConfigPanel showDoneButton initialTab={configTab} />
        </Modal>
    );
}

function withChannels(config: AiConfig, channels: ModelChannel[]): AiConfig {
    const next: AiConfig = {
        ...config,
        channels,
        models: modelOptionsFromChannels(channels),
        baseUrl: channels[0]?.baseUrl || config.baseUrl,
        apiKey: channels[0]?.apiKey || config.apiKey,
        apiFormat: channels[0]?.apiFormat || config.apiFormat,
    };
    return {
        ...next,
        imageModel: pickDefaultModel(next, "image", config.imageModel),
        storyboardImageModel: pickDefaultModel(next, "image", config.storyboardImageModel || config.imageModel),
        videoModel: pickDefaultModel(next, "video", config.videoModel),
        textModel: pickDefaultModel(next, "text", config.textModel),
        audioModel: pickDefaultModel(next, "audio", config.audioModel),
    };
}

function channelCapabilities(channel: ModelChannel) {
    return Array.from(new Set(channel.models.map((model) => model.capability)));
}

function capabilityLabel(capability: ModelCapability) {
    if (capability === "video") return "视频";
    if (capability === "image") return "生图";
    if (capability === "audio") return "音频";
    return "大模型";
}

function pickDefaultModel(config: AiConfig, capability: ModelCapability, current: string) {
    const options = selectableModelsByCapability(config, capability);
    const normalized = normalizeModelOptionValue(current, config.channels);
    return options.includes(normalized) ? normalized : options[0] || "";
}

function apiFormatLabel(apiFormat: ApiCallFormat, t: TFunction) {
    if (apiFormat === "dola") return "DOLA";
    if (apiFormat === "autodl") return "AutoDL 工作流";
    if (apiFormat === "comfyui") return "ComfyUI";
    if (apiFormat === "gemini") return "Gemini";
    if (apiFormat === "ark") return t("config.protocols.ark");
    return "OpenAI";
}

function option(value: string) {
    return { value, label: value };
}

function secondsOption(value: string | number) {
    const text = String(value);
    if (text === VIDEO_DURATION_AUTO) return { value: VIDEO_DURATION_AUTO, label: "自动" };
    return { value: text, label: Number(value) === -1 ? "智能" : `${value}s` };
}

function StoryboardApiStatus({ label, status, message }: { label: string; status: ConnectionStatus; message: string }) {
    const tone = status === "connected" ? "text-green-600 dark:text-green-400" : status === "error" ? "text-red-600 dark:text-red-400" : status === "timeout" ? "text-amber-600 dark:text-amber-400" : status === "checking" ? "text-blue-600 dark:text-blue-400" : "text-stone-500";
    const icon = status === "checking" ? <Loader2 className="size-3.5 animate-spin" /> : status === "connected" ? <Check className="size-3.5" /> : <CircleOff className="size-3.5" />;
    return (
        <div className="rounded-lg bg-stone-100 px-3 py-2 dark:bg-stone-900">
            <div className="flex items-center gap-2 text-xs font-medium text-stone-700 dark:text-stone-200">{icon}{label}</div>
            <div className={`mt-1 text-xs ${tone}`}>{status === "checking" ? "检测中…" : message || "尚未检测"}</div>
        </div>
    );
}

function formatWebdavTime(value: string, locale: AppLocale) {
    return new Date(value).toLocaleString(locale, { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
}

function WebdavProgressGrid({ progress, t }: { progress: Record<AppSyncDomainKey, WebdavDomainProgress>; t: TFunction }) {
    return (
        <div className="mt-3 grid gap-2">
            {webdavDomainKeys.map((key) => {
                const item = progress[key];
                const count = item.total ? `${item.current || 0}/${item.total}` : "";
                return (
                    <div key={key} className="rounded-md border border-stone-200 px-3 py-2 dark:border-stone-800">
                        <div className="mb-1 flex min-w-0 items-center justify-between gap-3 text-xs">
                            <span className="shrink-0 font-medium text-stone-700 dark:text-stone-200">{t(`config.webdav.domains.${domainTranslationKey(key)}`)}</span>
                            <span className="min-w-0 truncate text-right text-stone-500">
                                {syncStageLabel(item.stage, t)}
                                {count ? ` · ${count}` : ""}
                            </span>
                        </div>
                        <Progress percent={getWebdavProgressPercent(item)} size="small" status={getWebdavProgressStatus(item)} showInfo={false} />
                    </div>
                );
            })}
        </div>
    );
}

function domainTranslationKey(domain: AppSyncDomainKey) {
    if (domain === "image-workbench") return "imageWorkbench";
    if (domain === "video-workbench") return "videoWorkbench";
    return domain;
}

function syncStageLabel(stage: string, t: TFunction) {
    if (stage === "等待本地数据加载") return t("config.webdav.stages.localWaiting");
    if (stage === "同步完成") return t("config.webdav.stages.syncComplete");
    if (stage === "等待同步") return t("config.webdav.stages.waiting");
    if (stage === "读取远端清单") return t("config.webdav.stages.remoteManifest");
    if (stage === "读取本地数据") return t("config.webdav.stages.localData");
    if (stage === "下载缺失媒体") return t("config.webdav.stages.downloadMedia");
    if (stage === "写入本地合并结果") return t("config.webdav.stages.writeMerge");
    if (stage === "上传新增媒体") return t("config.webdav.stages.uploadMedia");
    if (stage === "媒体已齐全") return t("config.webdav.stages.mediaReady");
    if (stage === "媒体无需上传") return t("config.webdav.stages.mediaSkipped");
    if (stage === "检查缺失媒体") return t("config.webdav.stages.checkMissingMedia");
    if (stage === "下载媒体") return t("config.webdav.stages.downloadMediaFile");
    if (stage === "检查本地媒体") return t("config.webdav.stages.checkLocalMedia");
    if (stage.startsWith("上传媒体 ")) return t("config.webdav.stages.uploadMediaFile", { size: stage.slice(5) });
    if (stage === "完成") return t("config.webdav.stages.complete");
    if (stage.startsWith("上传清单 ")) return t("config.webdav.stages.uploadManifest", { size: stage.slice(5) });
    return stage;
}

function getWebdavProgressPercent(item: WebdavDomainProgress) {
    if (item.status === "success") return 100;
    if (item.total) return Math.min(100, Math.round(((item.current || 0) / item.total) * 100));
    if (item.status === "exception") return 100;
    if (item.stage === "等待同步") return 0;
    if (item.stage === "读取远端清单") return 12;
    if (item.stage === "读取本地数据") return 24;
    if (item.stage === "下载缺失媒体") return 36;
    if (item.stage === "写入本地合并结果") return 58;
    if (item.stage === "上传新增媒体") return 66;
    if (item.stage === "媒体已齐全" || item.stage === "媒体无需上传") return 74;
    if (item.stage.startsWith("上传清单")) return 90;
    return item.status === "active" ? 30 : 0;
}

function getWebdavProgressStatus(item: WebdavDomainProgress): "normal" | "active" | "success" | "exception" {
    if (item.status === "success" || item.status === "exception") return item.status;
    return item.status === "active" ? "active" : "normal";
}

function formatBytes(bytes: number) {
    if (bytes < 1024) return `${bytes}B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

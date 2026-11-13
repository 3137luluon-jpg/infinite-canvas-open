import { Button, Drawer, Input, Popover, Select, Space } from "antd";
import { ExternalLink, ListPlus, RefreshCw, Trash2, TriangleAlert } from "lucide-react";
import type { TFunction } from "i18next";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { applyFeimiaoChannelDefaults, suggestFeimiaoAlias } from "@/lib/feimiao-video";
import type { FetchedChannelModel } from "@/services/api/image";
import { guessCapability, normalizeChannelModels, useConfigStore, type ApiCallFormat, type ChannelModel, type ModelCapability, type ModelChannel } from "@/stores/use-config-store";
import { ModelSelectModal } from "./model-select-modal";
import { AUTODL_BASE_URL, AUTODL_WORKFLOW_ID, AUTODL_WORKFLOW_NAME } from "@/lib/autodl-workflow";
import { DOLA_BASE_URL, DOLA_MODELS } from "@/lib/dola-video";
import { AGNES_IMAGE_MODEL, AGNES_VIDEO_MODEL, isAgnesConfig } from "@/lib/agnes";
import { fetchFmgoPricing, fmgoModelPrice, getFmgoPriceSnapshot, isFmgoPricingChannel, setFmgoPriceGroup, type FmgoPricing } from "@/services/api/fmgo-pricing";
import { isRunningHubConfig, RUNNINGHUB_VIDEO_ALIAS, RUNNINGHUB_VIDEO_MODEL } from "@/lib/runninghub";
import { checkRunningHubConnection } from "@/services/api/runninghub";
import { isRunningHubWorkflowConfig } from "@/lib/runninghub-workflow";
import { RunningHubWorkflowEditor } from "./runninghub-workflow-editor";

export function ChannelEditorDrawer({ open, channel, onSave, onClose }: { open: boolean; channel: ModelChannel | null; onSave: (channel: ModelChannel) => void; onClose: () => void }) {
    const { t } = useTranslation();
    const configuredChannels = useConfigStore(state => state.config.channels);
    const [draft, setDraft] = useState<ModelChannel | null>(channel);
    const [selectOpen, setSelectOpen] = useState(false);
    const [workflowOpen, setWorkflowOpen] = useState(false);
    const [workflowModel, setWorkflowModel] = useState<ChannelModel>();
    const [pricing, setPricing] = useState<FmgoPricing | null>(null);
    const [priceLoading, setPriceLoading] = useState(false);
    const [priceError, setPriceError] = useState("");
    const [priceGroup, setPriceGroup] = useState(() => getFmgoPriceSnapshot().group);
    const fmgoPricingEnabled = open && isFmgoPricingChannel(draft?.baseUrl || "") && Boolean(draft?.models.some(model => model.capability === "video"));
    const [priceRefresh, setPriceRefresh] = useState(0);
    const [connectionText, setConnectionText] = useState("");
    const [connectionBusy, setConnectionBusy] = useState(false);
    const connectionRequest = useRef<AbortController | null>(null);

    useEffect(() => {
        connectionRequest.current?.abort();
        setConnectionText("");
        setConnectionBusy(false);
        return () => { connectionRequest.current?.abort(); };
    }, [draft?.baseUrl, draft?.apiKey, open]);

    useEffect(() => {
        if (!fmgoPricingEnabled) { setPricing(null); setPriceError(""); setPriceLoading(false); return; }
        const controller = new AbortController();
        setPriceLoading(true);
        setPriceError("");
        void fetchFmgoPricing(controller.signal).then(data => {
            setPricing(data);
            setPriceGroup(current => Object.hasOwn(data.groupRatios || {}, current) ? current : "default");
        }).catch(error => {
            if (!controller.signal.aborted) setPriceError(error instanceof Error ? error.message : "刷新价格失败");
        }).finally(() => { if (!controller.signal.aborted) setPriceLoading(false); });
        return () => controller.abort();
    }, [fmgoPricingEnabled, priceRefresh]);

    const editingChannelId = open ? channel?.id || "" : "";
    useEffect(() => {
        if (!editingChannelId || !channel || channel.id !== editingChannelId) return;
        setDraft(channel);
    }, [editingChannelId]);

    if (!draft) return null;

    const patch = (value: Partial<ModelChannel>) => setDraft((current) => (current ? { ...current, ...value } : current));
    const setModels = (models: ChannelModel[]) => patch({ models });
    const agnesModels: ChannelModel[] = [{ name: AGNES_IMAGE_MODEL, alias: "Agnes Image 2.5 Flash", capability: "image" }, { name: AGNES_VIDEO_MODEL, alias: "Agnes Video 2.5 Flash", capability: "video" }];
    const runningHubModels: ChannelModel[] = [{ name: RUNNINGHUB_VIDEO_MODEL, alias: RUNNINGHUB_VIDEO_ALIAS, capability: "video" }];
    const runningHub = isRunningHubConfig(draft);
    const runningHubWorkflow = isRunningHubWorkflowConfig(draft);
    const checkConnection = async () => {
        connectionRequest.current?.abort();
        const controller = new AbortController();
        connectionRequest.current = controller;
        setConnectionBusy(true);
        setConnectionText("");
        try {
            const result = await checkRunningHubConnection(draft, controller.signal);
            if (!controller.signal.aborted) setConnectionText(`连接成功：账户鉴权和任务查询通过。Key 类型：${result.apiType}；余额 ${result.coins} RH 币 / ${result.money} ${result.currency}。视频生成权限与扣费以平台为准，本次未提交生成。`);
        } catch (error) {
            if (!controller.signal.aborted) setConnectionText(error instanceof Error ? error.message : "RunningHub 连接失败");
        } finally {
            if (!controller.signal.aborted) setConnectionBusy(false);
        }
    };

    const applySelection = (models: FetchedChannelModel[]) => {
        const map = new Map(draft.models.map((model) => [model.name, model]));
        setModels(
            models.map((model) => {
                const existing = map.get(model.name);
                if (existing) return existing;
                const alias = draft.feimiao ? suggestFeimiaoAlias(model.name) : "";
                return { name: model.name, capability: model.capability || guessCapability(model.name), ...(alias ? { alias } : {}) };
            }),
        );
    };

    const setAlias = (name: string, alias: string) => setModels(draft.models.map((model) => (model.name === name ? { ...model, alias } : model)));
    const setCapability = (name: string, capability: ModelCapability) => setModels(draft.models.map((model) => (model.name === name ? { ...model, capability } : model)));
    const removeModel = (name: string) => setModels(draft.models.filter((model) => model.name !== name));

    const save = () => {
        const trimmed = { ...draft, models: draft.models.map((model) => ({ ...model, alias: model.alias?.trim() || undefined })) };
        const next = draft.feimiao ? applyFeimiaoChannelDefaults({ ...trimmed, apiFormat: "openai", feimiao: true }) : { ...trimmed, feimiao: false };
        const models = normalizeChannelModels(next.models);
        onSave({ ...next, name: next.name.trim() || t("config.channels.unnamed"), models, feimiao: Boolean(next.feimiao) });
    };

    return (
        <Drawer
            open={open}
            width={720}
            title={
                <div className="flex items-center gap-2">
                    <span>{t("config.channelEditor.title")}</span>
                    {draft.feimiao ? <FeimiaoChannelWarning /> : null}
                    {draft.models.some((model) => model.capability === "text") ? <KinStoryboardLlmWarning /> : null}
                    <ChannelWebsite channel={draft} />
                </div>
            }
            onClose={onClose}
            styles={{ body: { paddingTop: 16 } }}
            extra={
                <Space>
                    <Button onClick={onClose}>{t("common.cancel")}</Button>
                    <Button type="primary" onClick={save}>
                        {t("common.save")}
                    </Button>
                </Space>
            }
        >
            {runningHub ? <div className="mb-4 space-y-2 text-xs text-stone-500">
                <div>已适配 Seedance 2.0 Global Token 多模态视频。个人账户请使用「企业级－共享 API Key」；本地素材自动上传，任务提交后保存编号并支持刷新续查。</div>
                <Button size="small" loading={connectionBusy} disabled={!draft.apiKey.trim()} onClick={() => void checkConnection()}>检测连接（不生成）</Button>
                <a className="ml-3" href="https://www.runninghub.ai/zh-cn/call-api/api-detail/2132764885651525684" target="_blank" rel="noopener noreferrer">官方接口说明</a>
                {!draft.models.some(model => model.name === RUNNINGHUB_VIDEO_MODEL) ? <Button size="small" className="ml-3" onClick={() => setModels([...draft.models, ...runningHubModels])}>添加已适配模型</Button> : null}
                {connectionText ? <div role="status">{connectionText}</div> : null}
            </div> : null}
            {isAgnesConfig(draft) ? <div className="mb-4 space-y-2 text-xs text-stone-500">
                <div>支持图片生成与参考图编辑；Flash 视频固定 720P、4–12 秒，参考图片和音频须为公网链接，暂不支持本地素材上传或蒙版编辑。当前优惠以平台账户为准。</div>
                <a href="https://platform.agnes-ai.com" target="_blank" rel="noopener noreferrer">打开 Agnes 平台获取 API Key</a>
                <Button size="small" className="ml-3" onClick={() => setModels([...draft.models, ...agnesModels.filter(model => !draft.models.some(existing => existing.name === model.name))])}>添加已适配模型</Button>
            </div> : null}
            <div className="grid gap-4 md:grid-cols-2">
                <label className="block min-w-0">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.name")}</span>
                    <Input value={draft.name} onChange={(event) => patch({ name: event.target.value })} />
                </label>
                <label className="block min-w-0">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.protocol")}</span>
                    <Select<ApiCallFormat>
                        className="w-full"
                        value={draft.apiFormat}
                        disabled={Boolean(draft.feimiao)}
                        options={[
                            { value: "openai", label: runningHub ? "RunningHub 标准模型 API" : "OpenAI 兼容" },
                            { value: "gemini", label: "Gemini" },
                            { value: "ark", label: t("config.protocols.ark") },
                            { value: "comfyui", label: "ComfyUI / RunningHub 工作流" },
                            { value: "autodl", label: "AutoDL 工作流" },
                            { value: "dola", label: "DOLA 本地视频" },
                        ]}
                        onChange={(apiFormat) => patch(apiFormat === "dola" ? { apiFormat, baseUrl: DOLA_BASE_URL, models: DOLA_MODELS.map(name => ({ name, capability: "video" })) } : apiFormat === "autodl" ? { apiFormat, baseUrl: AUTODL_BASE_URL, models: draft.models.length ? draft.models : [{ name: AUTODL_WORKFLOW_ID, alias: AUTODL_WORKFLOW_NAME, capability: "video" }] } : { apiFormat })}
                    />
                </label>
            </div>

            <div className="mt-4 grid gap-4 md:grid-cols-1">
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">{t("config.channelEditor.baseUrl")}</span>
                    <Input
                        value={draft.baseUrl}
                        onChange={(event) => patch({ baseUrl: event.target.value })}
                        placeholder="https://api.example.com"
                    />
                </label>
                <label className="block">
                    <span className="mb-1 block text-sm font-medium">API Key{!runningHubWorkflow && (draft.apiFormat === "comfyui" || draft.apiFormat === "dola") ? "（可选）" : ""}</span>
                    <Input.Password
                        value={draft.apiKey}
                        visibilityToggle={false}
                        autoComplete="new-password"
                        spellCheck={false}
                        onCopy={(event) => event.preventDefault()}
                        onCut={(event) => event.preventDefault()}
                        onDragStart={(event) => event.preventDefault()}
                        onChange={(event) => patch({ apiKey: event.target.value })}
                        placeholder={draft.apiFormat === "comfyui" || draft.apiFormat === "dola" ? "无鉴权时留空" : "sk-..."}
                    />
                </label>
            </div>

            {runningHubWorkflow ? <div className="mt-2 flex flex-wrap gap-2">
                {configuredChannels.filter(other => other.id !== draft.id && isRunningHubConfig({ baseUrl: other.baseUrl }) && new URL(other.baseUrl).origin === new URL(draft.baseUrl).origin && other.apiKey.trim()).map(other => <Button key={other.id} size="small" onClick={() => patch({ apiKey: other.apiKey })}>使用「{other.name}」已有 Key</Button>)}
            </div> : null}
            {draft.apiFormat === "autodl" ? <div className="mt-3 text-xs text-stone-500">令牌需在 AutoDL 令牌管理中选择 ComfyUI 分组。当前支持升级画质 H3：1–9 张图片、最多 3 段音频、1–15 秒。保存后在视频节点选择此工作流。</div> : null}
            <div className="mt-6 mb-3 flex flex-wrap items-center justify-between gap-2">
                <div>
                    <div className="text-sm font-semibold">{t("config.channelEditor.models")}</div>
                    <div className="mt-0.5 text-xs text-stone-500">{t("config.channelEditor.modelDescription", { count: draft.models.length })}</div>
                </div>
                <Button type="primary" icon={<ListPlus className="size-4" />} onClick={() => { if (runningHubWorkflow) { setWorkflowModel(undefined); setWorkflowOpen(true); } else setSelectOpen(true); }}>
                    {runningHubWorkflow ? "添加工作流" : t("config.channelEditor.selectModels")}
                </Button>
            </div>

            {fmgoPricingEnabled ? <div className="mb-3 space-y-1 text-xs text-stone-500">
                <div className="flex flex-wrap items-center gap-2">
                    <Button size="small" loading={priceLoading} icon={<RefreshCw className="size-3.5" />} onClick={() => setPriceRefresh(value => value + 1)}>刷新视频价格</Button>
                    {pricing ? <Select size="small" aria-label="价格分组" className="min-w-32" value={priceGroup} options={Object.keys(pricing.groupRatios || {}).map(value => ({ value, label: pricing.groups?.[value] || value }))} onChange={value => { setPriceGroup(value); setFmgoPriceGroup(value); }} /> : null}
                    <a href="https://www.fmgo.top/pricing" target="_blank" rel="noopener noreferrer">官网价格</a>
                </div>
                <div>{priceError || (pricing ? `公开报价 · ${new Date(pricing.fetchedAt).toLocaleString("zh-CN")} 更新；请选择与 API 账户一致的分组，实际扣费以平台为准。` : "正在读取视频模型公开报价…")}</div>
            </div> : null}

            <div className="space-y-2 rounded-lg border border-stone-200 p-2 dark:border-stone-800">
                {draft.models.length ? (
                    draft.models.map((model) => (
                        <div key={model.name} className="flex flex-col gap-2 rounded-md px-2 py-1.5 hover:bg-stone-50 dark:hover:bg-stone-900/40 sm:flex-row sm:items-center">
                            <div className="min-w-0 flex-1 space-y-1">
                                <div className="truncate text-sm" title={model.name}>
                                    {model.name}
                                </div>
                                {fmgoPricingEnabled && model.capability === "video" ? <div className="text-xs text-stone-500" title="FMGO 官网公开报价">{pricing ? `${fmgoModelPrice(pricing, model.name, priceGroup)}${priceError ? " · 上次报价（刷新失败）" : ""}` : priceError ? "价格暂不可用" : "价格读取中…"}</div> : null}
                                <Input
                                    size="small"
                                    className="max-w-xs"
                                    value={model.alias || ""}
                                    placeholder={t("config.channelEditor.aliasPlaceholder")}
                                    onChange={(event) => setAlias(model.name, event.target.value)}
                                    addonBefore={t("config.channelEditor.alias")}
                                />
                            </div>
                            <div className="flex shrink-0 flex-wrap items-center gap-2">
                                {runningHubWorkflow ? <Button size="small" onClick={() => { setWorkflowModel(model); setWorkflowOpen(true); }}>输入与结果</Button> : null}
                                <Select<ModelCapability>
                                    size="small"
                                    className="w-24"
                                    value={model.capability}
                                    options={capabilityOptions(t).filter(option => !runningHubWorkflow || option.value === "image" || option.value === "video")}
                                    disabled={runningHubWorkflow}
                                    onChange={(capability) => setCapability(model.name, capability)}
                                />
                                <Button size="small" danger type="text" icon={<Trash2 className="size-3.5" />} onClick={() => removeModel(model.name)} />
                            </div>
                        </div>
                    ))
                ) : (
                    <div className="px-2 py-8 text-center text-sm text-stone-500">{t("config.channelEditor.empty")}</div>
                )}
            </div>

            <ModelSelectModal open={selectOpen} channel={draft} selectedModels={draft.models} onConfirm={applySelection} onClose={() => setSelectOpen(false)} />
            {runningHubWorkflow ? <RunningHubWorkflowEditor open={workflowOpen} channel={draft} model={workflowModel} onSave={model => setModels([...draft.models.filter(existing => existing.name !== model.name && existing.name !== workflowModel?.name), model])} onClose={() => setWorkflowOpen(false)} /> : null}
        </Drawer>
    );
}

function capabilityOptions(t: TFunction) {
    return (["text", "image", "video", "audio"] as ModelCapability[]).map((value) => ({ value, label: t(`config.channelEditor.capabilities.${value}`) }));
}

function ChannelWebsite({ channel }: { channel: ModelChannel }) {
    const url = channel.baseUrl.toLowerCase();
    const website = url.includes("fmgo") ? { href: "https://www.fmgo.top/", label: "www.fmgo.top" } : url.includes("apimart") ? { href: "https://apimart.ai/zh", label: "apimart.ai/zh" } : url.includes("seetacloud") ? { href: channel.baseUrl, label: "SeetaCloud ComfyUI" } : null;
    if (!website) return null;

    return (
        <a
            href={website.href}
            target="_blank"
            rel="noopener noreferrer"
            className="ml-2 inline-flex items-center gap-1 text-sm font-normal text-blue-500 underline-offset-4 hover:text-blue-600 hover:underline dark:text-blue-400 dark:hover:text-blue-300"
        >
            {website.label}
            <ExternalLink className="size-3.5" />
        </a>
    );
}

function FeimiaoChannelWarning() {
    return (
        <Popover
            trigger="click"
            placement="bottomLeft"
            title="飞喵-like Seedance 视频渠道说明"
            content={
                <div className="w-80 space-y-2 text-sm leading-6">
                    <p>这类聚合平台把基础模型、分辨率和时长拆成多个独立的正式模型 ID，配置与普通 OpenAI 渠道不同。</p>
                    <p>
                        本项目读取渠道内的<strong>基础模型 ID</strong>，别名只负责界面显示；生成时会按模型白名单校验规格，并在需要时拼成完整 ID，例如
                        <code className="mx-1 rounded bg-black/5 px-1 py-0.5 text-xs dark:bg-white/10">feimiao-v2-431-fast-480p-15s</code>。
                    </p>
                    <p>不同模型还可能分别走 /videos 或 /chat/completions，提交字段与轮询方式也不完全相同。431 当前只开放 10/15 秒，其他型号可能支持 8/12 秒等不同组合。</p>
                    <p className="font-medium text-amber-600 dark:text-amber-400">请勿随意改基础模型 ID、协议或照搬其他型号的规格，否则可能请求失败、走错线路或产生计费异常；更换同类平台时建议让 Codex 同步检查映射。</p>
                </div>
            }
        >
            <button
                type="button"
                aria-label="查看飞喵-like 视频渠道配置说明"
                className="inline-flex size-7 items-center justify-center rounded-md text-amber-500 transition-colors hover:bg-amber-500/10 hover:text-amber-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 dark:text-amber-400 dark:hover:text-amber-300"
            >
                <TriangleAlert className="size-4" />
            </button>
        </Popover>
    );
}

function KinStoryboardLlmWarning() {
    return (
        <Popover
            trigger="click"
            placement="bottomLeft"
            title="大模型在 Ai视觉无限画布中的用途"
            content={
                <div className="w-96 space-y-2 text-sm leading-6">
                    <p>
                        这个渠道的核心职责不是聊天，而是作为<strong>KIN 故事板的视觉编译器</strong>。
                    </p>
                    <ol className="list-decimal space-y-1 pl-5">
                        <li>点击视频节点的“生成故事板”后，画布读取原封视频提示词，以及提示词中实际 @ 引用的图片；视频和音频不会作为多模态附件上传。</li>
                        <li>内部风格图和引用图片会压缩为最长边 700px 的请求副本，再与隔离植入的 KIN 故事板 Skill 一起交给当前选中的故事板大模型。</li>
                        <li>所选大模型理解人物、场景、空间关系、镜头节拍和宫格要求，只编译出内部故事板生图提示词，不直接生成图片，也不输出验收报告。</li>
                        <li>画布随后把编译结果和同一批压缩参考图交给当前选择的故事板生图模型，以视频宽高比、固定 1K 生成故事板；异步任务提交后由画布独立轮询，大模型不再参与。</li>
                    </ol>
                    <p className="font-medium text-amber-600 dark:text-amber-400">故事板大模型与生图模型可以来自不同 API 渠道：前者必须支持图片输入，后者必须标记为生图能力并兼容渠道协议；OpenAI类型生图当前按APIMart异步格式调用。两段请求分别使用各自接口和API Key。</p>
                    <p className="border-t border-black/10 pt-2 text-xs opacity-75 dark:border-white/10">
                        其他现存用途：画布文本节点生成与重试、图片“反推提示词”、偏好设置中的故事板 API 响应检测，以及已有配置节点或插件的文本生成能力。右侧通用 Agent/聊天入口已关闭，不使用本渠道。
                    </p>
                </div>
            }
        >
            <button
                type="button"
                aria-label="查看大模型与 KIN 故事板工作流程"
                className="inline-flex size-7 items-center justify-center rounded-md text-amber-500 transition-colors hover:bg-amber-500/10 hover:text-amber-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/50 dark:text-amber-400 dark:hover:text-amber-300"
            >
                <TriangleAlert className="size-4" />
            </button>
        </Popover>
    );
}

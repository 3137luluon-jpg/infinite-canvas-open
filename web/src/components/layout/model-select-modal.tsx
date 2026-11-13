import { Alert, App, Button, Checkbox, Input, Modal, Tabs } from "antd";
import { RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";

import { fetchChannelModels, type FetchedChannelModel } from "@/services/api/image";
import { isZealmanWorkflowProvider } from "@/services/api/zealman-comfyui";
import { channelHasRequiredCredentials, guessCapability, type ChannelModel, type ModelChannel } from "@/stores/use-config-store";

// Channel model selector: fetch upstream models or add them manually, then include checked models in the channel list.
export function ModelSelectModal({ open, channel, selectedModels, onConfirm, onClose }: { open: boolean; channel: ModelChannel | null; selectedModels: ChannelModel[]; onConfirm: (models: FetchedChannelModel[]) => void; onClose: () => void }) {
    const { message } = App.useApp();
    const { t } = useTranslation();
    const [existing, setExisting] = useState<FetchedChannelModel[]>([]);
    const [fetched, setFetched] = useState<FetchedChannelModel[]>([]);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [activeTab, setActiveTab] = useState("new");
    const [search, setSearch] = useState("");
    const [manual, setManual] = useState("");
    const [loading, setLoading] = useState(false);
    const [fetchError, setFetchError] = useState("");
    const autoFetchedRef = useRef("");

    useEffect(() => {
        if (!open) return;
        setExisting(selectedModels.map((model) => ({ name: model.name, capability: model.capability })));
        setFetched([]);
        setSelected(new Set(selectedModels.map((model) => model.name)));
        setActiveTab(selectedModels.length ? "existing" : "new");
        setSearch("");
        setManual("");
        setFetchError("");
        autoFetchedRef.current = "";
    }, [open, selectedModels]);

    const currentList = activeTab === "new" ? fetched : existing;
    const visibleList = useMemo(() => {
        const keyword = search.trim().toLowerCase();
        return keyword ? currentList.filter((model) => `${model.name} ${model.sourceKind || ""}`.toLowerCase().includes(keyword)) : currentList;
    }, [currentList, search]);
    const visibleSelectedCount = visibleList.filter((model) => selected.has(model.name)).length;
    const zealmanChannel = Boolean(channel?.apiFormat === "comfyui" && isZealmanWorkflowProvider(channel));

    const toggle = (name: string, checked: boolean) =>
        setSelected((current) => {
            const next = new Set(current);
            if (checked) next.add(name);
            else next.delete(name);
            return next;
        });

    const selectVisible = (checked: boolean) =>
        setSelected((current) => {
            const next = new Set(current);
            visibleList.forEach((model) => (checked ? next.add(model.name) : next.delete(model.name)));
            return next;
        });

    const addManual = () => {
        const name = manual.trim();
        if (!name) return;
        if (!fetched.some((model) => model.name === name) && !existing.some((model) => model.name === name)) {
            setFetched((current) => [{ name, capability: channel?.feimiao ? "video" : guessCapability(name) }, ...current]);
        }
        setSelected((current) => new Set(current).add(name));
        setManual("");
        setActiveTab("new");
    };

    const fetchModels = useCallback(async (targetChannel = channel, notify = true) => {
        if (!targetChannel) return;
        if (!targetChannel.baseUrl.trim() || !channelHasRequiredCredentials(targetChannel)) {
            message.error(t("config.modelSelect.missingConfig"));
            return;
        }
        setLoading(true);
        setFetchError("");
        try {
            const models = await fetchChannelModels(targetChannel);
            setFetched(models);
            if (models.length === 0) {
                setActiveTab("existing");
                const detail = t("config.modelSelect.fetchedNone", { count: existing.length });
                setFetchError(detail);
                if (notify) message.warning(detail);
                return;
            }
            setActiveTab("new");
            if (notify) message.success(t("config.modelSelect.fetched", { count: models.length }));
        } catch (error) {
            const detail = error instanceof Error ? error.message : t("config.modelSelect.fetchFailed");
            setFetchError(detail);
            if (notify) message.error(detail);
        } finally {
            setLoading(false);
        }
    }, [channel, existing.length, message, t]);

    useEffect(() => {
        if (!open || channel?.apiFormat !== "comfyui" || !channel.baseUrl.trim()) return;
        const key = `${channel.id}:${channel.baseUrl}:${channel.apiKey}`;
        if (autoFetchedRef.current === key) return;
        autoFetchedRef.current = key;
        void fetchModels(channel, false);
    }, [channel, fetchModels, open]);

    const confirm = () => {
        const pendingName = manual.trim();
        const pendingModel: FetchedChannelModel[] = pendingName ? [{ name: pendingName, capability: channel?.feimiao ? "video" : guessCapability(pendingName) }] : [];
        const selectedNames = pendingName ? new Set(selected).add(pendingName) : selected;
        const merged = [...existing, ...fetched, ...pendingModel];
        const ordered = merged.filter((model, index) => merged.findIndex((candidate) => candidate.name === model.name) === index).filter((model) => selectedNames.has(model.name));
        onConfirm(ordered);
        onClose();
    };

    return (
        <Modal
            open={open}
            width={880}
            centered
            onCancel={onClose}
            title={
                <span>
                    {t("config.modelSelect.title")} <span className="ml-2 text-xs font-normal text-stone-500">{t("config.modelSelect.selected", { selected: selected.size, total: new Set([...existing, ...fetched].map((model) => model.name)).size })}</span>
                </span>
            }
            styles={{ body: { maxHeight: "62vh", overflowY: "auto" } }}
            footer={[
                <Button key="cancel" onClick={onClose}>
                    {t("common.cancel")}
                </Button>,
                <Button key="confirm" type="primary" onClick={confirm}>
                    {t("config.modelSelect.confirm")}
                </Button>,
            ]}
        >
            <div className="flex flex-wrap items-center gap-3">
                <Input className="min-w-[200px] flex-1" value={search} onChange={(event) => setSearch(event.target.value)} placeholder={t("config.modelSelect.search")} prefix={<Search className="size-4 text-stone-400" />} allowClear />
                <Input className="min-w-[180px] flex-1" value={manual} onChange={(event) => setManual(event.target.value)} onPressEnter={addManual} placeholder={t("config.modelSelect.modelName")} />
                <Button onClick={addManual}>{t("config.modelSelect.add")}</Button>
                <Button icon={<RefreshCw className="size-4" />} loading={loading} onClick={() => void fetchModels()}>
                    {t("config.modelSelect.fetch")}
                </Button>
            </div>
            <div className="mt-2 text-xs text-stone-500">{t("config.modelSelect.description")}</div>
            {fetchError ? (
                <Alert
                    className="mt-3"
                    type="warning"
                    showIcon
                    message={zealmanChannel ? "云端 ComfyUI 当前不可用" : "模型列表读取失败"}
                    description={
                        zealmanChannel
                            ? `${fetchError}。已有选择会保留，云端开机后可点击“拉取模型列表”重试。`
                            : `${fetchError}。请检查接口地址、代理或隧道是否已启动；也可以在上方直接输入准确模型名称并点击“增加模型”。`
                    }
                />
            ) : null}

            <Tabs
                className="mt-3"
                activeKey={activeTab}
                onChange={setActiveTab}
                items={[
                    { key: "new", label: t("config.modelSelect.fetchedTab", { count: fetched.length }) },
                    { key: "existing", label: t("config.modelSelect.existingTab", { count: existing.length }) },
                ]}
            />

            <div className="mb-3 flex items-center justify-between gap-2">
                <span className="text-xs text-stone-500">{t("config.modelSelect.visibleSelected", { selected: visibleSelectedCount, total: visibleList.length })}</span>
                <div className="flex gap-2">
                    <Button size="small" disabled={!visibleList.length} onClick={() => selectVisible(true)}>
                        {t("config.modelSelect.selectVisible")}
                    </Button>
                    <Button size="small" disabled={!visibleSelectedCount} onClick={() => selectVisible(false)}>
                        {t("config.modelSelect.clearVisible")}
                    </Button>
                </div>
            </div>

            {visibleList.length ? (
                <div className="grid grid-cols-1 gap-x-8 gap-y-3 md:grid-cols-2">
                    {visibleList.map((model) => (
                        <Checkbox key={model.name} checked={selected.has(model.name)} onChange={(event) => toggle(model.name, event.target.checked)}>
                            <span className="inline-flex max-w-full items-center gap-2">
                                <span className="truncate" title={model.name}>{model.name}</span>
                                <span className="shrink-0 rounded bg-stone-100 px-1.5 py-0.5 text-[10px] text-stone-500 dark:bg-stone-800 dark:text-stone-400">{model.capability === "image" ? "生图" : model.capability === "video" ? "视频" : model.capability === "audio" ? "音频" : "文本"}</span>
                            </span>
                        </Checkbox>
                    ))}
                </div>
            ) : (
                <div className="py-8 text-center text-sm text-stone-500">{t(activeTab === "new" ? "config.modelSelect.fetchedEmpty" : "config.modelSelect.existingEmpty")}</div>
            )}
        </Modal>
    );
}

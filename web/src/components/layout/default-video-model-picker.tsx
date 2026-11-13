import { Select } from "antd";

import { modelOptionLabel, selectableModelsByCapability, useConfigStore, type AiConfig } from "@/stores/use-config-store";

export function DefaultVideoModelPicker({ config }: { config: AiConfig }) {
    return (
        <Select
            aria-label="默认视频模型"
            className="w-full"
            value={config.videoModel || undefined}
            placeholder="选择默认视频模型"
            options={selectableModelsByCapability(config, "video").map((model) => ({
                value: model,
                label: modelOptionLabel(config, model),
            }))}
            onChange={(videoModel) => useConfigStore.setState((state) => ({ config: { ...state.config, videoModel } }))}
        />
    );
}
